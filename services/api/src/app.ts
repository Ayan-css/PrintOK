import crypto from 'crypto';
import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { IStorageProvider, MemoryStorage } from './storage';
import { generateQrCodeDataUrl } from './qr';
import { AgentWebSocketServer } from './ws';
import { processDocument } from './documentProcessor';
import { RazorpayService, MIN_ORDER_AMOUNT_PAISE } from './razorpayService';
import { EmailService } from './email';
import { logOps } from './observability';
import { RazorpayRouteService, LINKED_ACCOUNT_BUSINESS_TYPES, toTransferSnapshot, TransferSnapshot } from './razorpayRoute';
import { parsePrintState } from './jobStateMachine';
import { classifyFailure } from './jobRecovery';
import { buildDefaultRateCard, calculateGridPriceBreakdown } from './pricing';
import { corsOptions } from './corsPolicy';
import {
  issueConfigDownloadToken,
  verifyConfigDownloadToken,
  CONFIG_DOWNLOAD_TTL_MS,
  CONFIG_DOWNLOAD_SCOPE,
} from './configDownloadToken';
import {
  PLAN_CATALOGUE, PLAN_TIERS, getPlan, platformFeeFor,
  compareAgentVersions, isValidSha256, isAllowedReleaseUrl,
  AGENT_RELEASE_HOSTS, AgentUpdateManifest, AgentUpdateMode,
  DEFAULT_PLAN_TIER, DEFAULT_PLATFORM_FEE_BPS,
  PAYMENT_GATEWAY_FEE_BPS, PAYMENT_GATEWAY_LABEL, calculateShopNetCents,
  wasPaidThroughGateway,
  Printer, PrintJob, Shop, ShopPortalConfig, CUSTOMER_NAME_MAX, CUSTOMER_PHONE_MAX,
  TERMS_VERSION,
  ShopRate, ShopRateCard,
  SERVICE_CATALOGUE, SERVICE_GROUPS, defaultEnabledServices, resolveEnabledServices,
  derivePortalOptions, checkJobAgainstPortal,
  parseOrientation, parsePageRange, billablePages,
  AUTO_PRINT_MODES, SEPARATOR_MODES, shouldPrintSeparator,
  bucketForState, countJobBuckets, jobMatchesSearch,
} from '@printok/shared-types';
import {
  hashPassword, verifyPassword, validatePasswordStrength,
  issueAdminToken, verifyAdminToken, canWrite, AdminTokenPayload, shouldRenewToken,
} from './adminAuth';
import {
  generatePairingCode, normalizePairingCode, hashDeviceToken, issueDeviceToken,
  PAIRING_CODE_TTL_MS, AgentIdentity,
} from './agentAuth';
import {
  RegisterShopDto,
  RegisterShopResponse,
  CreatePrintJobDto,
  CreatePrintJobResponse,
  AgentPollResponse,
  AgentUpdateStatusDto,
  PaymentWebhookDto,
  PrintState,
  PaymentState,
} from '@printok/shared-types';

/** Process start time, so /health shows how long this instance has been up. */
const BOOT_TIME = new Date().toISOString();

/**
 * Formats whose page count cannot be established from the file.
 *
 * Page breaks in a .docx or .xlsx depend on fonts, margins and the printer's
 * own paper size, so there is no count to read out of the bytes — every one of
 * these reported a hardcoded single page, and that is the figure a job is
 * priced from. A 500-page document was charged as one page while the agent
 * handed the whole thing to Word and printed all 500, leaving the shop to pay
 * for the other 499 sheets.
 *
 * They are refused rather than guessed at. A controlled headless converter
 * would let them be accepted properly, and is the right fix; until one exists,
 * refusing with the export-as-PDF advice is the truthful answer.
 */
const UNMEASURABLE_FORMATS = new Set(['word', 'excel', 'csv', 'unknown']);

/**
 * How long a password-reset link works.
 *
 * Short, because the link *is* the credential while it lives: anyone holding it
 * can take the account. Half an hour is long enough to find the email and long
 * enough to survive a slow inbox, and short enough that a forwarded or
 * intercepted message is usually already useless.
 */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

/**
 * How long a refund may sit pending before somebody should look at it.
 *
 * Razorpay refunds usually settle within a few working days, so this is not an
 * error — it is the point past which nobody should be assuming it will resolve
 * itself.
 */
const STUCK_REFUND_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * The largest upload each tier accepts, in bytes.
 *
 * Not in PLAN_CATALOGUE, which carries orders, printers and seats but no file
 * size. Kept beside the enforcement rather than invented into the catalogue,
 * because the catalogue's published figures are a commercial decision and these
 * are an operational one.
 */
const PLAN_MAX_UPLOAD_BYTES: Record<string, number> = {
  start: 10 * 1024 * 1024,
  smart: 25 * 1024 * 1024,
  business: 50 * 1024 * 1024,
  enterprise: 100 * 1024 * 1024,
};

/**
 * Whether a shop may take another order this month, and why not.
 *
 * The plan catalogue has carried a per-tier order cap since it was written and
 * nothing ever consulted it, so the ladder had no rung anybody had to climb: a
 * free-tier shop could run any volume on any number of printers. Enforcing it
 * is what makes a plan mean something.
 *
 * Answered as 402 rather than 403 — this is "your plan does not cover this",
 * which the dashboard can render as an upgrade prompt, not "you may not".
 */
async function checkOrderAllowance(
  storage: IStorageProvider,
  shopId: string
): Promise<{ allowed: true } | { allowed: false; error: string; usage: unknown }> {
  const plan = await storage.getShopPlan(shopId);
  const tier = plan?.planTier ?? DEFAULT_PLAN_TIER;
  const definition = getPlan(tier);
  if (!definition) return { allowed: true };

  const usage = await storage.countShopUsage(shopId);
  if (usage.ordersThisMonth < definition.maxOrdersPerMonth) return { allowed: true };

  return {
    allowed: false,
    error:
      `This shop has reached its ${definition.name} plan limit of ` +
      `${definition.maxOrdersPerMonth} orders this month. The shop owner can upgrade from ` +
      'the dashboard to keep taking orders.',
    usage: {
      tier,
      ordersThisMonth: usage.ordersThisMonth,
      maxOrdersPerMonth: definition.maxOrdersPerMonth,
    },
  };
}

/**
 * Whether a shop may add another printer or staff account.
 *
 * Separate from checkOrderAllowance because the failure mode is different. An
 * order cap is reached by trading and clears next month; a printer or seat cap
 * is reached by choice and clears only by upgrading or by removing something.
 *
 * **Downgrades never delete anything.** A shop that drops from Business to
 * Starter with five printers keeps all five: they are paired devices that
 * somebody is printing on, and silently unpairing them would stop a shop
 * trading without warning. What it cannot do is add a sixth. So the check is
 * on *adding*, never on *having*, and the message says which side of that line
 * the shop is on.
 *
 * NOTE on the 'printer' branch: nothing calls it yet, because no route adds a
 * printer to an existing shop — createPrinter runs only during registration,
 * for the shop's first one. It is implemented and tested so that the route
 * which eventually allows a second printer has a guard to call, rather than
 * shipping the cap and the bypass together. Wire it there when that route
 * exists.
 */
async function checkResourceAllowance(
  storage: IStorageProvider,
  shopId: string,
  resource: 'printer' | 'staff'
): Promise<{ allowed: true } | { allowed: false; error: string; usage: unknown }> {
  const plan = await storage.getShopPlan(shopId);
  const tier = plan?.planTier ?? DEFAULT_PLAN_TIER;
  const definition = getPlan(tier);
  if (!definition) return { allowed: true };

  const usage = await storage.countShopUsage(shopId);
  const [current, limit, noun] = resource === 'printer'
    ? [usage.printers, definition.maxPrinters, 'printer']
    : [usage.staff, definition.maxStaff, 'staff account'];

  if (current < limit) return { allowed: true };

  // Distinguish "you are full" from "you are already over", because the second
  // can only happen after a downgrade and needs a different instruction.
  const over = current > limit;

  return {
    allowed: false,
    error: over
      ? `This shop has ${current} ${noun}s but the ${definition.name} plan covers ${limit}. ` +
        `Nothing has been removed — remove ${current - limit + 1} to add another, or upgrade the plan.`
      : `The ${definition.name} plan covers ${limit} ${noun}${limit === 1 ? '' : 's'}, and this shop ` +
        `has ${current}. Upgrade from the dashboard to add another.`,
    usage: { tier, [resource === 'printer' ? 'printers' : 'staff']: current, limit },
  };
}

/**
 * Freezes what an order's money did, at the moment it is confirmed.
 *
 * Two things this fixes. The commission rate is recorded per order, so a shop
 * that upgrades mid-month does not have last week's orders restated at its new
 * rate. And the gateway fee is whatever Razorpay actually reported, when it
 * reported one — `payment.captured` carries `fee` and `tax` on the payment
 * entity — rather than the published 2% + GST estimate applied to everything.
 *
 * That distinction matters more than it looks: UPI person-to-merchant MDR is
 * zero by statute, and UPI is how most of these customers pay, so the estimate
 * is very likely charging shops for a fee Razorpay never took.
 *
 * Deliberately best-effort. A ledger write that failed must not undo a
 * confirmed payment, so it is logged and the payment stands.
 */
async function freezeFeeLedger(
  storage: IStorageProvider,
  job: PrintJob,
  commissionBps: number,
  gateway?: { feeCents?: number; taxCents?: number }
): Promise<void> {
  try {
    const gross = job.totalPriceInCents || 0;

    const reportedFee = Number(gateway?.feeCents);
    const reportedTax = Number(gateway?.taxCents);
    const actual = Number.isFinite(reportedFee) && reportedFee >= 0;

    // Razorpay reports `fee` inclusive of `tax`, so the fee proper is the
    // difference. Getting that backwards would double-count the GST.
    const tax = actual && Number.isFinite(reportedTax) && reportedTax >= 0 ? reportedTax : 0;
    const fee = actual ? Math.max(0, reportedFee - tax) : 0;

    await storage.recordFeeLedger(job.id, {
      grossCents: gross,
      gatewayFeeCents: actual
        ? fee
        : Math.round((gross * PAYMENT_GATEWAY_FEE_BPS) / 10_000),
      gatewayTaxCents: actual ? tax : 0,
      commissionBpsUsed: commissionBps,
      feesAreActual: actual,
    });
  } catch (err: any) {
    // A confirmed payment must not be undone by a bookkeeping failure.
    console.error(`[Ledger] Could not record fees for job ${job.id}:`, err?.message || err);
  }
}

/**
 * The client-supplied key that makes a retry safe.
 *
 * `createPrintJob` has always looked one up and returned the original job
 * rather than creating a second — but nothing ever passed it one from the
 * customer route, so the feature was inert and a double-tapped Pay button
 * produced two jobs and two charges.
 *
 * Read from a header rather than the body: the body carries the document, and
 * a retry has to be recognisable without re-reading megabytes of base64 to
 * find the key inside it.
 *
 * Bounded and shape-checked. It reaches a unique index, so an unbounded string
 * is an unbounded index entry, and a key is only ever something the client
 * generated for itself.
 */
function readIdempotencyKey(req: Request): string | undefined {
  const raw = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) return undefined;

  const trimmed = String(key).trim();
  if (trimmed.length < 8 || trimmed.length > 128) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;

  return trimmed;
}

/**
 * Whether an inbound confirmation may move this job to Paid, and why not.
 *
 * `RefundPending -> Paid` is a legal transition and deliberately so: the state
 * machine's own comment is "refund rejected by the provider; the payment
 * stands". That is an internal reconciliation, not something a customer's
 * browser or a replayed webhook gets to assert.
 *
 * The distinction matters because the checkout signature is an HMAC over two
 * static ids with no nonce or timestamp, so it never expires. A retained
 * confirmation replayed after a refund used to walk the job back to Paid, and
 * it re-entered the shop's revenue and payout figures — no reprint and no
 * double charge, since the print side stays terminally Cancelled, but the books
 * were wrong.
 *
 * Returns a message when the confirmation must be refused, undefined when it
 * may proceed.
 */
/**
 * What a customer may see of their own job.
 *
 * The job row used to be returned whole to anyone holding a job id, on an
 * endpoint with no authentication — so the id doubled as an unrevocable bearer
 * credential for `customerName`, `customerPhone`, `fileChecksum` and `fileUrl`,
 * which was either a live presigned download or, on the local-disk fallback,
 * the entire document inlined as base64. It survives in browser history,
 * referrer headers and any forwarded status link.
 *
 * It also carried `priceSnapshot`, and that embeds `rateCardSnapshot` — the
 * shop's whole rate grid, which is the shop's business and not the customer's.
 *
 * So this is an allowlist, not a redaction: a field reaches a customer only by
 * being named here. What remains is what the status screen actually renders,
 * plus the configuration the customer chose themselves.
 */
/**
 * The shop as a customer may see it: the name it trades under and its town.
 *
 * This is the payee and the provider of the printing, so the customer is shown
 * who it is. Deliberately not the street address, phone or GSTIN: those were
 * given for Razorpay's KYC, and for a proprietorship the registered address is
 * often the owner's home. Nothing here comes from the request — only from the
 * shop row the printer belongs to.
 */
function publicShopView(shop: Shop | undefined) {
  if (!shop) return undefined;
  return {
    name: shop.name,
    city: shop.addressCity || undefined,
    state: shop.addressState || undefined,
  };
}

const TERMS_REQUIRED_ERROR =
  'You must accept the PrintOk Terms & Conditions and policies to create a shop account.';

/** Largest number of copies one order may ask for; the quote endpoint's cap too. */
const MAX_COPIES = 999;

/**
 * Copies, as a whole number from 1 to MAX_COPIES, or why not.
 *
 * Absent means one copy, which is what every older page sent. Anything else
 * must be a whole number: pricing used Math.max(1, copies), so 0.5, -3, NaN or
 * "2abc" were silently priced as something and stored as something else.
 */
function parseCopies(raw: unknown): { value: number } | { error: string } {
  if (raw === undefined || raw === null) return { value: 1 };
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    n = Number(raw.trim());
  } else {
    return { error: 'copies must be a whole number.' };
  }
  if (!Number.isInteger(n)) return { error: 'copies must be a whole number.' };
  if (n < 1) return { error: 'copies must be at least 1.' };
  if (n > MAX_COPIES) return { error: `copies cannot be more than ${MAX_COPIES}.` };
  return { value: n };
}

function customerJobView(job: PrintJob, shop?: Shop) {
  return {
    id: job.id,
    orderId: job.orderId,
    /** Who the order is from and who prints it. */
    shop: publicShopView(shop),
    printerId: job.printerId,
    tokenNumber: job.tokenNumber,

    printState: job.printState,
    paymentState: job.paymentState,

    fileName: job.fileName,
    pageCount: job.pageCount,
    copies: job.copies,
    isColor: job.isColor,
    isDuplex: job.isDuplex,
    paperSize: job.paperSize,
    orientation: job.orientation,
    pageRange: job.pageRange,
    printConfig: job.printConfig,

    totalPriceInCents: job.totalPriceInCents,
    /** The customer's own Razorpay payment id, for their records and support. */
    paymentReference: job.razorpayPaymentId,

    errorMessage: job.errorMessage,
    declineReason: job.declineReason,
    refundAmountCents: job.refundAmountCents,
    refundedAt: job.refundedAt,

    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    printedAt: job.printedAt,
    completedAt: job.completedAt,
  };
}

/**
 * What a shop banked across a set of paid orders, order by order.
 *
 * Shared by the earnings screen and the payout summary because they are two
 * views of one number and had been computing it two ways: earnings per job, the
 * payout summary from a single aggregate. An aggregate cannot tell a cash order
 * from an online one, so it deducted a gateway fee from both.
 *
 * The gateway fee is per order and conditional. A counter-cash sale never
 * touched Razorpay, so nothing is deducted for it.
 */
function summariseShopEarnings(jobs: PrintJob[], commissionBps: number) {
  const rows = jobs.map((job) => {
    const gross = job.grossCents ?? job.totalPriceInCents ?? 0;
    const paidOnline = wasPaidThroughGateway(job);

    // The rate this order was actually charged at, not the shop's rate today.
    // Recomputing from the current rate is how a shop that upgraded mid-month
    // found last week's orders restated.
    const rateUsed = job.commissionBpsUsed ?? commissionBps;

    // A recorded ledger is used as recorded. Only an order taken before the
    // ledger existed — or one still awaiting its webhook — is derived, and the
    // response says which by way of feesAreEstimated.
    const hasLedger = job.gatewayFeeCents !== undefined && job.commissionBpsUsed !== undefined;

    const derived = calculateShopNetCents(gross, rateUsed, { gatewayFeeApplies: paidOnline });

    const gatewayFeeCents = hasLedger
      ? (job.gatewayFeeCents ?? 0) + (job.gatewayTaxCents ?? 0)
      : derived.gatewayFeeCents;
    const serviceFeeCents = derived.serviceFeeCents;
    const netCents = Math.max(0, gross - gatewayFeeCents - serviceFeeCents);

    return {
      jobId: job.id,
      orderId: job.orderId,
      tokenNumber: job.tokenNumber ?? null,
      createdAt: job.createdAt,
      fileName: job.fileName,
      customerName: job.customerName ?? null,
      paymentRef: job.paymentRef ?? null,
      /** How the money arrived, so the row can explain its own deductions. */
      paymentMethod: paidOnline ? ('online' as const) : ('cash' as const),
      /** The rate this order was charged at, which may not be the shop's rate now. */
      commissionBps: rateUsed,
      /** Whether the gateway figures came from Razorpay or from the published rate. */
      feesAreActual: hasLedger ? (job.feesAreActual ?? false) : false,
      printState: job.printState,
      grossCents: gross,
      // What the shop actually banked on this order, and what each deduction
      // was for. A single "net" number invites the question this answers.
      razorpayFeeCents: gatewayFeeCents,
      platformCommissionCents: serviceFeeCents,
      netCents,
    };
  });

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + pick(r), 0);

  return {
    rows,
    totals: {
      orders: rows.length,
      grossCents: sum((r) => r.grossCents),
      razorpayFeeCents: sum((r) => r.razorpayFeeCents),
      platformCommissionCents: sum((r) => r.platformCommissionCents),
      netCents: sum((r) => r.netCents),
      cashOrders: rows.filter((r) => r.paymentMethod === 'cash').length,
      onlineOrders: rows.filter((r) => r.paymentMethod === 'online').length,
      // What PrintOk transfers to the shop. Online money passed through
      // PrintOk, so the shop is owed its net; cash never did, so the shop
      // already holds it and PrintOk's fee on it comes out of the transfer.
      // Negative means the shop owes PrintOk.
      cashFeesCents: sum((r) => (r.paymentMethod === 'cash' ? r.platformCommissionCents : 0)),
      settlementCents:
        sum((r) => (r.paymentMethod === 'online' ? r.netCents : 0)) -
        sum((r) => (r.paymentMethod === 'cash' ? r.platformCommissionCents : 0)),
      /** How many rows carry figures Razorpay reported rather than estimates. */
      ordersWithActualFees: rows.filter((r) => r.feesAreActual).length,
    },
  };
}

/**
 * How this shop gets paid, why, and what it can do about it.
 *
 * Automatic settlement needs two things: Razorpay Route switched on for the
 * PrintOk account (`routeEnabled`), and Razorpay having activated this shop's
 * own linked account. Only when both hold is anything described as automatic —
 * an activated account on a platform where Route is still off is paid out by
 * hand like every other shop, and is told so.
 *
 * `razorpayAccountStatus` is Razorpay's own status, verbatim: the Route
 * product's activation_status once onboarding has requested it.
 */
function describeSettlement(shop: {
  razorpayAccountId?: string;
  razorpayAccountStatus?: string;
  razorpayAccountError?: string;
  razorpayAccountRequirements?: unknown;
  upiId?: string;
  bankAccountNumber?: string;
}, routeEnabled: boolean) {
  const status = shop.razorpayAccountStatus || 'not_linked';
  const hasDestination = Boolean(shop.upiId || shop.bankAccountNumber);
  const lastError = shop.razorpayAccountError ? { lastError: shop.razorpayAccountError } : {};
  const requirements = Array.isArray(shop.razorpayAccountRequirements) && shop.razorpayAccountRequirements.length
    ? { requirements: shop.razorpayAccountRequirements } : {};

  if (status === 'activated' && routeEnabled) {
    return {
      mode: 'automatic' as const,
      status,
      headline: 'Each paid order is transferred to your own Razorpay account.',
      detail:
        'When a customer pays online, your share — the order total less the PrintOk platform fee and ' +
        'the payment gateway charge — is transferred to your linked Razorpay account and held until ' +
        'the job prints. It is then released and Razorpay settles it to your bank on its usual cycle. ' +
        'If the order is refunded instead, the transfer is reversed.',
      action: null,
    };
  }

  if (status === 'activated') {
    return {
      mode: 'manual' as const,
      status,
      headline: 'Your Razorpay account is verified. Automatic settlement is not switched on yet.',
      detail:
        'PrintOk has not yet switched on Razorpay Route, which automatic settlement needs. Until it ' +
        'does, online payments are received by PrintOk and paid out to you separately — every paid ' +
        'order is recorded and owed to you.',
      action: null,
    };
  }

  if (status === 'suspended' || status === 'rejected') {
    return {
      mode: 'manual' as const,
      status,
      headline: status === 'rejected'
        ? 'Razorpay did not approve your linked account.'
        : 'Razorpay has suspended your linked account.',
      detail: 'Online payments are received by PrintOk and owed to you; they are paid out separately meanwhile.',
      action: 'Contact Razorpay support about your linked account, then tell us once it is active.',
      ...lastError,
    };
  }

  if (status !== 'not_linked') {
    // created, requested, under_review, needs_clarification, legacy needs_kyc,
    // or any status Razorpay adds later.
    const needsAction = status === 'needs_clarification' || status === 'needs_kyc' || 'requirements' in requirements;
    return {
      mode: 'manual' as const,
      status,
      headline: needsAction
        ? 'Razorpay needs more information before it can activate your account.'
        : 'Razorpay is reviewing your linked account.',
      detail:
        'Razorpay verifies every account that receives money before anything can be transferred to ' +
        'it. Until then, online payments are received by PrintOk and paid out to you separately.',
      action: needsAction ? 'Provide what Razorpay has asked for (listed below, or in its email).' : null,
      ...requirements,
      ...lastError,
    };
  }

  return {
    mode: 'manual' as const,
    status,
    headline: 'Your online orders are collected by PrintOk and paid out to you.',
    detail:
      'Online payments are received into PrintOk\'s Razorpay account and paid out to you separately. ' +
      'Every paid order is recorded and owed to you. Automatic settlement to an account in your own ' +
      'name needs Razorpay Route, which PrintOk is still setting up.',
    action: hasDestination
      ? null
      : 'Add a UPI ID or bank account below so we know where to send your money.',
  };
}

function refusePaymentConfirmation(state: PaymentState): string | undefined {
  switch (state) {
    case PaymentState.RefundPending:
      return 'This order is being refunded, so a payment confirmation cannot be applied to it.';
    case PaymentState.Refunded:
    case PaymentState.PartiallyRefunded:
      return 'This order has already been refunded.';
    case PaymentState.Cancelled:
      return 'This order was cancelled.';
    default:
      return undefined;
  }
}

/**
 * Resolves the calling agent (PRD 7.2).
 *
 * Prefers a device-scoped token, which identifies one machine and can be
 * revoked on its own. Falls back to the printer's shared API key so that agents
 * installed before pairing existed keep working; each such call is recorded as
 * a security event so the migration is observable.
 *
 * Responds and returns null on failure, so callers can `if (!identity) return;`.
 */
async function authenticateAgent(
  storage: IStorageProvider,
  req: Request,
  res: Response
): Promise<AgentIdentity | null> {
  const deviceToken = req.headers['x-agent-device-token'] as string | undefined;

  if (deviceToken) {
    const device = await storage.getActiveDeviceByTokenHash(hashDeviceToken(deviceToken));
    if (!device) {
      await storage.recordSecurityEvent({
        type: 'AUTH_REJECTED',
        severity: 'warning',
        detail: { reason: 'Unknown, expired or revoked device token.' },
      });
      res.status(401).json({ error: 'Unauthorized: device token is not valid. Re-pair this agent.' });
      return null;
    }

    const printer = await storage.getPrinter(device.printerId);
    if (!printer) {
      res.status(401).json({ error: 'Unauthorized: device is not bound to a live printer.' });
      return null;
    }

    await storage.touchAgentDevice(device.id, req.headers['x-agent-version'] as string | undefined);
    return { printerId: printer.id, shopId: printer.shopId, deviceId: device.id, method: 'device-token' };
  }

  const apiKey = req.headers['x-agent-api-key'] as string | undefined;
  if (!apiKey) {
    res.status(401).json({ error: 'Unauthorized: missing x-agent-device-token or x-agent-api-key header.' });
    return null;
  }

  const printer = await storage.getPrinterByApiKey(apiKey);
  if (!printer) {
    await storage.recordSecurityEvent({
      type: 'AUTH_REJECTED',
      severity: 'warning',
      detail: { reason: 'Invalid printer API key.' },
    });
    res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
    return null;
  }

  // Shared-key auth is deprecated: it cannot identify or revoke one machine.
  await storage.recordSecurityEvent({
    printerId: printer.id,
    type: 'LEGACY_KEY_USED',
    severity: 'info',
    detail: { path: req.path },
  });

  return { printerId: printer.id, shopId: printer.shopId, method: 'legacy-printer-key' };
}

export function createApp(
  storage: IStorageProvider = new MemoryStorage(),
  wsServer?: AgentWebSocketServer
) {
  const app = express();
  const razorpayService = new RazorpayService();
  const emailService = new EmailService();
  const routeService = new RazorpayRouteService();

  // An allowlist, not a wildcard. Requests with no Origin (the print agent,
  // Razorpay webhooks, health checks) are unaffected — see corsPolicy.ts.
  app.use(cors(corsOptions()));
  app.use(express.json({
    limit: '50mb',
    // Webhook signatures are computed over the exact bytes received; a
    // re-serialised object produces different bytes and never verifies.
    verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); },
  }));

  // Render terminates TLS at its own proxy and forwards the caller's address in
  // X-Forwarded-For. Without this Express reports the proxy's address as req.ip,
  // so every visitor shares one rate-limit bucket: 60 print jobs a minute for
  // the whole platform, and five contact enquiries an hour for the entire
  // internet. express-rate-limit detects the mismatch and logs
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, which is what production was doing.
  //
  // Exactly one hop, never `true`: trusting the whole chain lets a caller add
  // their own X-Forwarded-For and present a fresh address on every request,
  // which would leave the limiter trivially bypassable.
  app.set('trust proxy', 1);

  // Security: Public API Rate Limiter (Max 60 requests per minute per IP)
  //
  // The ceiling is configurable because the test suite drives hundreds of job
  // creations from one address in seconds and would otherwise start failing on
  // request count rather than on behaviour — which surfaces as an unrelated
  // test breaking, several steps away from whatever added the requests.
  //
  // It is a ceiling, never a switch: an unset or unparseable value keeps the
  // production default rather than disabling the limiter.
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number.parseInt(process.env.API_RATE_LIMIT_PER_MINUTE || '', 10) || 60,
    message: { error: 'Too many requests from this IP, please try again after a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  /**
   * A tighter limit for the routes that guess-or-guess-not.
   *
   * Signup and the two logins were behind no limiter at all, and signup does
   * *more* work than the registration route sitting next to it: it hashes a
   * password with scrypt at N=16384, which blocks the single Node event loop
   * for a measurable time. Sustained unauthenticated signups therefore stalled
   * the whole API and flooded the shop table at the same time.
   *
   * Five a minute per IP is generous for a human signing in and useless for
   * guessing. Counted per IP and per route, so somebody else's failed logins
   * cannot lock a shop out of its own dashboard.
   */
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number.parseInt(process.env.AUTH_RATE_LIMIT_PER_MINUTE || '', 10) || 5,
    message: {
      error: 'Too many attempts from this address. Wait a minute and try again.',
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Successful sign-ins do not count toward the limit: a shop legitimately
    // signing in on several devices is not an attack, and only the failures
    // are worth throttling.
    skipSuccessfulRequests: true,
  });

  app.use('/api/print-jobs', apiLimiter);
  app.use('/api/shops/register', apiLimiter);

  // Unauthenticated, and each one does real work: two database reads for a
  // quote, a scrypt hash for a signup.
  app.use('/api/merchant/signup', apiLimiter);
  app.use('/api/shops/:shopId/quote', apiLimiter);

  // Credential guessing, and the expensive hash that comes with it.
  app.use('/api/merchant/login', authLimiter);
  app.use('/api/admin/login', authLimiter);
  app.use('/api/merchant/claim', authLimiter);
  app.use('/api/admin/bootstrap', authLimiter);
  // Pairing consumes a short human-transcribable code; unthrottled it is the
  // one credential in the system worth guessing at volume.
  app.use('/api/agent/pair', authLimiter);

  // The contact form is unauthenticated and world-reachable, so it gets a much
  // tighter budget than the rest of the public API.
  const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many enquiries from this network. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/contact', contactLimiter);

  // Health Check Endpoint.
  // Reports the running build so a deploy can actually be verified from outside;
  // a static 200 cannot distinguish a new release from the previous one.
  app.get('/health', (req: Request, res: Response) => {
    // Readiness, not just liveness. /health answered 'ok' while the API was
    // running on in-memory storage with every shop, job and payment living
    // until the next restart — a missing environment variable looked exactly
    // like a healthy deploy. Boot now refuses that in production, and this
    // says which backend is actually in use so the two cannot disagree.
    const durable = Boolean(process.env.DATABASE_URL);

    res.json({
      status: durable ? 'ok' : 'degraded',
      storage: durable ? 'postgres' : 'memory',
      // Not a failure: mail is optional to run, and not optional to recover an
      // account. Named so an operator sees it before a shop owner does.
      email: { canSend: emailService.canSend, provider: emailService.providerName },
      service: 'PrintOk API',
      version: process.env.npm_package_version || 'unknown',
      // Render exposes the deployed commit; other hosts may not.
      commit: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown').slice(0, 7),
      startedAt: BOOT_TIME,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * Resolves the signed-in merchant and confirms they may act on :shopId.
   *
   * Every shop endpoint was previously unauthenticated, so anyone who knew a
   * shop id could read its revenue and payout details, change its prices or
   * trigger a withdrawal. This is the gate that closes that.
   *
   * Responds and returns null on failure, so callers can `if (!m) return;`.
   */
  async function authenticateMerchant(
    req: Request,
    res: Response,
    options: { shopId?: string; requireOwner?: boolean } = {}
  ): Promise<AdminTokenPayload | null> {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      res.status(401).json({ error: 'Sign in to your shop dashboard.' });
      return null;
    }

    const payload = verifyAdminToken(token, 'merchant');
    if (!payload) {
      res.status(401).json({ error: 'Session expired or invalid. Sign in again.' });
      return null;
    }

    const user = await storage.getMerchantUser(payload.sub);
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'This account is no longer active.' });
      return null;
    }

    // A valid token for one shop must never act on another.
    const target = options.shopId ?? req.params.shopId;
    if (target && user.shopId !== target) {
      res.status(403).json({ error: 'This account does not have access to that shop.' });
      return null;
    }

    if (options.requireOwner && user.role !== 'owner') {
      res.status(403).json({ error: 'Only the shop owner can do that.' });
      return null;
    }

    // A session in continuous use renews itself, so a twelve-hour token does
    // not mean a shop owner signing in every morning. Offered as a response
    // header rather than a body field, because every authenticated route would
    // otherwise have to remember to include it; the client stores it when it
    // sees it and is unaffected when it does not.
    if (shouldRenewToken(payload)) {
      res.setHeader(
        'x-printok-session-renewed',
        issueAdminToken(
          { id: user.id, email: user.email, role: user.role, shopId: user.shopId },
          undefined,
          'merchant'
        )
      );
      // So a browser on another origin can actually read it.
      res.setHeader('access-control-expose-headers', 'x-printok-session-renewed');
    }

    return { ...payload, shopId: user.shopId };
  }

  /**
   * Authorises a merchant to act on one specific printer.
   *
   * Printer ids are public by design — they are encoded in the QR poster and
   * appear in the customer URL as ?printer=<id> — so every printer-scoped
   * management route needs an ownership check, not merely a signed-in caller.
   * Without this, knowing an id was authority over it: anyone could mint a
   * pairing code for a shop they had never visited, revoke its agent, or
   * regenerate the QR on its printed poster.
   *
   * A printer belonging to another shop answers 404, not 403, so this cannot be
   * used to confirm that a guessed printer id exists.
   *
   * Responds and returns null on failure, so callers can `if (!ctx) return;`.
   */
  async function authorizePrinter(
    req: Request,
    res: Response,
    options: { requireOwner?: boolean } = {}
  ): Promise<{ merchant: AdminTokenPayload; printer: Printer } | null> {
    const merchant = await authenticateMerchant(req, res, {
      shopId: undefined,
      requireOwner: options.requireOwner,
    });
    if (!merchant) return null;

    const printer = await storage.getPrinter(req.params.printerId);
    if (!printer || printer.shopId !== merchant.shopId) {
      res.status(404).json({ error: 'Printer not found.' });
      return null;
    }

    return { merchant, printer };
  }

  /**
   * Decides what customer identity, if any, is stored with a job.
   *
   * The shop's configuration is the authority, never the request. A caller who
   * posts a name to a shop that does not collect names gets it dropped rather
   * than stored: that shop's customers were told nothing of the sort is kept,
   * and an API that quietly honours the field would make the notice false.
   *
   * Returns the values to store, or the message to refuse with.
   */
  function readCustomerIdentity(
    portal: ShopPortalConfig,
    submitted: { customerName?: unknown; customerPhone?: unknown }
  ): { value: { customerName?: string; customerPhone?: string } } | { error: string } {
    const clean = (raw: unknown, max: number): string | undefined => {
      if (raw === undefined || raw === null) return undefined;
      // Collapse runs of whitespace so a name pasted across two lines stores flat.
      const text = String(raw).replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, max) : undefined;
    };

    const name = portal.collectCustomerName ? clean(submitted.customerName, CUSTOMER_NAME_MAX) : undefined;
    const phone = portal.collectCustomerPhone ? clean(submitted.customerPhone, CUSTOMER_PHONE_MAX) : undefined;

    if (portal.collectCustomerName && portal.customerNameRequired && !name) {
      return { error: 'This shop needs your name for the order.' };
    }
    if (portal.collectCustomerPhone && portal.customerPhoneRequired && !phone) {
      return { error: 'This shop needs your mobile number for the order.' };
    }

    // Deliberately permissive: enough to reject an obvious mistake, not enough
    // to argue with a customer about the shape of their own phone number.
    if (phone && !/^[0-9+][0-9 ()+-]{5,}$/.test(phone)) {
      return { error: 'That mobile number does not look right.' };
    }

    return { value: { customerName: name, customerPhone: phone } };
  }

  /**
   * Merchant signup: creates the shop, its first printer and the owner account
   * in one step, so a shop is never left without anyone able to sign in to it.
   */
  /**
   * Contact and registered address from a signup body.
   *
   * Razorpay refuses to create a Route linked account without a phone number
   * and stalls KYC on an incomplete address, so these are collected up front
   * rather than chased later when a shop is trying to get paid.
   */
  function readShopContact(body: any) {
    const trim = (v: unknown) => (v === undefined || v === null ? undefined : String(v).trim() || undefined);
    return {
      contactPhone: trim(body?.contactPhone ?? body?.phone),
      addressStreet1: trim(body?.addressStreet1),
      addressStreet2: trim(body?.addressStreet2),
      addressCity: trim(body?.addressCity),
      addressState: trim(body?.addressState),
      addressPostalCode: trim(body?.addressPostalCode),
      addressCountry: trim(body?.addressCountry) || 'IN',
    };
  }

  /**
   * Shape-checked, not verified. Nothing here proves the account exists — only
   * that it could. A wrong-but-plausible account is caught when a payout fails.
   */
  function payoutShapeError(upiId?: string, bankAccountNumber?: string, bankIfsc?: string): string {
    if (upiId && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) {
      return 'That does not look like a UPI ID. They look like name@bank, for example ramesh@oksbi.';
    }
    if (bankAccountNumber && !/^[0-9]{9,18}$/.test(bankAccountNumber)) {
      return 'A bank account number is 9 to 18 digits, with no spaces or letters.';
    }
    if (bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(bankIfsc)) {
      return 'That does not look like an IFSC code. They are 11 characters, like HDFC0001234.';
    }
    return '';
  }

  app.post('/api/merchant/signup', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName, password, name, phone } = req.body || {};

      // Checked here, not only by the form: a shop that has not agreed to the
      // terms it will be held to must not be created by any client.
      if (req.body?.acceptTerms !== true) {
        return res.status(400).json({ error: TERMS_REQUIRED_ERROR });
      }

      const clean = (v: unknown) => (v ? String(v).replace(/\s+/g, '') : undefined);
      const upiId = clean(req.body?.upiId);
      const bankAccountNumber = clean(req.body?.bankAccountNumber);
      const bankIfsc = clean(req.body?.bankIfsc)?.toUpperCase();

      const shapeError = payoutShapeError(upiId, bankAccountNumber, bankIfsc) ||
        (Boolean(bankAccountNumber) !== Boolean(bankIfsc)
          ? 'A bank account needs both the account number and its IFSC code, or neither.' : '');
      if (shapeError) return res.status(400).json({ error: shapeError });

      if (!shopName || !ownerEmail || !printerName || !password) {
        return res.status(400).json({
          error: 'shopName, ownerEmail, printerName and password are required.',
        });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const existing = await storage.getMerchantByEmail(String(ownerEmail));
      if (existing) {
        return res.status(409).json({ error: 'An account already exists for that email. Sign in instead.' });
      }

      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl && process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          error: 'PUBLIC_WEB_URL is not configured. Refusing to register a shop whose QR code could never be scanned.',
        });
      }
      const baseUrl = (configuredWebUrl || 'http://localhost:3000').replace(/\/$/, '');

      const shop = await storage.createShop(
        shopName, ownerEmail, upiId, bankAccountNumber, bankIfsc, readShopContact(req.body)
      );
      const printer = await storage.createPrinter(shop.id, printerName, baseUrl, undefined, generateQrCodeDataUrl);

      const merchant = await storage.createMerchantUser({
        shopId: shop.id,
        email: String(ownerEmail),
        passwordHash: hashPassword(String(password)),
        name,
        phone,
        role: 'owner',
        termsAcceptedAt: new Date().toISOString(),
        termsVersion: TERMS_VERSION,
      });

      return res.status(201).json({
        shop,
        printer,
        user: merchant,
        token: issueAdminToken(
          { id: merchant.id, email: merchant.email, role: merchant.role, shopId: shop.id },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/merchant/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const user = await storage.getMerchantByEmail(String(email));
      // One message whichever part failed, so this cannot enumerate accounts.
      const ok = user && user.status === 'active' && verifyPassword(String(password), user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }

      await storage.recordMerchantLogin(user!.id);
      const { passwordHash, ...safe } = user!;

      return res.json({
        user: safe,
        shop: await storage.getShop(safe.shopId),
        token: issueAdminToken(
          { id: safe.id, email: safe.email, role: safe.role, shopId: safe.shopId },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/merchant/me', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { shopId: undefined });
    if (!merchant) return;

    const user = await storage.getMerchantUser(merchant.sub);
    if (!user) return res.status(401).json({ error: 'Account not found.' });

    const [shop, printers] = await Promise.all([
      storage.getShop(user.shopId),
      storage.listPrintersForShop(user.shopId),
    ]);

    return res.json({ user, shop, printers });
  });

  /**
   * Claim an existing shop that predates merchant accounts.
   *
   * Open only while the shop has no account, in the same way the admin console
   * bootstrap is. Requires the owner email already on the shop record.
   */
  app.post('/api/merchant/claim', async (req: Request, res: Response) => {
    try {
      const { shopId, ownerEmail, password, name } = req.body || {};
      if (!shopId || !ownerEmail || !password) {
        return res.status(400).json({ error: 'shopId, ownerEmail and password are required.' });
      }
      if (req.body?.acceptTerms !== true) {
        return res.status(400).json({ error: TERMS_REQUIRED_ERROR });
      }

      const shop = await storage.getShop(String(shopId));
      // Same response whether the shop is missing or the email is wrong, so
      // this cannot be used to discover shop ids or owner addresses.
      const emailMatches =
        shop && shop.ownerEmail.trim().toLowerCase() === String(ownerEmail).trim().toLowerCase();
      if (!emailMatches) {
        return res.status(401).json({ error: 'That shop and email do not match our records.' });
      }

      if ((await storage.countMerchantsForShop(shop!.id)) > 0) {
        return res.status(409).json({ error: 'This shop already has an account. Sign in instead.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const merchant = await storage.createMerchantUser({
        shopId: shop!.id,
        email: String(ownerEmail),
        passwordHash: hashPassword(String(password)),
        name,
        role: 'owner',
        termsAcceptedAt: new Date().toISOString(),
        termsVersion: TERMS_VERSION,
      });

      return res.status(201).json({
        user: merchant,
        shop,
        token: issueAdminToken(
          { id: merchant.id, email: merchant.email, role: merchant.role, shopId: shop!.id },
          undefined,
          'merchant'
        ),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop & Printer Registration Endpoint
   */
  app.post('/api/shops/register', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName, upiId, bankAccountNumber, bankIfsc } = req.body as RegisterShopDto;

      if (!shopName || !ownerEmail || !printerName) {
        return res.status(400).json({ error: 'shopName, ownerEmail, and printerName are required.' });
      }

      const shop = await storage.createShop(
        shopName, ownerEmail, upiId, bankAccountNumber, bankIfsc, readShopContact(req.body)
      );
      
      // PUBLIC_WEB_URL must be set to the Vercel frontend URL in Render env vars (e.g. https://printok.vercel.app)
      // A QR poster is printed and physically mounted in a shop. Emitting a
      // localhost URL produces a poster that can never work, and nothing about
      // the successful response would reveal it, so refuse instead of guessing.
      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl && process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          error:
            'PUBLIC_WEB_URL is not configured. Refusing to register a shop, because its QR code ' +
            'would point at localhost and could never be scanned by a customer.',
        });
      }
      const baseUrl = (configuredWebUrl || 'http://localhost:3000').replace(/\/$/, '');

      // Pass baseUrl + QR generator so createPrinter builds the correct URL after the ID is known
      const printer = await storage.createPrinter(
        shop.id,
        printerName,
        baseUrl,
        undefined,
        generateQrCodeDataUrl
      );

      const response: RegisterShopResponse = { shop, printer };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  });

  /**
   * Get Shop Pricing Config
   */
  app.get('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const pricing = await storage.getShopPricing(shopId);
      return res.json({ pricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Update Shop Pricing Config
   */
  app.post('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const updatedPricing = await storage.updateShopPricing(shopId, req.body || {});

      // Write through to the grid, which is what jobs are actually priced from.
      //
      // Without this, a merchant editing the four flat rates would change a row
      // nothing reads and see no effect on what customers are charged — the
      // same silent no-op this endpoint already had once, when pricing came
      // from hardcoded constants instead of the shop's card.
      //
      // Only the base rate of each cell is rewritten. Per-configuration
      // discounts and the enabled flags are the grid editor's to own, and a
      // merchant setting a flat rate has not asked to discard them.
      const derived = buildDefaultRateCard(updatedPricing);
      await storage.updateShopRateCard(shopId, {
        rates: derived.rates.map((r) => ({
          paperSize: r.paperSize,
          isColor: r.isColor,
          isDuplex: r.isDuplex,
          perPageCents: r.perPageCents,
        })) as ShopRate[],
      });

      return res.json({ pricing: updatedPricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Shop Performance Stats & Analytics
   */
  /**
   * The shop's rate grid: one rate per paper size, colour mode and sided-ness,
   * plus the two discount switches.
   *
   * Public, because the customer page quotes a price before anyone signs in.
   * It carries rates and nothing else — no shop, owner or payout detail.
   */
  app.get('/api/shops/:shopId/rates', async (req: Request, res: Response) => {
    try {
      return res.json(await storage.getShopRateCard(req.params.shopId));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/rates', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const update: Partial<ShopRateCard> = {};

      if (Array.isArray(body.rates)) {
        const cleaned: ShopRate[] = [];
        for (const raw of body.rates) {
          if (!raw || typeof raw.paperSize !== 'string') continue;

          // A rate is money. Reject anything that is not a whole, non-negative
          // number of paise rather than coercing it into one — a NaN that
          // becomes 0 is a shop giving printing away.
          const money = (v: unknown, field: string): number | null | undefined => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
              throw new Error(`${field} must be a whole number of paise, or blank.`);
            }
            return n;
          };

          const perPage = money(raw.perPageCents, 'perPageCents');
          if (perPage === null || perPage === undefined) {
            throw new Error('Every configuration needs a per-page rate.');
          }

          cleaned.push({
            paperSize: String(raw.paperSize),
            isColor: !!raw.isColor,
            isDuplex: !!raw.isDuplex,
            perPageCents: perPage,
            bulkPerPageCents: money(raw.bulkPerPageCents, 'bulkPerPageCents'),
            additionalCopyPerPageCents: money(raw.additionalCopyPerPageCents, 'additionalCopyPerPageCents'),
            enabled: raw.enabled === undefined ? true : !!raw.enabled,
          });
        }
        update.rates = cleaned;
      }

      if (typeof body.bulkEnabled === 'boolean') update.bulkEnabled = body.bulkEnabled;
      if (typeof body.additionalCopyEnabled === 'boolean') update.additionalCopyEnabled = body.additionalCopyEnabled;

      if (body.bulkThresholdCents !== undefined) {
        const t = Number(body.bulkThresholdCents);
        if (!Number.isInteger(t) || t < 1) {
          return res.status(400).json({ error: 'The discount threshold must be a whole number of paise, at least 1.' });
        }
        update.bulkThresholdCents = t;
      }

      // Refuse a card whose own numbers make a bigger order cheaper.
      //
      // Bulk steps the first-copy rate down at the threshold while the
      // additional-copy rate stays put, so whenever that step exceeds the
      // additional-copy rate the total falls as copies rise. Caught here, where
      // the merchant can see which cell is wrong, rather than only clamped at
      // checkout where nobody would ever learn about it.
      //
      // Checked against the card as it will be after this write, since a
      // request may change the rows, the switches, or only one of them.
      const after = { ...(await storage.getShopRateCard(req.params.shopId)), ...update };
      if (after.bulkEnabled && after.additionalCopyEnabled) {
        for (const rate of after.rates) {
          if (rate.enabled === false) continue;
          if (rate.bulkPerPageCents === null || rate.bulkPerPageCents === undefined) continue;
          if (rate.additionalCopyPerPageCents === null || rate.additionalCopyPerPageCents === undefined) continue;

          const bulkStep = rate.perPageCents - rate.bulkPerPageCents;
          if (rate.additionalCopyPerPageCents < bulkStep) {
            const label = `${rate.paperSize} ${rate.isColor ? 'colour' : 'black and white'} ` +
              `${rate.isDuplex ? 'double-sided' : 'single-sided'}`;
            return res.status(400).json({
              error:
                `Those rates would make a larger order cost less than a smaller one. On ${label}, ` +
                `the bulk discount takes ${bulkStep} paise off each page while an extra copy only ` +
                `adds ${rate.additionalCopyPerPageCents} paise, so crossing the threshold reduces ` +
                'the total. Raise the additional-copy rate or reduce the bulk discount.',
            });
          }
        }
      }

      return res.json(await storage.updateShopRateCard(req.params.shopId, update));
    } catch (err: any) {
      // Validation failures above are the merchant's to fix, not a server fault.
      return res.status(400).json({ error: err.message });
    }
  });

  /**
   * What this shop's portal asks a customer for.
   *
   * Public, because the customer page must render the right fields before
   * anyone has signed in. It exposes only booleans — no shop detail.
   */
  /**
   * The capability catalogue itself: what a shop may offer, and what it starts
   * with. Static, so the setup screen renders before any shop is loaded.
   */
  app.get('/api/service-catalogue', (_req: Request, res: Response) => {
    return res.json({
      capabilities: SERVICE_CATALOGUE,
      groups: SERVICE_GROUPS,
      defaults: defaultEnabledServices(),
    });
  });

  /**
   * What a customer may choose at this shop, already resolved.
   *
   * The customer page could derive this itself from the services and the rate
   * grid, but then two implementations would have to agree forever. One answer,
   * computed where the refusal is also computed.
   */
  app.get('/api/shops/:shopId/portal-options', async (req: Request, res: Response) => {
    try {
      const [config, card] = await Promise.all([
        storage.getShopPortalConfig(req.params.shopId),
        storage.getShopRateCard(req.params.shopId),
      ]);
      return res.json(derivePortalOptions(config.enabledServices, card));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * What this configuration costs at this shop, priced by the same code that
   * will charge for it.
   *
   * Public, and it has to be. The customer page used to quote by mirroring the
   * flat four-rate card client-side — a card it could not even read, because
   * GET /pricing requires a merchant token, so every customer was shown the
   * hardcoded fallback rates. A shop could edit its whole grid in Business
   * Setup and the price on the customer's screen would never move, then the
   * server would charge something else entirely at checkout.
   *
   * No document and no auth: a quote is a function of the rate card and five
   * numbers, all of which the customer already chose.
   */
  app.get('/api/shops/:shopId/quote', async (req: Request, res: Response) => {
    try {
      const whole = (v: unknown, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
      };

      const totalPages = Math.min(whole(req.query.pages, 1), 10_000);
      const copies = Math.min(whole(req.query.copies, 1), 999);
      const isColor = req.query.isColor === 'true';
      const isDuplex = req.query.isDuplex === 'true';
      const paperSize = typeof req.query.paperSize === 'string' ? req.query.paperSize : 'A4';
      const pageRange = typeof req.query.pageRange === 'string' ? req.query.pageRange : '';

      const [card, pricingConfig] = await Promise.all([
        storage.getShopRateCard(req.params.shopId),
        storage.getShopPricing(req.params.shopId),
      ]);

      const pages = billablePages(pageRange, totalPages);
      const snapshot = calculateGridPriceBreakdown(
        pages, copies, isColor, isDuplex, paperSize, card, pricingConfig
      );

      // The snapshot carries the whole rate card, which is the shop's business
      // and not the customer's. Only the figures the page displays go back.
      return res.json({
        quote: {
          pages,
          copies,
          perPageRateCents: snapshot.perPageRateCents,
          billableSheets: snapshot.billableSheets,
          subtotalCents: snapshot.subtotalCents,
          discountCents: snapshot.bulkDiscountCents,
          discountPercent: snapshot.bulkDiscountPercent,
          bulkApplied: !!snapshot.bulkApplied,
          totalPriceInCents: snapshot.totalPriceInCents,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------------
  // Shop profile and staff (PRD 20)
  // ------------------------------------------------------------------------

  /** The shop's own details, for the profile screen. */
  app.get('/api/shops/:shopId/profile', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const shop = await storage.getShop(req.params.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      // Deliberately not the payout details. Those belong to the money screen
      // and there is no reason for a profile form to carry a bank account.
      return res.json({
        profile: {
          name: shop.name,
          ownerEmail: shop.ownerEmail,
          contactPhone: shop.contactPhone ?? '',
          addressStreet1: shop.addressStreet1 ?? '',
          addressStreet2: shop.addressStreet2 ?? '',
          addressCity: shop.addressCity ?? '',
          addressState: shop.addressState ?? '',
          addressPostalCode: shop.addressPostalCode ?? '',
          addressCountry: shop.addressCountry ?? 'IN',
          gstin: shop.gstin ?? '',
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/profile', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const text = (v: unknown, max: number) =>
        v === undefined ? undefined : String(v).replace(/\s+/g, ' ').trim().slice(0, max);

      const name = text(body.name, 120);
      if (name !== undefined && name === '') {
        return res.status(400).json({ error: 'A shop needs a name.' });
      }

      // Shape-checked, not checksummed. A GSTIN is 15 characters: two state
      // digits, a ten-character PAN, an entity digit, a Z, and a check
      // character. Refusing a legitimate number because a checksum
      // implementation disagrees is worse than storing what the owner read off
      // their certificate, so this rejects only what is plainly not one.
      const gstin = text(body.gstin, 20)?.toUpperCase();
      if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) {
        return res.status(400).json({
          error: 'That does not look like a GSTIN. It is 15 characters, e.g. 27ABCDE1234F1Z5.',
        });
      }

      const updated = await storage.updateShopProfile(req.params.shopId, {
        name,
        contactPhone: text(body.contactPhone, 20),
        addressStreet1: text(body.addressStreet1, 160),
        addressStreet2: text(body.addressStreet2, 160),
        addressCity: text(body.addressCity, 80),
        addressState: text(body.addressState, 80),
        addressPostalCode: text(body.addressPostalCode, 12),
        addressCountry: text(body.addressCountry, 2)?.toUpperCase(),
        gstin,
      });

      if (!updated) return res.status(404).json({ error: 'Shop not found.' });
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Changes the signed-in user's own password.
   *
   * Requires the current one. Without that, anyone who finds an unlocked
   * counter PC with the dashboard open can lock the owner out of their own
   * shop — and a print shop's PC is not a private device.
   */
  /**
   * Starts a password reset.
   *
   * There was no way back in at all: a shop owner who forgot their password
   * lost their dashboard, their queue and their money, and the only remedy was
   * an operator editing the database by hand.
   *
   * Answers identically whether or not the address belongs to an account.
   * Anything else turns this route into a way to ask "does this shop exist
   * here", and the answer costs nothing to the person who already knows and
   * everything to the one who is guessing.
   */
  app.post('/api/merchant/password-reset/request', async (req: Request, res: Response) => {
    // Deliberately the same body on every path below.
    const sameAnswer = {
      success: true,
      message:
        'If that address belongs to a shop account, a reset link is on its way. ' +
        'It is valid for 30 minutes and can be used once.',
    };

    try {
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'An email address is required.' });

      const merchant = await storage.getMerchantByEmail(email);

      // No account, or a disabled one. Same answer, same shape, and no work
      // done that would make the response measurably slower.
      if (!merchant || merchant.status !== 'active') {
        return res.json(sameAnswer);
      }

      // 32 bytes, and only its hash is kept. The link is the credential for as
      // long as it lives, which is why it lives for half an hour.
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      await storage.createPasswordResetToken({
        tokenHash,
        merchantId: merchant.id,
        email,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });

      const base = (process.env.PUBLIC_WEB_URL || '').replace(/\/+$/, '');
      const link = `${base}/dashboard?reset=${encodeURIComponent(token)}`;

      const sent = await emailService.send({
        to: email,
        subject: 'Reset your PrintOk shop password',
        text:
          'Someone asked to reset the password for your PrintOk shop account.\n\n' +
          `Open this link to choose a new one:\n${link}\n\n` +
          'The link works once and expires in 30 minutes. If you did not ask for this, ' +
          'nothing has changed and you can ignore this message.',
      });

      if (!sent.ok) {
        // Logged, not returned. Telling the caller that mail is unconfigured
        // would say "this address does exist, we just could not write to it".
        console.error(
          `[Password reset] Could not send a reset link (provider: ${sent.provider}): ${sent.error}`
        );
      }

      return res.json(sameAnswer);
    } catch (err: any) {
      console.error('[Password reset] Request failed:', err?.message || err);
      // Still the same answer: an internal failure must not become a signal
      // about whether the account exists.
      return res.json(sameAnswer);
    }
  });

  /** Completes a reset, given a token from the emailed link. */
  app.post('/api/merchant/password-reset/confirm', async (req: Request, res: Response) => {
    try {
      const { token, password } = req.body || {};
      if (!token || !password) {
        return res.status(400).json({ error: 'A reset token and a new password are required.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
      const claim = await storage.consumePasswordResetToken(tokenHash);
      if (!claim.ok) return res.status(400).json({ error: claim.reason });

      const changed = await storage.updateMerchantPassword(claim.merchantId, hashPassword(String(password)));
      if (!changed) return res.status(404).json({ error: 'That account no longer exists.' });

      // Deliberately no session issued. Whoever reset it now signs in with the
      // password they chose, which proves they have it — and means a reset link
      // intercepted in transit does not also hand over a live session.
      return res.json({
        success: true,
        message: 'Your password has been changed. Sign in with your new password.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/merchant/password', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { shopId: undefined });
    if (!merchant) return;

    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Enter your current password and the new one.' });
      }

      const weak = validatePasswordStrength(String(newPassword));
      if (weak) return res.status(400).json({ error: weak });

      const user = await storage.getMerchantUser(merchant.sub);
      if (!user) return res.status(401).json({ error: 'This account no longer exists.' });

      const stored = await storage.getMerchantByEmail(user.email);
      if (!stored || !verifyPassword(String(currentPassword), stored.passwordHash)) {
        return res.status(403).json({ error: 'That is not your current password.' });
      }

      // Checked, not assumed. A password change that quietly does nothing
      // leaves someone believing they have rotated a credential they have not.
      const changed = await storage.updateMerchantPassword(merchant.sub, hashPassword(String(newPassword)));
      if (!changed) {
        return res.status(500).json({ error: 'The password could not be changed. Try again.' });
      }

      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Everyone who can sign in to this shop. */
  app.get('/api/shops/:shopId/staff', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      return res.json({ staff: await storage.listMerchantUsers(req.params.shopId) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Adds a staff account.
   *
   * Staff only, never another owner. The owner is whoever claimed the shop, and
   * letting that be handed out from this screen would mean a staff member could
   * be promoted to someone who can change prices and move money.
   */
  app.post('/api/shops/:shopId/staff', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    // Seats are capped now that the catalogue states a figure. It did not
    // before, and enforcing an invented number against live shops would have
    // been worse than not enforcing one.
    const seats = await checkResourceAllowance(storage, req.params.shopId, 'staff');
    if (!seats.allowed) {
      // 402, not 403: "your plan does not cover this" is an upgrade prompt, not
      // a refusal of permission. The owner is allowed to do this — their plan
      // is what is in the way.
      logOps('info', 'plan.limit_reached', { shopId: req.params.shopId, resource: 'staff' });
      return res.status(402).json({ error: seats.error, usage: seats.usage });
    }

    try {
      const { email, name, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'An email address and a password are required.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      const cleanEmail = String(email).trim().toLowerCase();
      if (await storage.getMerchantByEmail(cleanEmail)) {
        return res.status(409).json({ error: 'Someone already signs in with that email address.' });
      }

      const user = await storage.createMerchantUser({
        shopId: req.params.shopId,
        email: cleanEmail,
        passwordHash: hashPassword(String(password)),
        name: name ? String(name).trim().slice(0, 80) : undefined,
        role: 'staff',
      });

      return res.status(201).json({ user });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Disables or re-enables a staff account. */
  app.post('/api/shops/:shopId/staff/:userId/status', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId, userId } = req.params;
      const status = req.body?.status === 'active' ? 'active' : 'disabled';

      // Locking yourself out of your own shop is not a thing anyone means to
      // do, and there is nobody above the owner to undo it.
      if (userId === merchant.sub) {
        return res.status(409).json({ error: 'You cannot disable your own account.' });
      }

      const target = await storage.getMerchantUser(userId);
      if (!target || target.shopId !== shopId) {
        return res.status(404).json({ error: 'That person does not work at this shop.' });
      }

      if (target.role === 'owner') {
        return res.status(409).json({ error: 'The shop owner cannot be disabled.' });
      }

      const updated = await storage.updateMerchantUser(userId, { status });
      if (!updated) {
        return res.status(500).json({ error: 'That account could not be updated. Try again.' });
      }

      return res.json({ user: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/shops/:shopId/portal-config', async (req: Request, res: Response) => {
    try {
      const config = await storage.getShopPortalConfig(req.params.shopId);
      // Resolved here rather than in storage, so "never configured" and
      // "offers nothing" stay distinguishable in the database.
      return res.json({ ...config, enabledServices: resolveEnabledServices(config.enabledServices) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/portal-config', async (req: Request, res: Response) => {
    // Owner only. This screen carries autoPrintMode, and 'all' queues every
    // subsequent job for printing *before* payment clears — a shop-wide
    // financial policy that a staff account had been able to set unilaterally.
    // Every sibling settings route (pricing, rates, profile, razorpay-account)
    // already required the owner; this one was simply missed.
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

      const next: Partial<ShopPortalConfig> = {};
      if (bool(body.collectCustomerName) !== undefined) next.collectCustomerName = body.collectCustomerName;
      if (bool(body.customerNameRequired) !== undefined) next.customerNameRequired = body.customerNameRequired;
      if (bool(body.collectCustomerPhone) !== undefined) next.collectCustomerPhone = body.collectCustomerPhone;
      if (bool(body.customerPhoneRequired) !== undefined) next.customerPhoneRequired = body.customerPhoneRequired;

      if (typeof body.autoPrintMode === 'string' && AUTO_PRINT_MODES.includes(body.autoPrintMode)) {
        next.autoPrintMode = body.autoPrintMode;
      }
      if (typeof body.separatorMode === 'string' && SEPARATOR_MODES.includes(body.separatorMode)) {
        next.separatorMode = body.separatorMode;
      }
      if (body.separatorMinQueue !== undefined) {
        const n = Number(body.separatorMinQueue);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'The backlog size must be a whole number, at least 1.' });
        }
        next.separatorMinQueue = n;
      }

      if (Array.isArray(body.enabledServices)) {
        // Filtered against the catalogue rather than stored as sent, so a stale
        // or invented key cannot reach the portal. Order is the shop's and is
        // preserved; duplicates are collapsed.
        const known = new Set(SERVICE_CATALOGUE.map((c) => c.key));
        const seen = new Set<string>();
        next.enabledServices = body.enabledServices
          .filter((k: unknown): k is string => typeof k === 'string')
          .filter((k: string) => known.has(k) && !seen.has(k) && (seen.add(k), true));
      }

      // Required without collected is unsatisfiable: the portal would never
      // show the field, and every order would then be refused for missing it.
      const merged = { ...(await storage.getShopPortalConfig(req.params.shopId)), ...next };
      if (merged.customerNameRequired && !merged.collectCustomerName) next.customerNameRequired = false;
      if (merged.customerPhoneRequired && !merged.collectCustomerPhone) next.customerPhoneRequired = false;

      return res.json(await storage.updateShopPortalConfig(req.params.shopId, next));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/shops/:shopId/stats', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const stats = await storage.getShopStats(shopId);
      return res.json({ stats });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Recent Jobs for Shop Owner Dashboard
   */
  app.get('/api/shops/:shopId/jobs', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 50, 500);

      // Fetched wide, then filtered here, so the counts describe the shop's
      // whole recent history rather than whichever page happened to load. A tab
      // reading "Rejected 0" because the rejections fell off the end of the
      // page is worse than no count at all.
      const all = await storage.getRecentJobsForShop(shopId, 500);

      const bucket = typeof req.query.status === 'string' ? req.query.status : 'all';
      const search = typeof req.query.q === 'string' ? req.query.q : '';
      const month = typeof req.query.month === 'string' ? req.query.month : '';

      let jobs = all;

      // YYYY-MM, matched on the string rather than by parsing dates: the
      // timestamps are ISO and already in that order, and a Date round-trip
      // would quietly shift a job either side of midnight into another month.
      if (/^\d{4}-\d{2}$/.test(month)) {
        jobs = jobs.filter((j) => String(j.createdAt).startsWith(month));
      }

      if (bucket !== 'all') {
        jobs = jobs.filter((j) => bucketForState(j.printState) === bucket);
      }

      if (search) {
        jobs = jobs.filter((j) => jobMatchesSearch(j, search));
      }

      return res.json({
        jobs: jobs.slice(0, limit),
        // Counted after the month filter but before status and search, so the
        // tabs say how many are in each bucket *right now* rather than how many
        // survived the box the merchant is currently typing in.
        counts: countJobBuckets(
          /^\d{4}-\d{2}$/.test(month)
            ? all.filter((j) => String(j.createdAt).startsWith(month))
            : all
        ),
        total: jobs.length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Printer & Shop Info by Printer ID
   */
  app.get('/api/printers/:printerId', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }
      const shop = await storage.getShop(printer.shopId);
      const telemetry = await storage.getPrinterTelemetry(printerId);

      // This endpoint is necessarily public: the printer id is printed on the
      // QR poster and the customer page needs the shop name and status. It must
      // therefore expose nothing an attacker could use.
      //
      // It previously returned the printer's agent API key, which authenticates
      // the print agent — so anyone who scanned a poster could poll that shop's
      // queue, claim its jobs and report false statuses. It also returned the
      // owner's email address.
      return res.json({
        printer: {
          id: printer.id,
          shopId: printer.shopId,
          printerName: printer.printerName,
          status: printer.status,
          qrTargetUrl: printer.qrTargetUrl,
        },
        // The shop that fulfils orders placed here, as the customer page shows
        // it: name and town only. See publicShopView.
        shop: shop ? { id: shop.id, ...publicShopView(shop)! } : undefined,
        telemetry,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  /**
   * Get Printer Telemetry & Online Status
   */
  app.get('/api/printers/:printerId/telemetry', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const telemetry = await storage.getPrinterTelemetry(printerId);

      // Necessarily public: the customer page checks this before taking an
      // order, so a shop with a dead agent does not collect money it cannot
      // fulfil. It therefore answers only "can this printer take a job right
      // now", and not the agent version or device id it used to volunteer —
      // that is fleet detail, useful for targeting and of no use to a customer.
      return res.json({
        isOnline: telemetry?.isOnline ?? false,
        paperStatus: telemetry?.paperStatus ?? 'UNKNOWN',
        lastHeartbeat: telemetry?.lastHeartbeat ?? null,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Mints a short-lived, single-use, printer-scoped authorisation to download
   * that printer's appsettings.json.
   *
   * This exists because the download itself is a browser navigation, which
   * cannot carry an Authorization header. The session check happens here, where
   * it can, and the download below carries only the resulting token — never the
   * printer's permanent API key.
   */
  /**
   * Issues a new legacy agent key for a printer, invalidating the old one.
   *
   * The key was minted once at printer creation with no way to change it, so
   * one that leaked stayed valid for the life of the printer. Device-scoped
   * tokens have had per-device revocation for a while; this gives the older
   * shared credential the same escape route.
   *
   * Owner only, and returned exactly once — it is not readable afterwards
   * except by downloading a fresh agent config, which is also owner-gated.
   * Every agent still authenticating with the old key stops working until it is
   * re-paired or reconfigured, which is the point of rotating it, so the
   * response says so plainly.
   */
  app.post('/api/printers/:printerId/rotate-api-key', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res, { requireOwner: true });
      if (!ctx) return;

      const rotated = await storage.rotatePrinterApiKey(ctx.printer.id);
      if (!rotated) return res.status(404).json({ error: 'Printer not found.' });

      await storage.recordSecurityEvent({
        type: 'AUTH_REJECTED',
        severity: 'info',
        printerId: ctx.printer.id,
        detail: {
          reason: 'Legacy agent key rotated by the shop owner.',
          rotatedBy: ctx.merchant.sub,
        },
      });

      // Logged as an event, never as a value: this is a bearer credential.
      console.log(`[PrintOk] Legacy agent key rotated for printer ${ctx.printer.id}.`);

      return res.json({
        apiKey: rotated.apiKey,
        message:
          'A new agent key has been issued. Any agent still using the old key will stop ' +
          'printing until it is re-paired or given the new configuration.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/printers/:printerId/agent-config-token', async (req: Request, res: Response) => {
    try {
      // Owner only. The config this unlocks carries the printer's permanent
      // apiKey — a credential minted once when the printer was created, good
      // for full agent access, and until now with no way to rotate it. The
      // strictly less sensitive regenerate-qr route already required the owner.
      const ctx = await authorizePrinter(req, res, { requireOwner: true });
      if (!ctx) return;

      const issued = issueConfigDownloadToken({
        printerId: ctx.printer.id,
        shopId: ctx.printer.shopId,
        issuedTo: ctx.merchant.sub,
      });

      // The token itself is never logged: it is a bearer credential for the
      // next two minutes, and an access log is exactly where it must not be.
      return res.status(201).json({
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        expiresInSeconds: issued.expiresInSeconds,
        url: `/api/printers/${encodeURIComponent(ctx.printer.id)}/agent-config?token=${encodeURIComponent(issued.token)}`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Download Pre-Configured appsettings.json for Windows Print Agent.
   *
   * Authorised by a token from the endpoint above, not by a session, and not by
   * nothing at all — which is what it was. The file contains the printer's
   * agent API key, and printer ids are public (they are on the QR poster), so
   * an unauthenticated version of this route handed a shop's agent credentials
   * to anyone who scanned its poster.
   */
  app.get('/api/printers/:printerId/agent-config', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const presented = typeof req.query.token === 'string' ? req.query.token : '';

      if (!presented) {
        return res.status(401).json({
          error: 'A download authorisation is required. Use the download button in your dashboard.',
        });
      }

      // Signature, expiry and the printer binding are all checked together, so
      // a valid token for another printer cannot read this one.
      const claims = verifyConfigDownloadToken(presented, printerId);
      if (!claims) {
        return res.status(401).json({
          error: 'This download link is invalid or has expired. Use the download button in your dashboard again.',
        });
      }

      // Single use. A link left in browser history or a proxy log cannot be
      // replayed; the short expiry is the backstop if this store is unavailable.
      const replayKey = `${CONFIG_DOWNLOAD_SCOPE}:${claims.jti}`;
      if (await storage.getIdempotencyRecord(replayKey)) {
        return res.status(401).json({
          error: 'This download link has already been used. Use the download button in your dashboard again.',
        });
      }

      const printer = await storage.getPrinter(printerId);
      if (!printer || printer.shopId !== claims.shopId) {
        return res.status(404).json({ error: 'Printer not found.' });
      }

      await storage.saveIdempotencyRecord({
        key: replayKey,
        scope: CONFIG_DOWNLOAD_SCOPE,
        // No request body is involved, and the jti already makes the key unique.
        requestHash: claims.jti,
        statusCode: 200,
        responseBody: {},
        createdAt: new Date().toISOString(),
        // Outlives the token, so a burnt jti cannot come back before it expires.
        expiresAt: new Date(Date.now() + CONFIG_DOWNLOAD_TTL_MS * 2).toISOString(),
      });

      await storage.recordSecurityEvent({
        printerId: printer.id,
        type: 'AGENT_CONFIG_DOWNLOADED',
        severity: 'info',
        // Who and which printer — never the key or the token.
        detail: { issuedTo: claims.issuedTo },
      });

      const apiBaseUrl = process.env.API_BASE_URL || 'https://prinok-api.onrender.com';

      // The agent resolves flat keys first and falls back to the nested PrintOk
      // section, so emit both: agents released before v1.1.0 only read the nested
      // shape and would otherwise silently fall back to localhost defaults.
      const config = {
        PrintOkApiUrl: apiBaseUrl,
        AgentApiKey: printer.apiKey,
        ShopId: printer.shopId,
        PrinterId: printer.id,
        PrinterName: '',
        PollIntervalMs: 3000,
        HeartbeatIntervalSeconds: 30,
        PrintOk: {
          ApiBaseUrl: apiBaseUrl,
          ApiKey: printer.apiKey,
          ShopId: printer.shopId,
          PrinterId: printer.id,
          PollIntervalMs: 3000,
          HeartbeatIntervalSeconds: 30
        },
        Logging: {
          LogLevel: {
            Default: 'Information',
            'Microsoft.Hosting.Lifetime': 'Information'
          }
        }
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="appsettings.json"`);
      return res.send(JSON.stringify(config, null, 2));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ------------------------------------------------------------------------
  // Platform administration (PRD 21)
  // ------------------------------------------------------------------------

  /**
   * Resolves the calling operator from a bearer token.
   * Responds and returns null on failure, so callers can `if (!admin) return;`.
   */
  async function authenticateAdmin(req: Request, res: Response): Promise<AdminTokenPayload | null> {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) {
      res.status(401).json({ error: 'Unauthorized: sign in to the admin console.' });
      return null;
    }

    const payload = verifyAdminToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Session expired or invalid. Sign in again.' });
      return null;
    }

    // A disabled account must lose access immediately, not at token expiry.
    const user = await storage.getAdminUser(payload.sub);
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'This admin account is no longer active.' });
      return null;
    }

    return payload;
  }

  /**
   * Creates the very first operator account.
   *
   * Open only while no admin exists, so it cannot be used to add accounts later.
   * Every subsequent account is created by a signed-in operator.
   */
  app.post('/api/admin/bootstrap', async (req: Request, res: Response) => {
    try {
      // Cheap refusal first, so the common case — somebody finding this route
      // on a long-running instance — costs no lock and no password hash.
      if ((await storage.countAdminUsers()) > 0) {
        return res.status(409).json({ error: 'An administrator already exists. Sign in instead.' });
      }

      const { email, password, name } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const weak = validatePasswordStrength(String(password));
      if (weak) return res.status(400).json({ error: weak });

      // The check above is a courtesy, not the guard. This is the guard: the
      // count and the insert happen together under one lock, so two concurrent
      // requests during the pre-bootstrap window cannot both create an owner.
      const claim = await storage.createFirstAdminUser({
        email: String(email),
        passwordHash: hashPassword(String(password)),
        name,
      });

      if (!claim.ok) {
        return res.status(409).json({ error: claim.reason });
      }

      const user = claim.user;
      return res.status(201).json({ user, token: issueAdminToken(user) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email and password are required.' });
      }

      const user = await storage.getAdminUserByEmail(String(email));

      // Same response whether the account is missing, disabled or the password
      // is wrong, so this cannot be used to enumerate accounts.
      const ok = user && user.status === 'active' && verifyPassword(String(password), user.passwordHash);
      if (!ok) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }

      await storage.recordAdminLogin(user!.id);
      const { passwordHash, ...safe } = user!;
      return res.json({ user: safe, token: issueAdminToken(safe) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/me', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    const user = await storage.getAdminUser(admin.sub);
    return res.json({ user, needsBootstrap: false });
  });

  /** Whether the console still needs its first account created. */
  app.get('/api/admin/status', async (_req: Request, res: Response) => {
    try {
      return res.json({ needsBootstrap: (await storage.countAdminUsers()) === 0 });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      return res.json({ overview: await storage.getAdminOverview() });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/shops', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const includeArchived = req.query.includeArchived === 'true';
      return res.json({ shops: await storage.listAdminShopSummaries(limit, includeArchived) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Whether a shop can be hard deleted, without changing anything.
   * The console calls this before offering a destructive action.
   */
  app.get('/api/admin/shops/:shopId/removal-safety', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      return res.json({ safety: await storage.getShopRemovalSafety(req.params.shopId) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Removes shops (PRD 21).
   *
   * Handles one or many in the same call, so bulk cleanup and a single deletion
   * share one guarded path rather than two that can drift.
   *
   * mode 'delete'  - permanent, and refused for any shop that has taken a paid
   *                  job, because that would destroy payment records
   * mode 'archive' - hides the shop but keeps everything, the only safe option
   *                  once real money has moved through it
   * mode 'restore' - undoes an archive
   *
   * A bulk request is not atomic on purpose: one shop being undeletable must not
   * prevent the rest from being cleaned up. Every outcome is reported per shop.
   */
  app.post('/api/admin/shops/remove', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { shopIds, mode, reason, force, confirm } = req.body || {};
      const ids: string[] = Array.isArray(shopIds) ? shopIds : shopIds ? [shopIds] : [];

      if (ids.length === 0) {
        return res.status(400).json({ error: 'shopIds is required.' });
      }
      if (ids.length > 100) {
        return res.status(400).json({ error: 'At most 100 shops can be removed in one request.' });
      }
      if (!['delete', 'archive', 'restore'].includes(mode)) {
        return res.status(400).json({ error: "mode must be 'delete', 'archive' or 'restore'." });
      }

      // Overriding the paid-job guard destroys payment records along with the
      // shop, so it takes the highest role and a typed confirmation rather than
      // a boolean that could be set by accident.
      const forceDelete = mode === 'delete' && force === true;
      if (forceDelete) {
        if (admin.role !== 'owner') {
          return res.status(403).json({
            error: 'Only an owner can delete shops that have taken payment.',
          });
        }
        if (confirm !== 'DELETE PAID SHOPS') {
          return res.status(400).json({
            error: "Forced deletion requires confirm: 'DELETE PAID SHOPS'.",
          });
        }
      }

      const results = [];
      for (const shopId of ids) {
        // Capture what is about to be destroyed, so the audit entry still
        // explains the deletion after the row is gone.
        const safety = await storage.getShopRemovalSafety(shopId);

        let result;
        if (mode === 'delete') {
          result = await storage.hardDeleteShop(shopId, forceDelete);
        } else if (mode === 'archive') {
          result = await storage.archiveShop(shopId, admin.email, reason);
        } else {
          result = await storage.restoreShop(shopId);
        }

        if (result.ok) {
          await storage.recordAdminAudit({
            actorId: admin.sub,
            actorEmail: admin.email,
            // A forced deletion is recorded distinctly so it stands out from
            // ordinary cleanup in the audit trail.
            action: forceDelete && safety.paidJobCount > 0
              ? 'SHOP_FORCE_DELETED'
              : `SHOP_${result.action.toUpperCase()}`,
            targetType: 'shop',
            targetId: shopId,
            detail: {
              reason,
              forced: forceDelete,
              paidJobCount: safety.paidJobCount,
              totalJobCount: safety.totalJobCount,
              printerCount: safety.printerCount,
            },
          });
        }

        results.push(result);
      }

      return res.json({
        results,
        succeeded: results.filter((r) => r.ok).length,
        refused: results.filter((r) => !r.ok).length,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Link a shop to Razorpay Route so its share settles automatically.
   *
   * Creating the account is only the first step: Razorpay still requires the
   * shop to complete KYC before any transfer will settle, which is why the
   * status is surfaced rather than assumed.
   */
  app.post('/api/shops/:shopId/razorpay-account', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const shop = await storage.getShop(shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      // Fully onboarded already: report Razorpay's current status rather than
      // creating a duplicate account.
      if (shop.razorpayAccountId && shop.razorpayProductId) {
        const live = await routeService.getLinkedAccountStatus(shop.razorpayAccountId, shop.razorpayProductId);
        if (live.ok && live.status) {
          await storage.updateShopRazorpayAccount(shopId, {
            status: live.status,
            requirements: live.requirements ?? null,
            error: null,
          });
        }
        return res.json({
          accountId: shop.razorpayAccountId,
          status: live.status || shop.razorpayAccountStatus,
          requirements: live.requirements,
          alreadyLinked: true,
        });
      }

      const body = req.body || {};

      // What the shop gave at signup is the default; the request body may
      // still override it, so a shop can correct its details at onboarding
      // time without editing its profile first.
      const phone = String(body.phone || shop.contactPhone || '').trim();
      if (!phone) {
        return res.status(400).json({
          error:
            'A contact phone number is required to create a Razorpay linked account. ' +
            'Add one to the shop profile, or send it with this request.',
        });
      }

      // Everything below is only worth asking for once Route exists to use it.
      if (!routeService.isEnabled) {
        return res.status(503).json({
          error:
            'Razorpay Route is not enabled for PrintOk yet, so linked accounts cannot be created. ' +
            'Online payments are received by PrintOk and paid out to you separately meanwhile.',
          routeUnavailable: true,
        });
      }

      const businessType = String(body.businessType || '').trim();
      if (!(LINKED_ACCOUNT_BUSINESS_TYPES as readonly string[]).includes(businessType)) {
        return res.status(400).json({
          error: `businessType must be one of: ${LINKED_ACCOUNT_BUSINESS_TYPES.join(', ')}.`,
        });
      }
      const contactName = String(body.contactName || '').trim();
      if (contactName.length < 4) {
        return res.status(400).json({
          error: 'contactName is required: the proprietor, partner or director Razorpay will verify.',
        });
      }
      if (body.tncAccepted !== true) {
        return res.status(400).json({ error: 'Razorpay\'s terms for Route must be accepted (tncAccepted).' });
      }

      const address = body.address || {
        street1: shop.addressStreet1, street2: shop.addressStreet2, city: shop.addressCity,
        state: shop.addressState, postalCode: shop.addressPostalCode, country: shop.addressCountry || 'IN',
      };
      if (!address.street1 || !address.city || !address.state || !/^\d{6}$/.test(String(address.postalCode || ''))) {
        return res.status(400).json({
          error: 'A complete registered address (street, city, state and 6-digit PIN code) is required. Add it to the shop profile.',
        });
      }

      // Settlement goes to the bank account the shop already registered for
      // payouts. Nothing new is collected here.
      if (!shop.bankAccountNumber || !shop.bankIfsc) {
        return res.status(400).json({
          error: 'Add your bank account number and IFSC under payout details first. Razorpay settles to that account.',
        });
      }

      const legalBusinessName = String(body.legalBusinessName || shop.name).trim();
      const result = await routeService.createLinkedAccount({
        shopId,
        legalBusinessName,
        customerFacingName: shop.name,
        email: shop.ownerEmail,
        phone,
        businessType,
        contactName,
        address: {
          street1: String(address.street1), street2: address.street2 ? String(address.street2) : undefined,
          city: String(address.city), state: String(address.state),
          postalCode: String(address.postalCode), country: address.country ? String(address.country) : 'IN',
        },
        gstin: shop.gstin,
        settlement: {
          accountNumber: shop.bankAccountNumber,
          ifsc: shop.bankIfsc,
          beneficiaryName: String(body.beneficiaryName || legalBusinessName).trim(),
        },
        tncAccepted: true,
      }, {
        accountId: shop.razorpayAccountId,
        stakeholderId: shop.razorpayStakeholderId,
        productId: shop.razorpayProductId,
      });

      // Whatever was created is kept even when a later step failed, so the
      // next attempt resumes instead of creating a second account.
      await storage.updateShopRazorpayAccount(shopId, {
        accountId: result.accountId,
        stakeholderId: result.stakeholderId,
        productId: result.productId,
        status: result.status || (result.accountId ? 'created' : 'not_linked'),
        requirements: result.requirements ?? null,
        error: result.ok ? null : result.error,
      });

      if (!result.ok) {
        return res.status(result.routeUnavailable ? 503 : 400).json({
          error: result.error,
          routeUnavailable: result.routeUnavailable === true,
          accountId: result.accountId,
        });
      }

      return res.status(201).json({
        accountId: result.accountId,
        status: result.status,
        requirements: result.requirements,
        message:
          'Linked account created and submitted to Razorpay. Razorpay reviews it and may ask for ' +
          'KYC documents; nothing is transferred to it until Razorpay activates it.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Current Route status for a shop, refreshed from Razorpay when linked. */
  app.get('/api/shops/:shopId/razorpay-account', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const shop = await storage.getShop(req.params.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      if (!shop.razorpayAccountId) {
        return res.json({
          status: 'not_linked',
          routeEnabled: routeService.isEnabled,
          error: shop.razorpayAccountError,
        });
      }

      const live = await routeService.getLinkedAccountStatus(shop.razorpayAccountId, shop.razorpayProductId);
      if (live.ok && live.status) {
        await storage.updateShopRazorpayAccount(req.params.shopId, {
          status: live.status,
          ...(live.requirements !== undefined ? { requirements: live.requirements } : {}),
        });
      }

      return res.json({
        accountId: shop.razorpayAccountId,
        status: live.status || shop.razorpayAccountStatus,
        requirements: live.requirements ?? shop.razorpayAccountRequirements,
        routeEnabled: routeService.isEnabled,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * What build this device should be running.
   *
   * Polled by paired agents. The answer is deliberately thin — a version, a
   * URL, a hash and what to do about it — because this is the one response in
   * the API that decides what code executes on a shop's counter PC.
   *
   * Three things this endpoint does NOT do, each on purpose:
   *
   *   - It never serves the installer itself. The agent fetches that from the
   *     published URL and checks it against its own download allowlist, so a
   *     server that has been compromised cannot hand the fleet a binary merely
   *     by answering this call.
   *   - It never tells a device to downgrade. Only a strictly newer version is
   *     offered, so publishing an old row by mistake cannot roll a fleet
   *     backwards onto a build with a known defect.
   *   - It answers upToDate when nothing is published, rather than erroring.
   *     An agent whose update check fails must keep printing.
   */
  app.get('/api/agent/update-manifest', async (req: Request, res: Response) => {
    const identity = await authenticateAgent(storage, req, res);
    if (!identity) return;

    try {
      const release = await storage.getActiveAgentRelease();
      const reported = String(req.headers['x-agent-version'] || '').trim();

      // Paused stops a rollout mid-flight without publishing another row, for
      // when a bad build is noticed after it has reached some of the fleet.
      if (!release || release.paused) {
        return res.json({ upToDate: true } satisfies AgentUpdateManifest);
      }

      if (compareAgentVersions(release.version, reported) <= 0) {
        return res.json({ upToDate: true } satisfies AgentUpdateManifest);
      }

      return res.json({
        upToDate: false,
        version: release.version,
        downloadUrl: release.downloadUrl,
        sha256: release.sha256,
        mode: release.mode,
        ...(release.notes ? { notes: release.notes } : {}),
      } satisfies AgentUpdateManifest);
    } catch (err: any) {
      // An update check that fails must never stop a shop printing, so this is
      // an "up to date" rather than a 500 the agent has to interpret.
      console.error('[Agent update] Could not build a manifest:', err?.message || err);
      return res.json({ upToDate: true } satisfies AgentUpdateManifest);
    }
  });

  /**
   * Publishes a build for the fleet to run.
   *
   * Owner-only, and deliberately the narrowest admin route in the file: it is
   * the one that decides what executes on other people's computers. The URL is
   * checked against AGENT_RELEASE_HOSTS and the hash against the shape the
   * agent will verify, so a pasted wrong link or a truncated digest is refused
   * here rather than distributed and then refused 200 times.
   */
  app.post('/api/admin/agent-releases', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    // Owner-only, checked here the way shop deletion checks it. Publishing a
    // build decides what runs on other people's computers, which is not a
    // read-only operator's call.
    if (admin.role !== 'owner') {
      return res.status(403).json({
        error: 'Only an owner can publish an agent build.',
      });
    }

    try {
      const { version, downloadUrl, sha256, mode, paused, notes } = req.body || {};

      const cleanVersion = String(version || '').trim();
      if (!/^\d+(\.\d+){1,3}$/.test(cleanVersion)) {
        return res.status(400).json({
          error: 'A version looks like 1.4.0 — numbers and dots only, so it can be compared against what each device reports.',
        });
      }

      const cleanUrl = String(downloadUrl || '').trim();
      if (!isAllowedReleaseUrl(cleanUrl)) {
        return res.status(400).json({
          error:
            'The installer must be an https:// URL on a published release host ' +
            `(${AGENT_RELEASE_HOSTS.join(', ')}). Agents refuse anything else anyway.`,
        });
      }

      const cleanHash = String(sha256 || '').trim().toLowerCase();
      if (!isValidSha256(cleanHash)) {
        return res.status(400).json({
          error:
            'A SHA-256 is 64 hex characters. Agents verify the installer against it and refuse ' +
            'a mismatch, so a wrong digest means nothing installs.',
        });
      }

      const cleanMode: AgentUpdateMode = mode === 'auto' ? 'auto' : 'notify';

      // Refuse to publish a build older than the one already out. Rolling
      // forward is a decision; rolling a fleet backwards by mistyping a version
      // is an accident, and this is where it is cheapest to catch.
      const current = await storage.getActiveAgentRelease();
      if (current && compareAgentVersions(cleanVersion, current.version) < 0 && req.body?.force !== true) {
        return res.status(409).json({
          error:
            `Version ${cleanVersion} is older than the published ${current.version}. ` +
            'If you mean to roll the fleet back, send force: true.',
        });
      }

      const release = await storage.publishAgentRelease({
        version: cleanVersion,
        downloadUrl: cleanUrl,
        sha256: cleanHash,
        mode: cleanMode,
        paused: paused === true,
        notes: notes ? String(notes).slice(0, 500) : undefined,
        publishedBy: admin.sub,
        publishedByEmail: admin.email,
      });

      logOps('warn', 'agent.release_published', {
        version: release.version, mode: release.mode, paused: release.paused, by: admin.sub,
      });

      return res.status(201).json({ release });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Which devices are on which build, and what has been published. */
  app.get('/api/admin/agent-releases', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const [active, history, fleet] = await Promise.all([
        storage.getActiveAgentRelease(),
        storage.listAgentReleases(20),
        storage.listAgentFleet(),
      ]);

      // Grouped by what each device reports, because the useful question is
      // "how much of the fleet has taken it", not "list 200 rows".
      const byVersion = new Map<string, number>();
      for (const device of fleet) {
        const key = device.agentVersion || 'unknown';
        byVersion.set(key, (byVersion.get(key) || 0) + 1);
      }

      const outdated = active
        ? fleet.filter((d) => compareAgentVersions(active.version, d.agentVersion || '') > 0)
        : [];

      return res.json({
        active: active ?? null,
        history,
        fleet: {
          total: fleet.length,
          outdated: outdated.length,
          byVersion: [...byVersion.entries()]
            .map(([version, count]) => ({ version, count }))
            .sort((a, b) => compareAgentVersions(b.version, a.version)),
          devices: fleet,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Published plan catalogue (PRD 41).
   *
   * Public and unauthenticated: the landing page renders from this, so the
   * prices a shop is shown are the prices the API actually applies.
   */
  app.get('/api/plans', (_req: Request, res: Response) => {
    return res.json({
      // `commissionBps` is the same number as `platformFeeBps`, carried so a
      // landing page still cached from before the rename renders a rate rather
      // than "undefined%". One source, two names, for one deploy.
      plans: PLAN_CATALOGUE.map((p) => ({ ...p, commissionBps: p.platformFeeBps })),
      paymentGateway: {
        feeBps: PAYMENT_GATEWAY_FEE_BPS,
        label: PAYMENT_GATEWAY_LABEL,
        note:
          'Charged by Razorpay and deducted before settlement. Separate from the PrintOk ' +
          'platform fee, and not absorbed by PrintOk.',
      },
    });
  });

  /**
   * Public contact form submission.
   *
   * Enquiries are stored rather than emailed, so nothing depends on a mail
   * provider being configured and a message cannot be silently lost. Delivery
   * or notification can be layered on later without changing capture.
   */
  app.post('/api/contact', async (req: Request, res: Response) => {
    try {
      const { name, email, phone, shopName, message, website } = req.body || {};

      // Honeypot: a real person never fills a field they cannot see. Answer 201
      // so a bot cannot tell it was rejected.
      if (website) {
        return res.status(201).json({ success: true });
      }

      const trimmedName = String(name || '').trim();
      const trimmedEmail = String(email || '').trim().toLowerCase();
      const trimmedMessage = String(message || '').trim();

      if (!trimmedName || !trimmedEmail || !trimmedMessage) {
        return res.status(400).json({ error: 'Name, email and message are required.' });
      }
      if (trimmedName.length > 120 || trimmedEmail.length > 200) {
        return res.status(400).json({ error: 'Name or email is too long.' });
      }
      if (trimmedMessage.length < 10) {
        return res.status(400).json({ error: 'Please describe what you need in a little more detail.' });
      }
      if (trimmedMessage.length > 4000) {
        return res.status(400).json({ error: 'Message is too long. Please keep it under 4000 characters.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }

      // Per-address ceiling on top of the per-IP limiter, so one sender cannot
      // flood the inbox from a rotating address pool.
      const recent = await storage.countRecentEnquiriesFrom(trimmedEmail, 60 * 60 * 1000);
      if (recent >= 3) {
        return res.status(429).json({
          error: 'We already have your recent messages. We will reply shortly.',
        });
      }

      const enquiry = await storage.createContactEnquiry({
        name: trimmedName,
        email: trimmedEmail,
        phone: phone ? String(phone).trim().slice(0, 40) : undefined,
        shopName: shopName ? String(shopName).trim().slice(0, 160) : undefined,
        message: trimmedMessage,
        source: 'landing',
        // Coarse origin only, hashed, for abuse investigation.
        ipHash: req.ip
          ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 32)
          : undefined,
        userAgent: (req.headers['user-agent'] || '').toString().slice(0, 400),
      });

      // Delivered as well as stored. Enquiries were written to a table nobody
      // watches and reached no one — somebody filling in the contact form on a
      // live site was talking into the air.
      //
      // Not awaited in a way that can fail the request: the enquiry is already
      // saved, and refusing it because a mail provider is down would lose the
      // message entirely. A failure is logged and the record is still there for
      // the admin console.
      if (emailService.operatorAddress) {
        const notice = await emailService.send({
          to: emailService.operatorAddress,
          subject: `PrintOk enquiry from ${trimmedName}`,
          text:
            `${trimmedName} <${trimmedEmail}> got in touch through the site.\n\n` +
            (enquiry.shopName ? `Shop: ${enquiry.shopName}\n` : '') +
            (enquiry.phone ? `Phone: ${enquiry.phone}\n` : '') +
            `\n${trimmedMessage}\n\n` +
            `Reference: ${enquiry.id}`,
        });

        if (!notice.ok) {
          console.error(
            `[Enquiry] ${enquiry.id} was stored but could not be delivered ` +
            `(provider: ${notice.provider}): ${notice.error}`
          );
        }
      } else if (process.env.NODE_ENV === 'production') {
        console.error(
          `[Enquiry] ${enquiry.id} was stored and not delivered: OPERATOR_EMAIL is not set.`
        );
      }

      return res.status(201).json({ success: true, enquiryId: enquiry.id });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Whether the platform can send email at all.
   *
   * Surfaced so an operator can see it on the console rather than discovering
   * it when a shop owner cannot get back into their account.
   */
  app.get('/api/admin/email-status', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    return res.json({
      provider: emailService.providerName,
      canSend: emailService.canSend,
      operatorAddressSet: Boolean(emailService.operatorAddress),
      required: emailService.canSend
        ? []
        : ['EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM', 'OPERATOR_EMAIL'],
      consequence: emailService.canSend
        ? null
        : 'Contact enquiries are stored but not delivered, and password resets cannot be sent.',
    });
  });

  /**
   * What needs a person right now.
   *
   * The project's own assessment was that nothing alerts anyone — a shop
   * offline overnight went unnoticed, and every defect that week was found by
   * reading code rather than by anything saying so. This does not send an
   * alert, which needs somewhere to send it; it gathers the answers an alert
   * would carry, in one place an operator can actually look at.
   */
  app.get('/api/admin/operations', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const now = Date.now();

      // Built from the summaries the console already computes, rather than
      // walking every printer and job: those aggregates exist, and asking the
      // database per printer would make an operations page the slowest thing
      // on the platform.
      const summaries = await storage.listAdminShopSummaries(200, false);

      const shopsWithOfflinePrinters = summaries
        .filter((s) => s.printerCount > 0 && s.onlinePrinterCount < s.printerCount)
        .map((s) => ({
          shopId: s.shop.id,
          shopName: s.shop.name,
          printers: s.printerCount,
          online: s.onlinePrinterCount,
          lastJobAt: s.lastJobAt ?? null,
        }));

      const shopsNeedingAttention = summaries
        .filter((s) => s.jobsRequiringAction > 0)
        .map((s) => ({
          shopId: s.shop.id,
          shopName: s.shop.name,
          jobs: s.jobsRequiringAction,
        }));

      // Refunds that never landed. Only the shops that have taken money are
      // worth walking, and only their recent jobs.
      const stuckRefunds: Array<Record<string, unknown>> = [];
      for (const summary of summaries.filter((s) => s.grossRevenueCents > 0).slice(0, 50)) {
        for (const job of await storage.getRecentJobsForShop(summary.shop.id, 100)) {
          if (job.paymentState !== PaymentState.RefundPending) continue;
          if (now - new Date(job.updatedAt).getTime() < STUCK_REFUND_AFTER_MS) continue;

          stuckRefunds.push({
            jobId: job.id,
            shopId: summary.shop.id,
            amountCents: job.totalPriceInCents,
            since: job.updatedAt,
          });
        }
      }

      return res.json({
        checkedAt: new Date().toISOString(),
        // Every figure below is a count of something a person would have to do.
        storage: process.env.DATABASE_URL ? 'postgres' : 'memory',
        email: {
          canSend: emailService.canSend,
          provider: emailService.providerName,
          // Stated as a consequence rather than a status, because that is what
          // decides whether anyone acts on it.
          consequence: emailService.canSend
            ? null
            : 'Enquiries are not delivered and password resets cannot be sent.',
        },
        printersOffline: {
          shops: shopsWithOfflinePrinters.length,
          // A shop whose only printer is offline cannot print at all, which is
          // a different severity from one of five being down.
          shopsFullyDown: shopsWithOfflinePrinters.filter((s) => s.online === 0).length,
          examples: shopsWithOfflinePrinters.slice(0, 20),
        },
        jobsNeedingAttention: {
          shops: shopsNeedingAttention.length,
          jobs: shopsNeedingAttention.reduce((t, s) => t + s.jobs, 0),
          examples: shopsNeedingAttention.slice(0, 20),
        },
        stuckRefunds: {
          count: stuckRefunds.length,
          examples: stuckRefunds.slice(0, 20),
        },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Enquiries from the contact form (PRD 24). */
  app.get('/api/admin/contact-enquiries', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      const limit = Math.min(Number(req.query.limit) || 100, 300);
      return res.json({
        enquiries: await storage.listContactEnquiries(status, limit),
        newCount: await storage.countNewContactEnquiries(),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/contact-enquiries/:id', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { status, notes } = req.body || {};
      if (!['new', 'read', 'replied', 'archived'].includes(status)) {
        return res.status(400).json({ error: "status must be 'new', 'read', 'replied' or 'archived'." });
      }

      const enquiry = await storage.updateContactEnquiryStatus(
        req.params.id, status, admin.email, notes
      );
      if (!enquiry) return res.status(404).json({ error: 'Enquiry not found.' });

      return res.json({ enquiry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Operator action history (PRD 22). */
  app.get('/api/admin/audit', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      return res.json({ entries: await storage.listAdminAudit(limit) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Change a shop's tier, commission or status (PRD 41). */
  app.patch('/api/admin/shops/:shopId/plan', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'Your role is read-only.' });
    }

    try {
      const { planTier, commissionBps, planStatus } = req.body || {};

      if (planTier && !PLAN_TIERS.includes(planTier)) {
        return res.status(400).json({
          error: `Unknown plan tier '${planTier}'. Expected one of: ${PLAN_TIERS.join(', ')}.`,
        });
      }
      if (planStatus && !['active', 'suspended', 'cancelled'].includes(planStatus)) {
        return res.status(400).json({ error: `Unknown plan status '${planStatus}'.` });
      }
      if (commissionBps !== undefined) {
        const bps = Number(commissionBps);
        // Guard against a typo silently charging shops 100%.
        if (!Number.isInteger(bps) || bps < 0 || bps > 5000) {
          return res.status(400).json({ error: 'commissionBps must be an integer between 0 and 5000 (0-50%).' });
        }
      }

      // Moving tier adopts that tier's published fee unless one is given
      // explicitly, so a shop is never left paying its old rate on a new plan.
      const resolvedCommission = commissionBps !== undefined
        ? Number(commissionBps)
        : (planTier ? getPlan(planTier)?.platformFeeBps : undefined);

      const plan = await storage.updateShopPlan(req.params.shopId, {
        planTier, commissionBps: resolvedCommission, planStatus,
      });
      if (!plan) return res.status(404).json({ error: 'Shop not found.' });

      await storage.recordAdminAudit({
        actorId: admin.sub,
        actorEmail: admin.email,
        action: 'PLAN_CHANGED',
        targetType: 'shop',
        targetId: req.params.shopId,
        detail: { planTier, commissionBps, planStatus },
      });

      return res.json({ plan });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * The shop refuses a job, refunding the customer in full.
   *
   * A shop has to be able to say no — the paper is the wrong size, the printer
   * is broken, the document is something it will not print. Doing that while
   * the customer has already paid means sending the money back, so the two are
   * one action rather than a cancellation the shop must remember to refund.
   *
   * The refund is issued only after the job has been moved to RefundPending, so
   * a job is never recorded as refunded before Razorpay has accepted it, and a
   * refund that fails leaves a state that says so rather than one that lies.
   */
  app.post('/api/shops/:shopId/jobs/:jobId/decline', async (req: Request, res: Response) => {
    const { shopId, jobId } = req.params;

    const merchant = await authenticateMerchant(req, res, { shopId });
    if (!merchant) return;

    try {
      const reason = String((req.body || {}).reason || '').trim();
      if (!reason) {
        return res.status(400).json({
          error: 'A reason is required. The customer is told why their job was refused.',
        });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) return res.status(404).json({ error: 'Print job not found.' });

      // Scoped to the shop in the URL, which the session is already checked
      // against — so one shop cannot decline another's work.
      if (job.shopId !== shopId) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // Paper and toner are already spent once it has printed. Refusing then is
      // a refund decision for a human, not a button.
      if ([PrintState.Printed, PrintState.ReadyForCollection, PrintState.Completed].includes(job.printState)) {
        return res.status(409).json({
          error: 'This job has already printed and cannot be declined. Issue a refund manually if it was wrong.',
        });
      }

      const declined = await storage.declineJob(jobId, reason, {
        actor: `shop:${merchant.sub}`,
        detail: { declinedBy: merchant.email },
      });

      if (!declined.ok) {
        const status = declined.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: declined.reason });
      }

      // Nothing was taken, so there is nothing to send back.
      if (declined.job.paymentState !== PaymentState.RefundPending) {
        return res.json({
          success: true,
          job: declined.job,
          refund: { issued: false, reason: 'No payment had been taken for this job.' },
        });
      }

      // Money transferred to the shop comes back before the customer is paid.
      //
      // With Route, the shop's share sits in the shop's own linked account (on
      // hold until printing, which a declined job never reached). Refunding the
      // customer from the platform account without reversing it would mean
      // PrintOk paying that share out of its own pocket. So the transfer is
      // reversed first, once, and the refund only follows a reversal that
      // succeeded. A transfer id exists only when a real transfer was made —
      // with Route off this whole block is skipped.
      if (job.transferId) {
        const reversal = await reverseRouteTransfer(job, reason);
        if (!reversal.ok) {
          logOps('error', 'refund.blocked', {
            jobId: job.id, shopId: job.shopId, transferId: job.transferId,
            reason: 'route-transfer-not-reversed', needsHuman: true,
          });
          return res.status(409).json({
            error:
              'This order\'s payment was already transferred to your Razorpay account, and that '
              + 'transfer could not be reversed automatically, so the customer has not been refunded '
              + 'yet. Contact support and it will be handled with Razorpay.',
            job: declined.job,
            refund: { issued: false, reason: 'route-transfer-not-reversed', detail: reversal.error },
            transferId: job.transferId,
          });
        }
      }

      const refund = await razorpayService.refundPayment(
        // The payment claimed for this job (unique platform-wide), else the
        // reference its confirmation recorded.
        String(job.razorpayPaymentId || job.paymentRef || ''),
        job.totalPriceInCents,
        { jobId: job.id, shopId: job.shopId, reason }
      );

      if (!refund.ok) {
        // The job stays in RefundPending: the shop's decision stands, and the
        // money is visibly still owed rather than quietly forgotten.
        return res.status(202).json({
          success: true,
          job: declined.job,
          refund: { issued: false, error: refund.error },
          message:
            'The job was declined, but the refund could not be issued automatically. ' +
            'It must be refunded from the Razorpay dashboard.',
        });
      }

      // Razorpay refunds are asynchronous. The call returning does not mean the
      // money has moved: a refund is created as 'pending' and becomes
      // 'processed' when the bank has taken it — which can be days — and it can
      // fail. This used to mark the job Refunded the moment the call returned,
      // so the customer was told their money was back while it had not moved
      // and might never.
      const recorded = refund.settled
        ? await storage.recordJobRefund(
            jobId,
            { refundId: refund.refundId, amountInCents: refund.amountInCents },
            { actor: `shop:${merchant.sub}` }
          )
        : await storage.recordRefundRequested(
            jobId,
            { refundId: refund.refundId, amountInCents: refund.amountInCents, status: refund.status },
            { actor: `shop:${merchant.sub}` }
          );

      return res.json({
        success: true,
        job: recorded.ok ? recorded.job : declined.job,
        refund: {
          issued: true,
          settled: refund.settled,
          status: refund.status,
          refundId: refund.refundId,
          amountInCents: refund.amountInCents,
        },
        // What the shop tells the customer. Saying "refunded" before the bank
        // has moved it is how a shop ends up arguing with someone holding a
        // statement that disagrees.
        message: refund.settled
          ? 'The job was declined and the customer has been refunded.'
          : 'The job was declined and a refund has been requested. It usually reaches the '
            + 'customer within a few working days; this screen updates when the bank confirms it.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Jobs waiting on a human decision (PRD 12).
   */
  app.get('/api/shops/:shopId/jobs/requires-action', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const jobs = await storage.getJobsRequiringAction(req.params.shopId, limit);
      return res.json({ jobs });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Sweep for jobs abandoned by a dead or disconnected agent (PRD 12, 13).
   * Runs automatically on a timer; exposed so it can also be triggered manually.
   */
  app.post('/api/admin/reclaim-stale-jobs', async (req: Request, res: Response) => {
    const admin = await authenticateAdmin(req, res);
    if (!admin) return;

    // This mutates print-job state across every shop on the platform, so it is
    // a write. The support role exists precisely to look without touching —
    // canWrite's own comment says so — and three sibling admin routes check it.
    if (!canWrite(admin.role)) {
      return res.status(403).json({ error: 'This account has read-only access.' });
    }

    try {
      const result = await storage.reclaimStaleJobs();
      return res.json({
        requeued: result.requeued.length,
        escalated: result.escalated.length,
        jobIds: result,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Regenerate a printer's QR code against the currently configured web URL.
   * Needed for printers registered while PUBLIC_WEB_URL was unset, whose posters
   * encode an unreachable localhost address.
   */
  app.post('/api/printers/:printerId/regenerate-qr', async (req: Request, res: Response) => {
    try {
      // Authorise before anything else. Checking configuration first told an
      // anonymous caller, through a 500, that the route existed and how it was
      // deployed — a signed-in check must come before any other answer.
      //
      // Regenerating invalidates every poster already printed and stuck to a
      // counter, so this has to be the shop's own decision.
      const ctx = await authorizePrinter(req, res, { requireOwner: true });
      if (!ctx) return;
      const printer = ctx.printer;

      const configuredWebUrl = process.env.PUBLIC_WEB_URL;
      if (!configuredWebUrl) {
        return res.status(500).json({
          error: 'PUBLIC_WEB_URL is not configured; regenerating would reproduce the same broken URL.',
        });
      }

      const baseUrl = configuredWebUrl.replace(/\/$/, '');
      const updated = await storage.regeneratePrinterQr(printer.id, baseUrl, generateQrCodeDataUrl);
      return res.json({ printer: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Issue a short-lived pairing code for a printer (PRD 7.1).
   * The shop owner reads this off the dashboard and enters it on the shop PC.
   */
  app.post('/api/printers/:printerId/pairing-code', async (req: Request, res: Response) => {
    try {
      // A pairing code is exchanged for a device token that can read this
      // shop's print jobs. Unauthenticated, this route was a complete
      // authentication bypass: a printer id off a QR poster was enough to pair
      // an attacker's own machine to the shop.
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;
      const printerId = ctx.printer.id;

      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
      await storage.createPairingCode(printerId, code, expiresAt);

      return res.status(201).json({
        code,
        printerId,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: Math.round(PAIRING_CODE_TTL_MS / 1000),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Pair an agent install and issue its device-scoped token (PRD 7.1, 7.2).
   * The token is returned exactly once; only its hash is stored.
   */
  app.post('/api/agent/pair', async (req: Request, res: Response) => {
    try {
      const { pairingCode, deviceName, osVersion, agentVersion } = req.body || {};
      if (!pairingCode) {
        return res.status(400).json({ error: 'pairingCode is required.' });
      }

      const normalized = normalizePairingCode(String(pairingCode));
      const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;

      const claimed = await storage.consumePairingCode(normalized, deviceId);
      if (!claimed) {
        await storage.recordSecurityEvent({
          type: 'PAIRING_REJECTED',
          severity: 'warning',
          detail: { reason: 'Unknown, expired or already-used pairing code.' },
        });
        // Deliberately vague: do not reveal which of the three it was.
        return res.status(401).json({ error: 'Pairing code is invalid or has expired. Generate a new one.' });
      }

      const printer = await storage.getPrinter(claimed.printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }

      const issued = issueDeviceToken();
      await storage.createAgentDevice({
        printerId: claimed.printerId,
        deviceId,
        tokenHash: issued.tokenHash,
        tokenExpiresAt: issued.expiresAt,
        deviceName,
        osVersion,
        agentVersion,
      });

      await storage.recordSecurityEvent({
        printerId: claimed.printerId,
        deviceId,
        type: 'PAIRED',
        severity: 'info',
        detail: { deviceName, osVersion, agentVersion },
      });

      return res.status(201).json({
        deviceId,
        // Shown once. The server keeps only the hash and cannot return it again.
        deviceToken: issued.token,
        tokenExpiresAt: issued.expiresAt.toISOString(),
        printerId: printer.id,
        shopId: printer.shopId,
        apiBaseUrl: process.env.API_BASE_URL || 'https://prinok-api.onrender.com',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Paired agent installs for a printer (PRD 7.1). */
  app.get('/api/printers/:printerId/devices', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const devices = await storage.listAgentDevices(ctx.printer.id);
      return res.json({ devices });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Revoke one agent install without re-keying the printer (PRD 7.2). */
  app.post('/api/printers/:printerId/devices/:deviceId/revoke', async (req: Request, res: Response) => {
    try {
      // Revoking stops a shop printing, so it must be the shop's own call.
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const { printerId, deviceId } = req.params;
      const device = await storage.getAgentDevice(deviceId);
      if (!device || device.printerId !== printerId) {
        return res.status(404).json({ error: 'Device not found for this printer.' });
      }

      const revoked = await storage.revokeAgentDevice(deviceId, req.body?.reason);

      await storage.recordSecurityEvent({
        printerId,
        deviceId,
        type: 'REVOKED',
        severity: 'warning',
        detail: { reason: req.body?.reason || 'unspecified' },
      });

      return res.json({ device: revoked });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Clears a revoked key from the list. Active keys must be revoked first. */
  app.delete('/api/printers/:printerId/devices/:deviceId', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const device = await storage.getAgentDevice(req.params.deviceId);
      if (!device || device.printerId !== ctx.printer.id) {
        return res.status(404).json({ error: 'Device not found for this printer.' });
      }
      if (!(await storage.deleteRevokedAgentDevice(device.id))) {
        return res.status(409).json({ error: 'Revoke this PC before removing it.' });
      }
      return res.status(204).end();
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /** Agent security audit trail for a printer (PRD 7.2). */
  app.get('/api/printers/:printerId/security-events', async (req: Request, res: Response) => {
    try {
      const ctx = await authorizePrinter(req, res);
      if (!ctx) return;

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const events = await storage.listSecurityEvents(ctx.printer.id, limit);
      return res.json({ events });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Download Windows Print Agent Executable / Release Package
   */
  app.get('/api/agent-installer', async (req: Request, res: Response) => {
    try {
      // What a shop gets by default is the installer for the desktop agent: an
      // app with a window, a tray icon and a pairing dialog, that starts with
      // Windows.
      //
      // It used to be WindowsPrintAgent.exe, the headless console build. A shop
      // owner clicked "Download agent", got a black terminal, and reasonably
      // asked where the application was. The desktop agent had been built and
      // published all along — this endpoint simply pointed at the wrong asset.
      //
      // The other builds stay available for the people who want them:
      //   ?format=console  the console .exe, for an unattended or scripted box
      //   ?format=zip      that .exe plus an appsettings template and a README
      //   ?format=portable the desktop agent with no installer
      const format = String(req.query.format || '').toLowerCase();

      const ASSETS: Record<string, string> = {
        '':         'PrintOkAgentSetup.exe',
        installer:  'PrintOkAgentSetup.exe',
        portable:   'PrintOkAgent.exe',
        console:    'WindowsPrintAgent.exe',
        zip:        'PrintAgent-win-x64.zip',
      };

      const assetName = ASSETS[format];
      if (!assetName) {
        return res.status(400).json({
          error: 'Unknown format. Use installer, portable, console or zip.',
        });
      }

      // An operator hosting their own build overrides the default download
      // only; the specific formats stay pinned to the published release so a
      // single custom URL cannot silently answer for all four.
      const customUrl = process.env.AGENT_INSTALLER_URL;
      if (customUrl && (format === '' || format === 'installer')) {
        return res.redirect(customUrl);
      }

      const githubRepo = process.env.PRINT_AGENT_REPO || 'Ayan-css/PrintOK';
      return res.redirect(
        `https://github.com/${githubRepo}/releases/download/latest/${assetName}`);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Customer Create Print Job Endpoint (Multi-Format Document Engine)
   */
  app.post('/api/print-jobs', async (req: Request, res: Response) => {
    try {
      const {
        printerId, fileName, fileBase64, copies, isColor, isDuplex, paperSize,
        customerName, customerPhone,
      } = req.body as CreatePrintJobDto;
      // Anything unrecognised becomes `auto` rather than a 400: an older page
      // that sends nothing must keep working, and "the way the document was
      // written" is the only safe reading of a value we cannot honour.
      const orientation = parseOrientation((req.body as CreatePrintJobDto).orientation);

      if (!printerId || !fileName || !fileBase64) {
        return res.status(400).json({ error: 'printerId, fileName, and fileBase64 are required.' });
      }

      const parsedCopies = parseCopies((req.body as any)?.copies);
      if ('error' in parsedCopies) {
        return res.status(400).json({ error: parsedCopies.error });
      }
      const copyCount = parsedCopies.value;

      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Target printer not found.' });
      }

      // Creating a job that is *already paid* is a claim that money changed
      // hands, and only the shop can make it — a customer handing over cash at
      // the counter, recorded by whoever took it.
      //
      // This used to default to true: `req.query.autoApprove !== 'false'`. So a
      // POST that merely omitted the parameter produced a Paid, Queued job and
      // printed it, with no authentication and no money, and printer ids are
      // public by design — they are on the QR poster. Opt-in now, and the
      // opt-in has to be authenticated.
      let autoApprove = false;
      if (req.query.autoApprove === 'true') {
        const merchant = await authenticateMerchant(req, res, { shopId: printer.shopId });
        if (!merchant) return; // responds 401/403 itself
        autoApprove = true;
      }

      // Customer identity, only if this shop asked for it.
      //
      // Read from the shop's config rather than trusted from the request: a
      // caller must not be able to attach a name and phone to a job at a shop
      // that never asked for one, because the privacy policy tells that shop's
      // customers nothing of the sort is collected.
      const portal = await storage.getShopPortalConfig(printer.shopId);
      const identity = readCustomerIdentity(portal, { customerName, customerPhone });
      if ('error' in identity) {
        return res.status(400).json({ error: identity.error });
      }

      // The shop only sells what it has switched on. Hiding a control on the
      // customer page is presentation; this is the part that actually stops a
      // colour job reaching a shop with a mono printer, whether it came from a
      // stale page, a cached one, or a script.
      const options = derivePortalOptions(
        portal.enabledServices,
        await storage.getShopRateCard(printer.shopId)
      );
      const unavailable = checkJobAgainstPortal(options, {
        isColor: !!isColor,
        isDuplex: !!isDuplex,
        paperSize: paperSize || 'A4',
        copies: copyCount,
        pageRange: (req.body as any)?.pageRange,
        orientation,
      });
      if (unavailable) {
        return res.status(400).json({ error: unavailable });
      }

      // The shop's plan has to cover this order. Checked before the document is
      // decoded, so a shop over its limit costs nothing to refuse.
      const allowance = await checkOrderAllowance(storage, printer.shopId);
      if (!allowance.allowed) {
        logOps('warn', 'plan.limit_reached', { shopId: printer.shopId, usage: allowance.usage });
        return res.status(402).json({ error: allowance.error, usage: allowance.usage });
      }

      // Multi-format document inspection & server-side page count verification
      const fileBuffer = Buffer.from(fileBase64, 'base64');

      // And the plan's file-size ceiling. The 50MB body limit is a platform
      // bound that applies to everyone; this is the one the shop is paying for.
      const shopPlan = await storage.getShopPlan(printer.shopId);
      const maxUpload = PLAN_MAX_UPLOAD_BYTES[shopPlan?.planTier ?? DEFAULT_PLAN_TIER] ?? PLAN_MAX_UPLOAD_BYTES.start;
      if (fileBuffer.length > maxUpload) {
        return res.status(402).json({
          error:
            `This file is ${(fileBuffer.length / (1024 * 1024)).toFixed(1)}MB, and this shop's plan ` +
            `accepts up to ${Math.round(maxUpload / (1024 * 1024))}MB. Ask the shop to upgrade, or ` +
            'send a smaller file.',
        });
      }
      const docResult = await processDocument(fileName, fileBuffer);

      if (!docResult.isSupported) {
        return res.status(400).json({ error: docResult.errorMessage });
      }

      // A page count that cannot be measured must not be charged for.
      //
      // Office formats reported a hardcoded one page, and that is the figure a
      // job is priced from — so a 500-page .docx was charged as one page while
      // the agent handed the whole thing to Word and printed all 500. The shop
      // paid for the other 499 sheets.
      //
      // Counting them honestly needs a layout engine: page breaks in a .docx
      // depend on fonts, margins and the printer's own paper size, so there is
      // no count to read out of the file. Until a controlled converter exists,
      // the job is refused with the one thing the customer can do about it.
      //
      // Keyed on the format rather than on pageCountVerified, deliberately. A
      // PDF whose cross-reference table is broken also comes back unverified,
      // and those arrive constantly from phone scanners and government
      // portals — for them there is still a count to recover by counting page
      // markers in the raw bytes, and a shop would rather print one for the
      // right money than turn the customer away. An Office file offers nothing
      // to recover a count from at all.
      if (UNMEASURABLE_FORMATS.has(docResult.format)) {
        return res.status(400).json({
          error:
            'This file type cannot be measured accurately, so it cannot be priced honestly — ' +
            'a long document would be charged as a single page. Please export it as a PDF and ' +
            'upload that instead. PDFs, JPGs, PNGs and WebP images all work.',
        });
      }

      // Tamper-proof page count override
      const verifiedPageCount = docResult.pageCount;

      // A page range was validated against the portal above and then thrown
      // away, so a customer who picked three pages of a fifty-page thesis was
      // quoted for three, charged for fifty, and handed fifty. Resolved against
      // the verified count — not the client's — so the number billed is the
      // number the agent is told to print.
      const requestedRange =
        typeof (req.body as any)?.pageRange === 'string' ? (req.body as any).pageRange.trim() : '';
      const selectedPages = parsePageRange(requestedRange, verifiedPageCount);
      if (selectedPages !== null && selectedPages.length === 0) {
        return res.status(400).json({
          error: `This document has ${verifiedPageCount} ${verifiedPageCount === 1 ? 'page' : 'pages'}, so that page selection prints nothing. Check the range.`,
        });
      }
      const chargeablePages = selectedPages ? selectedPages.length : verifiedPageCount;

      // "Print everything" queues the job before payment clears. That is a
      // shop choosing to print first and collect at the counter — and choosing
      // to eat the paper when someone walks away. It is not a default.
      //
      // Passed as its own flag rather than as autoApprove: that one marks the
      // payment settled, and reusing it here would record an unpaid job as Paid.
      const queueWithoutPayment = !autoApprove && portal.autoPrintMode === 'all';

      const job = await storage.createPrintJob(
        printerId,
        fileName,
        fileBase64,
        chargeablePages,
        copyCount,
        !!isColor,
        autoApprove,
        !!isDuplex,
        paperSize || 'A4',
        {
          ...identity.value,
          queueWithoutPayment,
          orientation,
          pageRange: selectedPages ? requestedRange : undefined,
          // The idempotency machinery existed and was never given a key from
          // this route, so it did nothing: a double-tapped Pay button, or a
          // retry after a flaky connection, created a second job and charged
          // for it. Taken from a header so the client owns the key and a retry
          // of the *same* submission reuses it, which is the only way it can
          // mean anything.
          idempotencyKey: readIdempotencyKey(req),
        }
      );

      // If job is immediately queued, push notification to active WebSocket agent
      if (job.printState === PrintState.Queued && wsServer) {
        wsServer.notifyJobQueued(job);
      }

      // The same projection as the status endpoint. The customer is the one
      // asking, and there is nothing here they need that it withholds.
      const shop = await storage.getShop(printer.shopId);
      const response = { job: customerJobView(job, shop) } as unknown as CreatePrintJobResponse;
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Heartbeat Endpoint
   */
  app.post('/api/agent/heartbeat', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      const { paperStatus } = req.body || {};
      const telemetry = await storage.recordHeartbeat(printer.id, paperStatus || 'OK');
      return res.json({ success: true, telemetry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * One-Click Manual Print Override (For offline cash payment / merchant override)
   */
  /**
   * Releases a job the shop was holding.
   *
   * Only for shops printing on their own say-so. A job in any other state is
   * refused rather than force-queued: "print this now" must not become a way to
   * push an unpaid or already-printing job through.
   */
  app.post('/api/shops/:shopId/jobs/:jobId/release', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res);
    if (!merchant) return;

    try {
      const { shopId, jobId } = req.params;
      const job = await storage.getPrintJob(jobId);
      if (!job || job.shopId !== shopId) {
        return res.status(404).json({ error: 'Job not found for this shop.' });
      }

      if (job.printState !== PrintState.HeldForRelease) {
        return res.status(409).json({
          error: `This job is ${job.printState}, not waiting to be released.`,
          job,
        });
      }

      const result = await storage.updateJobPrintState(jobId, PrintState.Queued, undefined, {
        actor: `shop:${merchant.sub}`,
      });
      if (!result.ok) {
        // NOT_FOUND carries no job; the union has already been narrowed above
        // by the explicit lookup, so this is the illegal-transition case.
        return res.status(409).json({ error: result.reason });
      }

      if (wsServer && result.job) wsServer.notifyJobQueued(result.job);
      return res.json({ job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/print-jobs/:id/manual-override', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // This asserts a merchant decision — "I took the cash" — and it used to
      // assert it with no authentication at all, hardcoding actor: 'shop' for a
      // caller it never identified. A customer always holds their own job id,
      // so any customer could approve their own unpaid job.
      //
      // Authenticated first, then the job is bound to that merchant's shop, in
      // that order: looking the job up first would tell an unauthenticated
      // caller whether a job id exists. Mirrors the /release sibling, which had
      // this right all along.
      const merchant = await authenticateMerchant(req, res);
      if (!merchant) return;

      const existing = await storage.getPrintJob(id);
      if (!existing || existing.shopId !== merchant.shopId) {
        return res.status(404).json({ error: 'Job not found for this shop.' });
      }

      const blocked = refusePaymentConfirmation(existing.paymentState);
      if (blocked) return res.status(409).json({ error: blocked });

      const result = await storage.confirmPaymentAndQueueJob(id, { actor: `shop:${merchant.sub}` });
      if (!result.ok) {
        const status = result.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }
      const job = result.job;
      await freezeCashLedger(job);

      if (wsServer) {
        wsServer.notifyJobQueued(job);
      }

      return res.json({ success: true, message: 'Job manually approved & queued for print.', job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  // ------------------------------------------------------------------------
  // Razorpay Route settlement
  //
  // Lifecycle, when Route is on and the order has a payee:
  //   payment captured → transfer of the shop's share, ON HOLD
  //   job printed      → hold released, Razorpay settles it to the shop
  //   job refunded     → transfer reversed first, then the customer refunded
  //
  // Every step is idempotent and recorded on the job. Nothing here runs while
  // RAZORPAY_ROUTE_ENABLED is not 'true', and nothing is ever inferred: a
  // transfer id is only written from Razorpay's answer or a signed webhook.
  // ------------------------------------------------------------------------

  const PRINTED_STATES = new Set<PrintState>([
    PrintState.Printed, PrintState.ReadyForCollection, PrintState.Completed,
  ]);

  /** Writes what Razorpay says about this job's transfer onto the job. */
  async function recordTransferSnapshot(job: PrintJob, t: TransferSnapshot, extra: Record<string, unknown> = {}) {
    // A late "processed" must not un-reverse a transfer we reversed.
    const status = job.transferReversalId && t.status === 'processed' ? job.transferStatus : t.status;
    await storage.updateJobRouteSettlement(job.id, {
      ...(job.transferId ? {} : { transferId: t.id }),
      ...(status ? { transferStatus: status } : {}),
      ...(t.settlementStatus !== undefined ? { transferSettlementStatus: t.settlementStatus } : {}),
      ...(t.onHold !== undefined ? { transferOnHold: t.onHold } : {}),
      ...(t.amount !== undefined ? { transferAmountCents: t.amount } : {}),
      ...(t.feesCents !== undefined ? { routeFeeCents: t.feesCents } : {}),
      ...(t.settlementStatus === 'settled' && !job.settledAt ? { settledAt: new Date().toISOString() } : {}),
      ...(t.status === 'failed'
        ? { transferFailureReason: t.errorDescription || 'Razorpay reported that the transfer failed.' }
        : {}),
      ...extra,
    });
  }

  /**
   * Transfers the shop's share of a captured payment to its linked account,
   * on hold until the job prints.
   *
   * Called from both the checkout confirmation and the payment webhook, which
   * routinely arrive within a second of each other. Idempotent three ways:
   * a job with a transfer is left alone; a transfer Razorpay already holds for
   * this payment and payee is adopted rather than duplicated; and creation is
   * claimed with a conditional write, so only one caller ever creates.
   *
   * The split uses the fee Razorpay actually charged on this payment, read
   * from the payment itself — never the published estimate.
   *
   * Never throws: a failure is recorded on the job and logged for a person,
   * and the next delivery of the payment webhook tries again.
   */
  async function settleRouteTransfer(jobId: string, via: string): Promise<void> {
    try {
      if (!routeService.isEnabled) return;
      const job = await storage.getPrintJob(jobId);
      if (!job || !job.payeeAccountId || !job.razorpayPaymentId || job.transferId) return;
      if (job.paymentState !== PaymentState.Paid) return;

      const existing = await routeService.getPaymentTransfers(job.razorpayPaymentId);
      if (!existing.ok) {
        logOps('warn', 'route.transfer_deferred', { jobId, via, reason: existing.error || 'could not list transfers' });
        return;
      }
      const already = existing.transfers.find((t) => t.recipient === job.payeeAccountId);
      if (already) {
        await recordTransferSnapshot(job, already);
        return;
      }

      if (!(await storage.claimRouteTransfer(job.id))) return; // another path is creating it

      const release = async (reason: string) => {
        await storage.updateJobRouteSettlement(job.id, { transferStatus: null, transferFailureReason: reason });
        logOps('error', 'route.transfer_failed', { jobId, shopId: job.shopId, via, reason, needsHuman: true });
      };

      const fetched = await routeService.fetchPayment(job.razorpayPaymentId);
      if (!fetched.ok) return release(fetched.error);
      const payment = fetched.payment;

      // The payment must be the one this job's order was opened for, for the
      // job's amount, and captured — checked against Razorpay's own record.
      if (payment.status !== 'captured') return release(`Payment is '${payment.status}', not captured.`);
      if (payment.orderId !== job.razorpayOrderId) return release('Payment does not belong to this job\'s order.');
      if (payment.amount !== job.totalPriceInCents) return release('Payment amount does not match the job total.');
      if (payment.feeCents === undefined) return release('Razorpay has not reported the fee on this payment yet.');

      // The same rate the fee ledger froze at confirmation.
      const plan = await storage.getShopPlan(job.shopId);
      const bps = job.commissionBpsUsed ?? plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS;
      const built = routeService.buildTransfer(
        job.payeeAccountId, job.totalPriceInCents, bps, payment.feeCents, job.id
      );
      if (built.transfer.amount < MIN_ORDER_AMOUNT_PAISE) {
        return release('The shop\'s share is below Razorpay\'s ₹1 transfer minimum; settle it manually.');
      }

      // Already printed (a late webhook, or print-before-payment): no reason to hold.
      if (PRINTED_STATES.has(job.printState)) built.transfer.on_hold = false;

      const created = await routeService.createPaymentTransfer(job.razorpayPaymentId, built.transfer);
      if (!created.ok) return release(created.error);

      await recordTransferSnapshot(job, created.transfer, {
        transferAmountCents: built.transfer.amount,
        serviceFeeCents: built.serviceFeeCents,
        transferFailureReason: null,
      });
      // The ledger now holds the real gateway fee, not the estimate.
      await freezeFeeLedger(storage, job, bps, { feeCents: payment.feeCents, taxCents: payment.taxCents });

      logOps('info', 'route.transfer_created', {
        jobId, shopId: job.shopId, via, transferId: created.transfer.id,
        amountCents: built.transfer.amount, onHold: built.transfer.on_hold,
      });
    } catch (err: any) {
      logOps('error', 'route.transfer_failed', { jobId, via, reason: err?.message || String(err), needsHuman: true });
    }
  }

  /** Releases a held transfer once the job has printed. Idempotent; never throws. */
  async function releaseRouteTransfer(jobId: string): Promise<void> {
    try {
      if (!routeService.isEnabled) return;
      const job = await storage.getPrintJob(jobId);
      if (!job?.transferId || job.transferReversalId || job.transferOnHold === false) return;
      if (!PRINTED_STATES.has(job.printState)) return;

      const released = await routeService.releaseTransfer(job.transferId);
      if (!released.ok) {
        logOps('error', 'route.release_failed', { jobId, transferId: job.transferId, reason: released.error, needsHuman: true });
        return;
      }
      if (released.transfer) await recordTransferSnapshot(job, released.transfer);
      await storage.updateJobRouteSettlement(job.id, {
        transferOnHold: false, transferReleasedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      logOps('error', 'route.release_failed', { jobId, reason: err?.message || String(err), needsHuman: true });
    }
  }

  /**
   * Pulls the shop's share back before a refund, so the customer is not
   * refunded out of PrintOk's own money while the shop keeps its share.
   *
   * Once only: the reversal is claimed with a conditional write and its id
   * recorded, so a retried decline cannot reverse the same transfer twice.
   */
  async function reverseRouteTransfer(job: PrintJob, reason: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!job.transferId || job.transferReversalId) return { ok: true };
    if (!routeService.isEnabled) {
      return { ok: false, error: 'Route is switched off, so the transfer must be reversed from the Razorpay dashboard.' };
    }

    if (!(await storage.claimTransferReversal(job.id))) {
      const fresh = await storage.getPrintJob(job.id);
      return fresh?.transferReversalId
        ? { ok: true }
        : { ok: false, error: 'A reversal of this transfer is already in progress.' };
    }

    const reversed = await routeService.reverseTransfer(job.transferId, { jobId: job.id, reason: reason.slice(0, 200) });
    if (!reversed.ok) {
      await storage.updateJobRouteSettlement(job.id, {
        transferStatus: job.transferStatus ?? null, transferFailureReason: `Reversal failed: ${reversed.error}`,
      });
      logOps('error', 'route.reversal_failed', { jobId: job.id, transferId: job.transferId, reason: reversed.error, needsHuman: true });
      return { ok: false, error: reversed.error };
    }

    await storage.updateJobRouteSettlement(job.id, {
      transferReversalId: reversed.reversalId,
      transferReversedAt: new Date().toISOString(),
      transferStatus: 'reversed',
      transferOnHold: false,
    });
    logOps('info', 'route.transfer_reversed', { jobId: job.id, transferId: job.transferId, reversalId: reversed.reversalId });
    return { ok: true };
  }

  /**
   * Create Razorpay Payment Order Endpoint
   */
  app.post('/api/payments/create-order', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ error: 'jobId is required.' });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // A job that is already paid must not be charged twice.
      if (job.paymentState === PaymentState.Paid) {
        return res.status(409).json({ error: 'This job has already been paid for.' });
      }

      const refused = refusePaymentConfirmation(job.paymentState);
      if (refused) return res.status(409).json({ error: refused });

      // Opening checkout twice for the same unchanged job reuses the order it
      // already has, rather than minting a second one.
      //
      // This endpoint needs no session — a customer has none — so without reuse
      // a second call would overwrite the order id the job is bound to, and a
      // customer who had already opened checkout would find their genuine
      // payment refused as belonging to a different order. Razorpay keeps an
      // unpaid order payable, so handing the same one back is also what a retry
      // after a declined card should do.
      // The payee is the shop this job's printer belongs to, read from the
      // database. Nothing in the request can name a different shop.
      const shop = await storage.getShop(job.shopId);
      if (!shop) {
        return res.status(404).json({ error: 'The shop for this order no longer exists.' });
      }
      // Who the customer is paying, returned so checkout can say so.
      const payee = { shopName: shop.name };

      if (job.razorpayOrderId && job.razorpayOrderAmountCents === job.totalPriceInCents) {
        return res.json({
          orderId: job.razorpayOrderId,
          amountInCents: job.razorpayOrderAmountCents,
          currency: 'INR',
          keyId: razorpayService.publishableKeyId,
          isSimulated: !razorpayService.isConfigured,
          payee,
        });
      }

      // Razorpay refuses anything under a rupee. A shop's own rate card can
      // produce such a job, and without this the customer meets a gateway error
      // at the moment they try to pay, with no way to tell what went wrong.
      if (job.totalPriceInCents < MIN_ORDER_AMOUNT_PAISE) {
        return res.status(400).json({
          error:
            'This job is below the ₹1 minimum a card or UPI payment can be taken for. ' +
            'Please pay at the counter instead.',
        });
      }

      // The linked account this order's money is for, snapshotted now, so a
      // shop that relinks later cannot re-point orders already taken. Only
      // while Route is on and Razorpay has activated the shop's account;
      // otherwise the order settles to PrintOk as it always has.
      const payeeAccountId =
        routeService.isEnabled && shop.razorpayAccountId && shop.razorpayAccountStatus === 'activated'
          ? shop.razorpayAccountId
          : undefined;

      // Always the server's job total. No split is attached to the order: the
      // shop's share is transferred from the captured payment, once Razorpay
      // has reported the fee it actually charged. See settleRouteTransfer.
      const orderResult = await razorpayService.createOrder(
        jobId, job.totalPriceInCents, { shopId: shop.id, shopName: shop.name }
      );

      // Recorded before the id is handed to the browser, because this is the
      // only thing a later confirmation can be checked against. Previously the
      // gateway order id was returned and forgotten, so /verify had nothing to
      // bind a claimed payment to and accepted any real payment for any job.
      await storage.attachGatewayOrder(job.id, orderResult.orderId, orderResult.amountInCents, payeeAccountId);

      return res.json({ ...orderResult, payee });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Confirms a payment that Razorpay Checkout reported as successful.
   *
   * The browser cannot be trusted to say "I paid", so the signature Razorpay
   * returns is verified against our key secret before the job is queued. The
   * webhook remains the authoritative backstop if the browser never reaches
   * this endpoint.
   */
  app.post('/api/payments/verify', async (req: Request, res: Response) => {
    try {
      const { jobId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};

      if (!jobId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({
          error: 'jobId, razorpayOrderId, razorpayPaymentId and razorpaySignature are required.',
        });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // A refunded or cancelled order is not confirmable, however valid the
      // signature. The signature never expires, so without this a retained
      // confirmation resurrects a refunded job into the revenue figures.
      const blocked = refusePaymentConfirmation(job.paymentState);
      if (blocked) return res.status(409).json({ error: blocked });

      // Replayed confirmation for an already-paid job is a success, not an
      // error — but only when it is the *same* payment. A different payment
      // arriving for a settled job is a replay attempt, not a retry.
      if (job.paymentState === PaymentState.Paid) {
        if (job.razorpayPaymentId && job.razorpayPaymentId !== String(razorpayPaymentId)) {
          return res.status(409).json({ error: 'This order is already settled by a different payment.' });
        }
        return res.json({ success: true, message: 'Payment already confirmed.', job });
      }

      const valid = razorpayService.verifyCheckoutSignature(
        String(razorpayOrderId), String(razorpayPaymentId), String(razorpaySignature)
      );
      if (!valid) {
        return res.status(400).json({ error: 'Payment signature could not be verified.' });
      }

      // The signature proves Razorpay issued this (order, payment) pair. It says
      // nothing about *which job* the order was for — the signed message is
      // "<order_id>|<payment_id>" and carries no job reference. So a genuine ₹1
      // payment for one job used to confirm any other job at any shop, for any
      // amount, as many times as it was replayed.
      //
      // The binding is the stored order id: we minted that order for this job
      // and recorded it at /create-order. Signature plus order id together are
      // what tie a payment to a job; neither alone does.
      if (!job.razorpayOrderId) {
        return res.status(409).json({
          error: 'No payment order has been opened for this job. Start the payment again.',
        });
      }
      if (job.razorpayOrderId !== String(razorpayOrderId)) {
        return res.status(400).json({ error: 'That payment belongs to a different order.' });
      }

      // The order was opened for the job's total. If the two now disagree the
      // job was re-priced after checkout opened, and settling it at the older
      // figure would charge the wrong amount.
      if (
        job.razorpayOrderAmountCents !== undefined &&
        job.razorpayOrderAmountCents !== job.totalPriceInCents
      ) {
        return res.status(409).json({
          error: 'This order was re-priced after payment started. Start the payment again.',
        });
      }

      // Burns the payment id. Enforced by a unique index, so the same payment
      // cannot settle a second job even if two confirmations race.
      const claim = await storage.claimGatewayPayment(job.id, String(razorpayPaymentId));
      if (!claim.ok) {
        logOps('warn', 'payment.replay_blocked', {
          jobId: job.id, shopId: job.shopId, reason: claim.reason,
        });
        return res.status(409).json({ error: claim.reason || 'That payment cannot be used for this order.' });
      }

      // Last, and only when live: ask the gateway what it thinks. This catches a
      // payment that was authorised but never captured, which the signature
      // alone cannot distinguish. Skipped without credentials, where the local
      // binding above is already decisive.
      if (razorpayService.isConfigured) {
        const gateway = await razorpayService.confirmOrderPaidForJob(
          String(razorpayOrderId), job.id, job.totalPriceInCents
        );
        if (!gateway.ok) {
          return res.status(400).json({ error: gateway.error });
        }
      }

      const result = await storage.confirmPaymentAndQueueJob(jobId, {
        actor: 'customer',
        detail: { paymentRef: String(razorpayPaymentId), provider: 'razorpay' },
      });

      if (result.ok) {
        // The browser confirmation carries no fee figures — only the webhook
        // does — so this records the estimate and marks it as one. The webhook
        // overwrites it with the real numbers when it arrives.
        const plan = await storage.getShopPlan(result.job.shopId);
        await freezeFeeLedger(storage, result.job, plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS);

        logOps('info', 'payment.confirmed', {
          jobId: result.job.id, shopId: result.job.shopId,
          grossCents: result.job.totalPriceInCents, via: 'checkout',
        });

        // Transfers the shop's share when Route is on; a no-op otherwise.
        await settleRouteTransfer(result.job.id, 'checkout');
      }
      if (!result.ok) {
        const status = result.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: result.reason });
      }

      if (wsServer) wsServer.notifyJobQueued(result.job);

      // The customer's projection, with the shop they paid. The raw row carries
      // other customers' concerns — storage keys, the shop's fee ledger.
      const shopForView = await storage.getShop(result.job.shopId);
      return res.json({ success: true, job: customerJobView(result.job, shopForView) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Payment Webhook Endpoint (HMAC SHA256 Signature Verification)
   */
  /**
   * The only Razorpay events that mean the customer's money has actually been
   * taken. Anything else — a failure, an authorization, a refund — must never
   * queue a job for printing.
   */
  const PAYMENT_CONFIRMING_EVENTS = new Set(['payment.captured', 'order.paid']);

  /**
   * A shop's plan follows its Razorpay subscription.
   *
   * `activated` switches the shop to the tier in the subscription's notes and
   * cancels whatever subscription it replaces. `charged` only re-affirms the
   * current one, so a late charge on a replaced subscription cannot switch the
   * shop back. Losing the current subscription drops the shop to Free.
   */
  async function applySubscriptionEvent(event: string, sub: any) {
    const shopId = sub?.notes?.shopId;
    const plan = shopId ? await storage.getShopPlan(shopId) : undefined;
    if (!sub?.id || !plan) return { success: true, ignored: event };

    const isCurrent = sub.id === plan.razorpaySubscriptionId;

    if (event === 'subscription.activated' || (event === 'subscription.charged' && isCurrent)) {
      const target = getPlan(sub.notes.tier);
      if (!target || target.monthlyPriceCents === 0) return { success: true, ignored: event };
      // The replacement is live, so the old plan ends now rather than at its
      // period end — otherwise the shop is billed for two plans at once.
      if (plan.razorpaySubscriptionId && !isCurrent) {
        await razorpayService.cancelSubscription(plan.razorpaySubscriptionId, { atCycleEnd: false });
      }
      await storage.updateShopPlan(shopId, {
        planTier: target.tier,
        commissionBps: target.platformFeeBps,
        planStatus: 'active',
        razorpaySubscriptionId: sub.id,
      });
      logOps('info', 'plan.limit_reached', { shopId, to: target.tier, action: 'subscription_active' });
      return { success: true, applied: target.tier };
    }

    if (isCurrent && ['subscription.halted', 'subscription.cancelled', 'subscription.completed'].includes(event)) {
      const free = getPlan(DEFAULT_PLAN_TIER)!;
      await storage.updateShopPlan(shopId, {
        planTier: free.tier,
        commissionBps: free.platformFeeBps,
        planStatus: 'active',
        razorpaySubscriptionId: null,
      });
      logOps('warn', 'plan.limit_reached', { shopId, to: free.tier, action: event });

      // The owner is not on the page when a renewal fails, so tell them.
      const shop = await storage.getShop(shopId);
      if (shop?.ownerEmail) {
        const lost = getPlan(sub.notes?.tier)?.name || 'paid';
        const notice = await emailService.send({
          to: shop.ownerEmail,
          subject: `Your PrintOk ${lost} plan has ended`,
          text:
            `Hello ${shop.name},\n\n` +
            (event === 'subscription.halted'
              ? `Razorpay could not collect the monthly payment for your ${lost} plan after several attempts, `
              : `The Razorpay subscription for your ${lost} plan was ${event === 'subscription.completed' ? 'completed' : 'cancelled'}, `) +
            `so your shop is now on the Free plan. Nothing has been removed.\n\n` +
            'To go back, open your dashboard, go to Revenue Analytics and choose the plan again.\n',
        });
        if (!notice.ok) logOps('error', 'email.failed', { reason: 'plan ended notice', shopId });
      }
      return { success: true, applied: free.tier };
    }

    return { success: true, ignored: event };
  }

  /**
   * transfer.processed / transfer.failed (and any other transfer.* event).
   *
   * Applied only to the job the transfer is already recorded against — or,
   * when the webhook beats our own recording, to the job named in its notes
   * provided the transfer's source is that job's payment and its recipient is
   * that job's snapshotted payee. Anything else is acknowledged and ignored:
   * a signed but unrecognised transfer must not move any order's money state.
   */
  async function applyTransferEvent(event: string, entity: any) {
    const t = toTransferSnapshot(entity);
    if (!t) return { success: true, ignored: event, message: 'No transfer in this delivery.' };

    let job = await storage.getJobByTransferId(t.id);
    if (!job && t.notes?.jobId) {
      const candidate = await storage.getPrintJob(String(t.notes.jobId));
      if (candidate && !candidate.transferId) job = candidate;
    }
    if (!job) {
      logOps('warn', 'route.webhook_rejected', { event, transferId: t.id, reason: 'no matching job' });
      return { success: true, ignored: event, message: 'Transfer does not match any order.' };
    }
    if (!job.payeeAccountId || t.recipient !== job.payeeAccountId ||
        !job.razorpayPaymentId || (t.source && t.source !== job.razorpayPaymentId)) {
      logOps('error', 'route.webhook_rejected', {
        event, transferId: t.id, jobId: job.id, reason: 'recipient or source does not match the order', needsHuman: true,
      });
      return { success: true, ignored: event, message: 'Transfer does not match this order.' };
    }

    await recordTransferSnapshot(job, t);
    if (event === 'transfer.failed') {
      logOps('error', 'route.transfer_failed', {
        jobId: job.id, shopId: job.shopId, transferId: t.id, reason: t.errorDescription || 'transfer.failed', needsHuman: true,
      });
    }
    // A job that printed before its transfer was confirmed is released now;
    // releaseRouteTransfer does nothing for one that is not printed or held.
    if (event === 'transfer.processed') await releaseRouteTransfer(job.id);
    return { success: true, applied: event, jobId: job.id };
  }

  /**
   * product.route.* — Razorpay's review of a shop's linked account. The
   * activation_status is stored verbatim, with any requirements it lists.
   */
  async function applyRouteProductEvent(event: string, body: any) {
    const product = body?.payload?.merchant_product?.entity;
    const accountId = String(body?.account_id || product?.merchant_id || '');
    const shop = accountId ? await storage.getShopByRazorpayAccountId(accountId) : undefined;
    if (!shop) {
      logOps('warn', 'route.webhook_rejected', { event, accountId, reason: 'no shop with this linked account' });
      return { success: true, ignored: event, message: 'Linked account does not match any shop.' };
    }
    if (shop.razorpayProductId && product?.id && product.id !== shop.razorpayProductId) {
      logOps('error', 'route.webhook_rejected', { event, accountId, reason: 'product id mismatch', needsHuman: true });
      return { success: true, ignored: event, message: 'Product does not match this shop.' };
    }

    const status = String(product?.activation_status || event.replace('product.route.', ''));
    const requirements = body?.payload?.merchant_product?.data?.requirements;
    await storage.updateShopRazorpayAccount(shop.id, {
      status,
      ...(product?.id ? { productId: String(product.id) } : {}),
      requirements: Array.isArray(requirements) ? requirements : null,
      error: null,
    });
    logOps('info', 'route.account_updated', { shopId: shop.id, status });
    return { success: true, applied: event, status };
  }

  app.post('/api/payments/webhook', async (req: Request, res: Response) => {
    try {
      // Razorpay sends its signature in a header and its job reference inside
      // the payment entity's notes. The older flat body shape is still accepted
      // so existing callers keep working - both go through the same real
      // signature check.
      // Razorpay signs the raw body and sends the digest in this header. A
      // signature carried inside the body cannot cover itself, so the header is
      // the only accepted source.
      const signature = req.headers['x-razorpay-signature'] as string | undefined;
      const body = req.body || {};

      // Every delivery is authenticated before anything in it is read for
      // meaning — over the exact bytes Razorpay sent.
      const rawBody = (req as any).rawBody || JSON.stringify(body);
      if (!signature || !razorpayService.verifyWebhookSignature(rawBody, signature)) {
        return res.status(400).json({ error: 'Invalid HMAC payment webhook signature.' });
      }

      const event: string | undefined = typeof body.event === 'string' ? body.event : undefined;

      // Razorpay always names the event. A body without one was an older flat
      // shape ({ jobId, paymentId }) that carried no order id or amount, so it
      // could not be bound to the order a job opened — which is exactly the
      // check that makes a confirmation trustworthy. It is no longer accepted.
      if (!event) {
        return res.status(400).json({ error: 'Unsupported webhook payload: no event.' });
      }

      // Deduplicated on the gateway's own event id — after the signature
      // check, so an unauthenticated caller cannot fill this table or suppress
      // a real delivery by guessing an id.
      const eventId = req.headers['x-razorpay-event-id'] as string | undefined;

      // Plan billing. Carries a subscription entity, not a job.
      if (event.startsWith('subscription.')) {
        return res.json(await applySubscriptionEvent(event, body?.payload?.subscription?.entity));
      }

      // Route: transfers of a shop's share, and Razorpay's review of its account.
      if (event.startsWith('transfer.') || event.startsWith('product.route.') || event.startsWith('settlement.')) {
        if (eventId && !(await storage.markWebhookEventProcessed(eventId, event))) {
          return res.json({ success: true, message: 'This delivery has already been processed.' });
        }
        if (event.startsWith('transfer.')) {
          return res.json(await applyTransferEvent(event, body?.payload?.transfer?.entity));
        }
        if (event.startsWith('product.route.')) {
          return res.json(await applyRouteProductEvent(event, body));
        }
        // settlement.* describes a linked account's bank settlement as a whole,
        // not any one order; transfers carry their own settlement_status.
        return res.json({ success: true, ignored: event });
      }

      // A refund delivery carries a refund entity rather than a payment one, and
      // its own notes — set when the refund was requested.
      const refundEntity = body?.payload?.refund?.entity;

      const paymentEntity = body?.payload?.payment?.entity;
      const orderEntity = body?.payload?.order?.entity;

      const jobId =
        paymentEntity?.notes?.jobId ||
        orderEntity?.notes?.jobId ||
        refundEntity?.notes?.jobId;

      const paymentRef = paymentEntity?.id || refundEntity?.payment_id;

      if (!jobId) {
        return res.status(400).json({ error: 'A job reference is required.' });
      }

      // Which event this is decides whether money actually arrived. Nothing
      // checked it before: every signed webhook carrying a job reference was
      // treated as a confirmation, and `payment.failed` carries the same
      // payment entity and the same notes as `payment.captured`. With that
      // event subscribed, a declined card marked the job paid and sent it to
      // the printer — the customer got their document and nobody was charged.
      //

      // Refund lifecycle. A refund is created 'pending' and becomes 'processed'
      // when the bank has actually taken the money, days later — or it fails.
      // Neither outcome was handled at all, so a job sat in RefundPending for
      // ever whichever way it went, and nothing ever told the customer.
      if (event === 'refund.processed' || event === 'refund.failed') {
        const refundId = refundEntity?.id ? String(refundEntity.id) : '';
        const amount = Number(refundEntity?.amount);

        const refundJob = await storage.getPrintJob(jobId);
        if (!refundJob) return res.status(404).json({ error: 'Print job not found.' });

        if (event === 'refund.processed') {
          const settled = await storage.recordJobRefund(
            jobId,
            {
              refundId: refundId || refundJob.refundId || '',
              amountInCents: Number.isFinite(amount) ? amount : (refundJob.refundAmountCents || refundJob.totalPriceInCents),
            },
            { actor: 'webhook' }
          );

          // 200 either way: a refund that was already recorded is not a
          // failure Razorpay can fix by resending.
          return res.json({
            success: true,
            message: settled.ok
              ? 'Refund settled.'
              : `Refund already recorded (${settled.reason}).`,
          });
        }

        const failed = await storage.recordRefundFailed(jobId, refundId, { actor: 'webhook' });
        // The customer has no document and no money back. Nothing else in this
        // system needs a person more urgently than this does.
        logOps('error', 'refund.failed', {
          jobId, refundId: refundId || null, shopId: refundJob.shopId, needsHuman: true,
        });
        return res.json({
          success: true,
          message: failed.ok
            ? 'Refund failure recorded; the payment stands and needs attention.'
            : `Refund failure could not be applied (${failed.reason}).`,
        });
      }

      if (!PAYMENT_CONFIRMING_EVENTS.has(event)) {
        // Answered 200 deliberately: a non-2xx makes Razorpay retry the same
        // event for hours, and this one was understood — it just is not a
        // payment.
        console.log(`[Webhook] Ignoring '${event}' for job ${jobId}: not a payment confirmation.`);
        return res.json({
          success: true,
          ignored: event,
          message: 'Event acknowledged; it does not confirm a payment.',
        });
      }

      // Deduplicated on the gateway's own event id, after the signature check
      // so an unauthenticated caller cannot fill this table or suppress a real
      // delivery by guessing an id.
      //
      // "Have we acted on this delivery" and "is this job already paid" are
      // different questions, and the code below used to answer the first with
      // the second. A refund landing between a delivery and its retry made the
      // second answer "no", so the retry walked a refunded job back to Paid.
      if (eventId) {
        const first = await storage.markWebhookEventProcessed(eventId, event, jobId);
        if (!first) {
          return res.json({ success: true, message: 'This delivery has already been processed.' });
        }
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // A refunded or cancelled order is not confirmable. Answered 200 so
      // Razorpay stops retrying: the delivery was understood and deliberately
      // not applied, which is not a failure it can fix by sending it again.
      const blocked = refusePaymentConfirmation(job.paymentState);
      if (blocked) {
        console.warn(
          `[Webhook] Refused '${event || 'legacy'}' for job ${jobId}: ${blocked}`
        );
        return res.json({ success: true, ignored: event, message: blocked });
      }

      // The notes name a job, but notes alone prove nothing about money. The
      // payment must be for the gateway order this job opened, and for exactly
      // what that order was opened for — which is the job's total. A signed
      // delivery that fails either is acknowledged (resending will not change
      // it) and left for a person, never applied.
      const gatewayOrderId = paymentEntity?.order_id || orderEntity?.id;
      const paidAmount = Number(paymentEntity?.amount ?? orderEntity?.amount_paid);
      const mismatch =
        !job.razorpayOrderId ? 'no payment order was opened for this job'
        : gatewayOrderId !== job.razorpayOrderId ? 'the payment belongs to a different order'
        : paidAmount !== job.razorpayOrderAmountCents || paidAmount !== job.totalPriceInCents
          ? 'the amount paid does not match the order total'
        : undefined;
      if (mismatch) {
        logOps('error', 'payment.webhook_mismatch', {
          jobId, event, paymentRef, reason: mismatch, needsHuman: true,
        });
        return res.json({ success: true, ignored: event, message: `Not applied: ${mismatch}.` });
      }

      // Already paid — usually because the checkout confirmation got here
      // first. That path only knows the published fee estimate; this delivery
      // carries what Razorpay actually charged, so the ledger is trued up here,
      // and a Route transfer the checkout path could not make is retried.
      if (job.paymentState === PaymentState.Paid) {
        if (paymentRef && job.razorpayPaymentId === String(paymentRef)) {
          if (Number.isFinite(Number(paymentEntity?.fee))) {
            const plan = await storage.getShopPlan(job.shopId);
            await freezeFeeLedger(
              storage, job, job.commissionBpsUsed ?? plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS,
              { feeCents: paymentEntity?.fee, taxCents: paymentEntity?.tax }
            );
          }
          await settleRouteTransfer(job.id, 'webhook');
        }
        return res.json({ success: true, message: 'Payment already processed.', job: customerJobView(job) });
      }

      // Records which gateway payment settled the job, the same way the browser
      // path does, so the ledger is complete whichever path confirmed it. A
      // payment already held by another job loses here rather than being
      // silently attached to a second one.
      if (paymentRef) {
        const claim = await storage.claimGatewayPayment(jobId, String(paymentRef));
        if (!claim.ok) {
          console.warn(`[Webhook] Refused '${event || 'legacy'}' for job ${jobId}: ${claim.reason}`);
          return res.json({ success: true, ignored: event, message: claim.reason });
        }
      }

      const paymentResult = await storage.confirmPaymentAndQueueJob(jobId, {
        actor: 'webhook',
        detail: { paymentRef },
      });

      if (paymentResult.ok) {
        // This is the only place the real numbers arrive. Razorpay puts `fee`
        // and `tax` on the captured payment entity, and `fee` is inclusive of
        // `tax`.
        const plan = await storage.getShopPlan(paymentResult.job.shopId);
        await freezeFeeLedger(storage, paymentResult.job, plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS, {
          feeCents: paymentEntity?.fee,
          taxCents: paymentEntity?.tax,
        });
        await settleRouteTransfer(paymentResult.job.id, 'webhook');
      }
      if (!paymentResult.ok) {
        const status = paymentResult.code === 'NOT_FOUND' ? 404 : 409;
        return res.status(status).json({ error: paymentResult.reason });
      }
      const updatedJob = paymentResult.job;

      // Instant push notification over WebSocket
      if (wsServer) {
        wsServer.notifyJobQueued(updatedJob);
      }

      return res.json({ success: true, message: 'Payment confirmed & job queued.', job: customerJobView(updatedJob) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Print Job Status by Job ID
   */
  app.get('/api/print-jobs/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const job = await storage.getPrintJob(id);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }
      // Projected, not returned whole: this endpoint has no authentication, so
      // the job id must not be authority over the customer's PII or their
      // document. See customerJobView.
      return res.json({ job: customerJobView(job, await storage.getShop(job.shopId)) });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Polling Endpoint
   */
  /** A cash order's fee, fixed at the shop's rate today. Razorpay took nothing. */
  async function freezeCashLedger(job: PrintJob) {
    const plan = await storage.getShopPlan(job.shopId);
    await freezeFeeLedger(storage, job, plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS, { feeCents: 0, taxCents: 0 });
  }

  /**
   * Cash orders waiting at this printer's counter, for the desktop agent's
   * approve/reject prompt. A cash order is one awaiting payment that never
   * opened online checkout; anything older than a day is left to the dashboard.
   */
  async function pendingCashJobs(identity: { printerId: string; shopId: string }) {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return (await storage.getRecentJobsForShop(identity.shopId, 200)).filter((j) =>
      j.printerId === identity.printerId && j.printState === PrintState.AwaitingPayment &&
      !j.razorpayOrderId && new Date(j.createdAt).getTime() >= since);
  }

  app.get('/api/agent/cash-jobs', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const jobs = (await pendingCashJobs(identity)).map((j) => ({
        id: j.id, tokenNumber: j.tokenNumber, fileName: j.fileName, pageCount: j.pageCount,
        copies: j.copies, totalPriceInCents: j.totalPriceInCents, customerName: j.customerName,
      }));
      return res.json({ jobs });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/cash-jobs/:id/:decision(approve|reject)', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      if (!(await pendingCashJobs(identity)).some((j) => j.id === req.params.id)) {
        return res.status(404).json({ error: 'No cash order with that id is waiting at this printer.' });
      }

      const actor = `agent:${identity.deviceId || identity.printerId}`;
      const result = req.params.decision === 'approve'
        ? await storage.confirmPaymentAndQueueJob(req.params.id, { actor })
        : await storage.declineJob(req.params.id, 'Declined at the counter.', { actor });
      if (!result.ok) return res.status(409).json({ error: result.reason });

      if (req.params.decision === 'approve') {
        await freezeCashLedger(result.job);
        if (wsServer) wsServer.notifyJobQueued(result.job);
      }
      return res.json({ success: true, job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/jobs/pending', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      // Claim each job for the calling device before handing it over. The job
      // moves Queued -> Assigned, so a second agent polling concurrently is told
      // the job is taken rather than printing it a second time (PRD 11).
      const deviceId = identity.deviceId || (req.headers['x-agent-device-id'] as string) || printer.id;
      const pendingJobs = await storage.getPendingJobsForPrinter(printer.id);

      // Whether a separator sheet belongs in front of these jobs, decided once
      // against the depth of the queue as it stood before anything was claimed.
      //
      // Deciding per job after claiming would compare against a queue this very
      // loop is draining, so the first job in a rush would get a separator and
      // the last would not — which is the wrong way round.
      const portal = await storage.getShopPortalConfig(printer.shopId);
      const separator = shouldPrintSeparator(portal, pendingJobs.length)
        ? portal.separatorMode
        : 'none';

      const claimedJobs = [];
      for (const job of pendingJobs) {
        const claim = await storage.assignJobToDevice(job.id, deviceId);
        if (!claim.ok) continue;

        // The document link is minted here, for this authenticated agent, and
        // expires in minutes. It used to be generated once at upload and stored
        // on the job row, which made the row itself a standing bearer token for
        // a customer's file for an hour.
        const fileUrl = await storage.createJobDownloadUrl(claim.job.id);
        if (!fileUrl) {
          // Nothing to print: the document is gone. Said out loud rather than
          // handing the agent a link to nothing and letting it fail as a
          // checksum mismatch.
          await storage.updateJobPrintState(
            claim.job.id, PrintState.RequiresShopAction,
            'The stored document is no longer available, so this job cannot be printed.',
            { actor: 'system' }
          );
          continue;
        }

        claimedJobs.push({ ...claim.job, fileUrl });
      }

      const response: AgentPollResponse = { jobs: claimedJobs, separator };
      return res.json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Update Status Endpoint
   */
  app.post('/api/agent/jobs/:id/status', async (req: Request, res: Response) => {
    try {
      const identity = await authenticateAgent(storage, req, res);
      if (!identity) return;
      const printer = { id: identity.printerId, shopId: identity.shopId };

      const { id } = req.params;
      const { printState, errorMessage } = req.body as AgentUpdateStatusDto;
      const deviceId = identity.deviceId || (req.headers['x-agent-device-id'] as string) || printer.id;

      // The job must belong to the printer this agent authenticated as.
      // Without this an agent in one shop could drive another shop's jobs to
      // Printed or Failed — including marking a paid job printed that was never
      // printed. 404 rather than 403, so job ids cannot be probed.
      const target = await storage.getPrintJob(id);
      if (!target || target.printerId !== printer.id) {
        return res.status(404).json({ error: 'Job not found for this printer.' });
      }

      // And it must belong to the device reporting on it, not merely to the
      // printer. This checked the printer only and then overwrote target.deviceId
      // with whoever was calling, so a second or stale credential for the same
      // printer could drive another device's job straight to Completed — which
      // purges the document, with no refund, because Completed is not Cancelled.
      // The customer paid and got nothing.
      //
      // assignJobToDevice already enforces exclusive per-device claims, so the
      // concept existed and was simply not applied on the way back.
      //
      // An unclaimed job is allowed through: the legacy shared-key agents have
      // no device id of their own, and a job they were handed by polling is
      // theirs to report on.
      if (target.deviceId && target.deviceId !== deviceId) {
        await storage.recordSecurityEvent({
          type: 'AUTH_REJECTED',
          severity: 'warning',
          printerId: printer.id,
          detail: {
            reason: 'A device reported on a job claimed by a different device.',
            jobId: id,
            claimedBy: target.deviceId,
            reportedBy: deviceId,
          },
        });
        return res.status(409).json({
          error: 'This job is assigned to a different device on this printer.',
        });
      }

      const requestedState = parsePrintState(String(printState));
      if (!requestedState) {
        return res.status(400).json({ error: `Unknown print state '${printState}'.` });
      }

      const result = await storage.updateJobPrintState(id, requestedState, errorMessage, {
        actor: `agent:${deviceId}`,
        deviceId,
        // Classify who can resolve this, so the right person is asked (PRD 12).
        ...(requestedState === PrintState.Failed
          ? { failureCategory: classifyFailure(errorMessage) }
          : {}),
      });

      if (!result.ok) {
        if (result.code === 'NOT_FOUND') {
          return res.status(404).json({ error: result.reason });
        }
        // The job moved on underneath the agent (cancelled, or already terminal).
        // 409 tells the agent to stop rather than retry the same report forever.
        return res.status(409).json({ error: result.reason, job: result.job });
      }

      // Printed: the shop has fulfilled the order, so its held share (if any)
      // is released for settlement. Nothing happens with Route off.
      if (PRINTED_STATES.has(result.job.printState)) await releaseRouteTransfer(result.job.id);

      return res.json({ job: result.job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop Payout & Instant Withdrawal Summary
   */
  /**
   * Where the shop's money goes, and how it gets there.
   *
   * These fields were settable only in the signup body. There was no route to
   * change them afterwards, and the shop profile screen deliberately excludes
   * them with a comment saying they belong to the money screen — a screen that
   * had no such route either. So a shop that signed up without payout details,
   * or mistyped an IFSC, could never correct it, and the payout summary read a
   * upiId that stayed null for ever.
   *
   * Owner only: this decides where money lands, which is not a staff decision.
   */
  app.get('/api/shops/:shopId/payout-details', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const shop = await storage.getShop(req.params.shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      const account = shop.bankAccountNumber || '';

      return res.json({
        // A UPI id is how customers already pay this shop, so it is shown
        // whole. An account number is not, so only its tail comes back —
        // enough to recognise, not enough to read over a shoulder.
        upiId: shop.upiId || '',
        bankAccountLast4: account ? account.slice(-4) : '',
        bankAccountSet: Boolean(account),
        bankIfsc: shop.bankIfsc || '',
        settlement: describeSettlement(shop, routeService.isEnabled),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/payout-details', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const body = req.body || {};
      const clean = (v: unknown) =>
        v === undefined ? undefined : String(v).replace(/\s+/g, '').trim();

      const upiId = clean(body.upiId);
      const bankAccountNumber = clean(body.bankAccountNumber);
      const bankIfsc = clean(body.bankIfsc)?.toUpperCase();

      const shapeError = payoutShapeError(upiId, bankAccountNumber, bankIfsc);
      if (shapeError) return res.status(400).json({ error: shapeError });

      // A bank transfer needs both halves, so half of one is refused rather
      // than saved as something that cannot be paid to.
      const accountAfter = bankAccountNumber !== undefined
        ? bankAccountNumber
        : (await storage.getShop(req.params.shopId))?.bankAccountNumber || '';
      const ifscAfter = bankIfsc !== undefined
        ? bankIfsc
        : (await storage.getShop(req.params.shopId))?.bankIfsc || '';

      if (Boolean(accountAfter) !== Boolean(ifscAfter)) {
        return res.status(400).json({
          error: 'A bank account needs both the account number and its IFSC code. Add the other one, or clear both.',
        });
      }

      const updated = await storage.updateShopProfile(req.params.shopId, {
        ...(upiId !== undefined ? { upiId } : {}),
        ...(bankAccountNumber !== undefined ? { bankAccountNumber } : {}),
        ...(bankIfsc !== undefined ? { bankIfsc } : {}),
      });
      if (!updated) return res.status(404).json({ error: 'Shop not found.' });

      // Recorded because it changes where money goes, which is exactly the
      // kind of change that should be explainable afterwards. No values.
      await storage.recordSecurityEvent({
        type: 'AUTH_REJECTED',
        severity: 'info',
        detail: {
          reason: 'Payout destination changed by the shop owner.',
          shopId: req.params.shopId,
          changedBy: merchant.sub,
          fields: [
            upiId !== undefined && 'upiId',
            bankAccountNumber !== undefined && 'bankAccountNumber',
            bankIfsc !== undefined && 'bankIfsc',
          ].filter(Boolean),
        },
      });

      const account = updated.bankAccountNumber || '';
      return res.json({
        upiId: updated.upiId || '',
        bankAccountLast4: account ? account.slice(-4) : '',
        bankAccountSet: Boolean(account),
        bankIfsc: updated.bankIfsc || '',
        settlement: describeSettlement(updated, routeService.isEnabled),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * The shop's plan, and what the others would cost it.
   *
   * Read-only, deliberately. There is no subscription billing yet — nothing in
   * the system charges for a plan — so a self-service tier change would let a
   * shop move itself from 8% to 0.5% for free. Until billing exists the change
   * stays with an operator, and this endpoint says so rather than offering a
   * button that would quietly give away the commission.
   */
  app.get('/api/shops/:shopId/plan', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      // Usage comes from the same counter the limits are enforced against, so
      // the dashboard cannot show "3 / 3 staff" while the server is refusing a
      // fourth for a different reason.
      const [plan, recent, usage] = await Promise.all([
        storage.getShopPlan(shopId),
        storage.getRecentJobsForShop(shopId, 500),
        storage.countShopUsage(shopId),
      ]);

      const commissionBps = plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS;
      const currentTier = plan?.planTier ?? DEFAULT_PLAN_TIER;

      // This calendar month's paid orders, so the comparison below is about
      // this shop rather than an illustration.
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const paidThisMonth = recent.filter(
        (j) => j.paymentState === PaymentState.Paid && new Date(j.createdAt) >= monthStart
      );
      const grossCents = paidThisMonth.reduce((t, j) => t + (j.totalPriceInCents || 0), 0);

      const definition = getPlan(currentTier);

      return res.json({
        current: {
          tier: currentTier,
          platformFeeBps: commissionBps,
          // Retained under the old name for a dashboard served from cache
          // mid-deploy; both are the same value, never two sources.
          commissionBps,
          status: plan?.planStatus ?? 'active',
          ...(definition ? { name: definition.name } : {}),
          ...(definition ? { monthlyPriceCents: definition.monthlyPriceCents } : {}),
        },
        // What the shop is using against what its plan covers. `over` is the
        // downgrade case: existing resources are never removed, so a shop can
        // legitimately sit above a limit and needs telling rather than cutting off.
        usage: definition
          ? {
              orders: {
                used: usage.ordersThisMonth, limit: definition.maxOrdersPerMonth,
                over: usage.ordersThisMonth > definition.maxOrdersPerMonth,
              },
              printers: {
                used: usage.printers, limit: definition.maxPrinters,
                over: usage.printers > definition.maxPrinters,
              },
              staff: {
                used: usage.staff, limit: definition.maxStaff,
                over: usage.staff > definition.maxStaff,
              },
            }
          : undefined,
        thisMonth: {
          orders: paidThisMonth.length,
          grossCents,
          // What the shop has paid us in commission so far this month, at its
          // own rate — the number the comparison below is worth reading against.
          commissionCents: platformFeeFor(grossCents, commissionBps),
        },
        // Every tier costed against this shop's own volume, so an upgrade is a
        // arithmetic rather than a pitch.
        options: PLAN_CATALOGUE.map((p) => ({
          tier: p.tier,
          name: p.name,
          monthlyPriceCents: p.monthlyPriceCents,
          platformFeeBps: p.platformFeeBps,
          // Kept alongside the new name so a dashboard served from cache during
          // a deploy still renders a rate rather than "undefined%".
          commissionBps: p.platformFeeBps,
          maxOrdersPerMonth: p.maxOrdersPerMonth,
          maxPrinters: p.maxPrinters,
          maxStaff: p.maxStaff,
          isCurrent: p.tier === currentTier,
          // The subscription plus the platform fee. Razorpay's charge is not
          // added here: it is deducted by Razorpay from the settlement, not
          // billed by us, and adding it would overstate what PrintOk costs.
          wouldCostCents:
            p.monthlyPriceCents + platformFeeFor(grossCents, p.platformFeeBps),
        })),
        canDowngrade: true,
        canUpgrade: true,
        howToChange:
          'Paid plans are billed monthly through Razorpay: choosing one takes you to Razorpay to ' +
          'set up the payment, and the plan applies as soon as it goes through. Moving to Free ' +
          'cancels the subscription and applies straight away.',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * A shop owner changing their own plan.
   *
   * Until now the only route that could write a plan was the admin one, so an
   * owner saw a screen recommending a cheaper tier and had no way to act on it.
   * That reads as broken rather than as unfinished, and it was.
   *
   *   Paid tier — starts a Razorpay subscription and returns its checkout link.
   *               Nothing changes until the `subscription.activated` webhook
   *               says the mandate went through (see applySubscriptionEvent).
   *   Free      — cancels any subscription and applies immediately.
   *
   * Outside production with no Razorpay plan configured, a paid tier is
   * applied directly, as the webhook would, so development and tests work.
   */
  app.post('/api/shops/:shopId/plan', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const requested = String((req.body || {}).tier || '').trim();

      const target = getPlan(requested);
      if (!target) {
        return res.status(400).json({
          error: `Unknown plan '${requested}'. Choose one of: ${PLAN_TIERS.join(', ')}.`,
        });
      }

      const plan = await storage.getShopPlan(shopId);
      const currentTier = plan?.planTier ?? DEFAULT_PLAN_TIER;
      const current = getPlan(currentTier);

      if (target.tier === current?.tier) {
        return res.status(400).json({ error: `This shop is already on ${target.name}.` });
      }

      // ---- Paid tiers: through Razorpay -----------------------------------
      if (target.monthlyPriceCents > 0) {
        const planId = razorpayService.subscriptionPlanId(target.tier);

        if (planId) {
          const sub = await razorpayService.createSubscription(planId, { shopId, tier: target.tier });
          logOps('info', 'plan.limit_reached', {
            shopId, from: currentTier, to: target.tier, action: 'checkout_started',
          });
          return res.status(202).json({
            applied: false,
            requested: target.tier,
            checkoutUrl: sub.shortUrl,
            message: `Taking you to Razorpay to set up ${target.name}. The plan applies as soon as the payment goes through.`,
          });
        }

        if (process.env.NODE_ENV === 'production') {
          return res.status(503).json({
            error: `Online billing for ${target.name} is not set up yet. Your plan is unchanged and nothing was charged.`,
          });
        }
        // Development: behave as the activation webhook would.
      }

      // ---- Leaving a paid plan that Razorpay is billing ---------------------
      // The Refund Policy promises that a cancelled plan runs to the end of the
      // period already paid for. So the subscription is cancelled at cycle end:
      // the shop keeps its current plan until then, and Razorpay's
      // subscription.cancelled webhook moves it to Free when the period ends
      // (applySubscriptionEvent). Nothing changes here but the status.
      if (target.monthlyPriceCents === 0 && plan?.razorpaySubscriptionId && razorpayService.isConfigured) {
        if (plan.planStatus === 'cancelling') {
          return res.status(409).json({
            error: `Your ${current?.name ?? 'paid'} plan is already set to end at the close of this billing period.`,
          });
        }
        const cancelled = await razorpayService.cancelSubscription(plan.razorpaySubscriptionId, { atCycleEnd: true });
        if (!cancelled.ok) {
          return res.status(502).json({
            error: `Razorpay could not cancel the subscription, so your plan is unchanged: ${cancelled.error}`,
          });
        }
        await storage.updateShopPlan(shopId, { planStatus: 'cancelling' });
        logOps('info', 'plan.limit_reached', {
          shopId, from: currentTier, to: target.tier, action: 'cancel_at_period_end',
        });
        return res.status(202).json({
          applied: false,
          cancelsAtPeriodEnd: true,
          tier: currentTier,
          message:
            `Your ${current?.name ?? 'paid'} plan will not renew. It stays active until the end of the ` +
            `period you have paid for, and the shop then moves to ${target.name}. Nothing is refunded ` +
            'for the rest of the current month, and nothing more is charged.',
        });
      }

      // ---- Free, or a simulated paid tier: applied now ---------------------
      // Deliberately does NOT remove anything. A shop dropping to a smaller
      // plan keeps its printers, staff and orders; it simply cannot add more,
      // and is told where it stands. Silently disabling staff accounts because
      // a plan shrank would lock real people out of a till mid-shift.
      if (plan?.razorpaySubscriptionId) {
        await razorpayService.cancelSubscription(plan.razorpaySubscriptionId, { atCycleEnd: false });
      }
      const updated = await storage.updateShopPlan(shopId, {
        planTier: target.tier,
        commissionBps: target.platformFeeBps,
        planStatus: 'active',
        razorpaySubscriptionId: null,
      });

      if (!updated) return res.status(404).json({ error: 'That shop no longer exists.' });

      const usage = await storage.countShopUsage(shopId);
      const over: string[] = [];
      if (usage.printers > target.maxPrinters) {
        over.push(`${usage.printers} printers against ${target.maxPrinters}`);
      }
      if (usage.staff > target.maxStaff) {
        over.push(`${usage.staff} staff accounts against ${target.maxStaff}`);
      }

      logOps('info', 'plan.limit_reached', {
        shopId, from: currentTier, to: target.tier, action: 'downgraded', over: over.length,
      });

      return res.json({
        applied: true,
        tier: target.tier,
        name: target.name,
        platformFeeBps: target.platformFeeBps,
        message:
          `You are now on ${target.name}: ₹${Math.round(target.monthlyPriceCents / 100)}/month and ` +
          `a ${(target.platformFeeBps / 100).toFixed(2)}% platform fee. This applies to orders from now on — ` +
          'orders already placed keep the rate they were charged at.',
        // Said plainly rather than left to be discovered: nothing was removed,
        // and the shop is over on some limit until it reduces or moves back up.
        ...(over.length
          ? {
              overLimit: over,
              warning:
                `Nothing has been removed — you still have ${over.join(' and ')}. ` +
                'You cannot add more until you are back within the plan.',
            }
          : {}),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/shops/:shopId/payout-summary', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const [shop, plan, recent] = await Promise.all([
        storage.getShop(shopId),
        storage.getShopPlan(shopId),
        storage.getRecentJobsForShop(shopId, 500),
      ]);

      // The shop's own commission, not a hardcoded 2%: a Start shop pays 8% and
      // was previously shown a figure from a plan it is not on.
      const commissionBps = plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS;

      // Computed from today's orders rather than from a single revenue
      // aggregate. The aggregate could not distinguish a cash sale from an
      // online one, so it deducted a gateway fee from both — and this screen
      // then disagreed with the earnings screen, which is built per order.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todaysPaid = recent.filter(
        (j) => j.paymentState === PaymentState.Paid && new Date(j.createdAt) >= startOfToday
      );

      const { totals } = summariseShopEarnings(todaysPaid, commissionBps);
      const settlement = shop ? describeSettlement(shop, routeService.isEnabled) : null;

      return res.json({
        shopId,
        grossCents: totals.grossCents,
        commissionBps,
        razorpayFeeCents: totals.razorpayFeeCents,
        platformCommissionCents: totals.platformCommissionCents,
        // What PrintOk transfers: online earnings less the fees on cash
        // orders, whose money the shop already holds.
        netAvailableCents: totals.settlementCents,
        cashFeesCents: totals.cashFeesCents,
        // So the screen can say why a cash order carries no gateway deduction.
        cashOrders: totals.cashOrders,
        onlineOrders: totals.onlineOrders,
        // The shop's own payout destination. This was hardcoded, so every shop
        // was shown the same address regardless of what it had registered.
        payoutUpiId: shop?.upiId || null,
        payoutBankSet: Boolean(shop?.bankAccountNumber),
        // The mode alone said 'manual' and left the shop owner to guess what
        // that meant or what to do; the explanation travels with it now.
        settlement: settlement?.mode ?? 'manual',
        settlementDetail: settlement,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Shop Instant Payout Withdrawal Endpoint
   */
  /**
   * What the shop has earned, order by order.
   *
   * Built from the jobs themselves rather than a ledger table, because there is
   * no ledger table yet and inventing one that is not written to by the payment
   * path would be worse than deriving from the source of truth.
   *
   * The fee figures are estimates, and say so. Razorpay reports the actual fee
   * and tax on the payment object, and until the webhook stores those this can
   * only apply the published rate — a number that is close but not the one that
   * will appear on a settlement statement.
   */
  app.get('/api/shops/:shopId/earnings', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const [shop, plan, jobs] = await Promise.all([
        storage.getShop(shopId),
        storage.getShopPlan(shopId),
        storage.getRecentJobsForShop(shopId, 500),
      ]);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      const from = typeof req.query.from === 'string' ? req.query.from : '';
      const to = typeof req.query.to === 'string' ? req.query.to : '';

      // Compared as ISO strings. The timestamps already sort correctly that
      // way, and a Date round-trip would shift a job either side of midnight
      // into the wrong day.
      const inRange = (iso: string) =>
        (!from || iso >= from) && (!to || iso <= `${to}T23:59:59.999Z`);

      const commissionBps = plan?.commissionBps ?? DEFAULT_PLATFORM_FEE_BPS;

      // Only money that actually arrived. A job awaiting payment has earned
      // nothing, and a refunded one has un-earned what it took.
      const earned = jobs.filter(
        (j) => j.paymentState === PaymentState.Paid && inRange(String(j.createdAt))
      );

      const { rows, totals } = summariseShopEarnings(earned, commissionBps);

      return res.json({
        settlement: routeService.isEnabled && shop.razorpayAccountStatus === 'activated' ? 'automatic' : 'pending-route',
        // The same explanation the payout summary returns, from the same
        // function, so the two screens cannot describe settlement differently.
        settlementDetail: describeSettlement(shop, routeService.isEnabled),
        commissionBps,
        gatewayFeeBps: PAYMENT_GATEWAY_FEE_BPS,
        // True only while some row is still an estimate. It used to be
        // unconditional, because every figure was one.
        feesAreEstimated: totals.ordersWithActualFees < totals.orders,
        totals,
        rows: rows.slice(0, 200),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/shops/:shopId/withdraw', async (req: Request, res: Response) => {
    const merchant = await authenticateMerchant(req, res, { requireOwner: true });
    if (!merchant) return;

    try {
      const { shopId } = req.params;
      const shop = await storage.getShop(shopId);
      if (!shop) return res.status(404).json({ error: 'Shop not found.' });

      // This endpoint previously answered "Instant UPI payout request processed
      // successfully" while moving no money and recording nothing. Telling a
      // shop owner their money has been sent when it has not is worse than
      // having no button at all, so it now reports the truth.
      if (routeService.isEnabled && shop.razorpayAccountStatus === 'activated') {
        return res.status(409).json({
          error:
            'This shop settles automatically. Each paid order is transferred to your own ' +
            'Razorpay account and released once it prints, so there is nothing to withdraw here.',
          settlement: 'automatic',
        });
      }

      return res.status(501).json({
        error:
          'Self-service withdrawal is not available yet. Online payments are received by PrintOk ' +
          'and paid out to you separately; contact support about a payout.',
        settlement: 'manual',
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}

