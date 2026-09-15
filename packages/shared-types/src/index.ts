/**
 * PrintOk Domain Types & Contracts
 */

/**
 * Payment state model (completely independent from PrintState)
 */
export enum PaymentState {
  Pending = 'Pending',
  Processing = 'Processing',
  Paid = 'Paid',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  RefundPending = 'RefundPending',
  Refunded = 'Refunded',
  PartiallyRefunded = 'PartiallyRefunded',
}

/**
 * Print job execution state model
 */
export enum PrintState {
  Created = 'Created',
  AwaitingPayment = 'AwaitingPayment',
  Queued = 'Queued',
  /// Claimed by a specific agent device; no other device may pick it up.
  Assigned = 'Assigned',
  Downloading = 'Downloading',
  Printing = 'Printing',
  Printed = 'Printed',
  /// Physically printed and waiting at the counter for the customer.
  ReadyForCollection = 'ReadyForCollection',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  RequiresShopAction = 'RequiresShopAction',
  /// Held for human decision before any money moves (PRD 12, 17).
  RefundReview = 'RefundReview',
}

/**
 * Failure classification (PRD 12). Determines who can resolve a stuck job.
 */
export enum FailureCategory {
  CustomerResolvable = 'CustomerResolvable',
  ShopResolvable = 'ShopResolvable',
  PlatformResolvable = 'PlatformResolvable',
  SafetyCritical = 'SafetyCritical',
}

/**
 * Immutable record of how a job's price was derived (PRD 9).
 * Frozen at creation so later rate-card edits cannot restate a past quote.
 */
export interface PriceSnapshot {
  perPageRateCents: number;
  pages: number;
  copies: number;
  billableSheets: number;
  subtotalCents: number;
  bulkDiscountPercent: number;
  bulkDiscountCents: number;
  paperSizeMultiplier: number;
  totalPriceInCents: number;
  rateCard: MerchantPricingConfig;
  calculatedAt: string;

  // --- Grid pricing ---
  /** The cell used, so a dispute can be settled without guessing which applied. */
  appliedRate?: ShopRate;
  /** What the order would have cost at normal rates, before any discount. */
  normalValueCents?: number;
  /** Whether the order cleared the bulk threshold, and what it was at the time. */
  bulkApplied?: boolean;
  bulkThresholdCents?: number;
  /** Rate charged for copy 1, and for copies 2+. */
  firstCopyRateCents?: number;
  additionalCopyRateCents?: number;
  /** The whole rate card as it stood, so the quote is reproducible. */
  rateCardSnapshot?: ShopRateCard;
}

/**
 * Immutable copy of the print configuration as submitted (PRD 9).
 */
export interface PrintConfigSnapshot {
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex: boolean;
  paperSize: string;
  pageRange?: string;
}

/**
 * Append-only job lifecycle entry (PRD 9, 22).
 */
export interface JobEvent {
  id: string;
  jobId: string;
  type: string;
  fromState?: string;
  toState?: string;
  /** customer | agent:<deviceId> | shop:<userId> | system | webhook */
  actor?: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Shop entity definition
 */
/**
 * Contact and registered address for a shop.
 *
 * Razorpay requires a phone number to create a Route linked account and refuses
 * the call without one, and stalls KYC on an incomplete address. Collected at
 * signup so a shop is not chased for it later, at the moment it is trying to
 * get paid.
 */
export interface ShopContactDetails {
  contactPhone?: string;
  addressStreet1?: string;
  addressStreet2?: string;
  addressCity?: string;
  addressState?: string;
  addressPostalCode?: string;
  /** ISO country code; India unless stated otherwise. */
  addressCountry?: string;
}

export interface Shop extends ShopContactDetails {
  id: string;
  name: string;
  ownerEmail: string;
  upiId?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
  payoutStatus?: string;
  /** Razorpay Route linked account, when the shop settles automatically. */
  razorpayAccountId?: string;
  /** not_linked | created | needs_kyc | activated | suspended */
  razorpayAccountStatus?: string;
  razorpayLinkedAt?: string;
  razorpayAccountError?: string;
  createdAt: string;
}

/**
 * Printer entity definition linked to a Shop
 */
export interface Printer {
  id: string;
  shopId: string;
  printerName: string;
  qrTargetUrl: string;
  qrCodeDataUrl: string; // Base64 PNG/SVG Data URI for rendering QR code
  apiKey: string; // Authentication key for Windows Print Agent
  status: 'online' | 'offline' | 'busy' | 'error';
  createdAt: string;
}

export interface PrinterTelemetry {
  printerId: string;
  lastHeartbeat: string;
  isOnline: boolean;
  paperStatus?: string;
}

/**
 * A print capability a shop can offer.
 *
 * The catalogue is code and the shop's selection is data — a list of keys — so
 * adding a capability is a deploy rather than a migration, and a key left
 * behind by a rename is ignored on read rather than breaking a portal.
 */
export interface ServiceCapability {
  key: string;
  label: string;
  /** Which section of the setup screen it sits in. */
  group: 'popular' | 'advanced' | 'physical';
  /** Shown under the label where the name alone is not enough. */
  hint?: string;
  /**
   * Whether a shop that has never configured anything offers it.
   *
   * This is not a judgement about what a shop *should* sell — it is a
   * statement of what the customer page already offered before this catalogue
   * existed. Anything the portal showed yesterday defaults on, or a shop that
   * has never opened the setup screen would quietly stop accepting orders it
   * accepted the day before.
   *
   * Capabilities the portal never had (photo sizes, glossy, stapling,
   * pages-per-sheet) default off, because nothing is lost by them being off
   * and a shop promising them on hardware that cannot do them has to refund.
   */
  defaultOn: boolean;
}

export const SERVICE_CATALOGUE: readonly ServiceCapability[] = [
  // --- Popular: what nearly every counter does ---
  { key: 'bw',              label: 'Black & white',       group: 'popular', defaultOn: true },
  { key: 'colour',          label: 'Colour',              group: 'popular', defaultOn: true,  hint: 'Turn off if this printer is mono only' },
  { key: 'single-sided',    label: 'Single-sided',        group: 'popular', defaultOn: true },
  { key: 'duplex-auto',     label: 'Back-to-back',        group: 'popular', defaultOn: true,  hint: 'Automatic — the printer turns the page itself' },
  { key: 'duplex-manual',   label: 'Back-to-back',        group: 'popular', defaultOn: true, hint: 'Manual — two passes on a single-sided printer' },
  { key: 'paper-a4',        label: 'A4',                  group: 'popular', defaultOn: true },
  { key: 'paper-a3',        label: 'A3',                  group: 'popular', defaultOn: true },
  { key: 'paper-letter',    label: 'Letter',              group: 'popular', defaultOn: true },
  { key: 'multiple-copies', label: 'Multiple copies',     group: 'popular', defaultOn: true },
  { key: 'page-selection',  label: 'Page selection',      group: 'popular', defaultOn: true, hint: 'Customer picks a page range' },

  // --- Advanced: layout the customer chooses ---
  { key: 'auto-orientation', label: 'Auto orientation',   group: 'advanced', defaultOn: true },
  { key: 'portrait',         label: 'Portrait',           group: 'advanced', defaultOn: true },
  { key: 'landscape',        label: 'Landscape',          group: 'advanced', defaultOn: true },
  { key: 'fit-to-page',      label: 'Fit to page',        group: 'advanced', defaultOn: true },
  { key: 'actual-size',      label: 'Actual size',        group: 'advanced', defaultOn: true },
  { key: 'pages-per-sheet',  label: 'Pages per sheet',    group: 'advanced', defaultOn: false, hint: 'Two or four pages on one side' },
  { key: 'collated',         label: 'Collated printing',  group: 'advanced', defaultOn: true },

  // --- Physical: media and finishing the hardware or staff must do ---
  { key: 'paper-plain',   label: 'Plain paper',    group: 'physical', defaultOn: true },
  { key: 'paper-glossy',  label: 'Glossy paper',   group: 'physical', defaultOn: false },
  { key: 'photo-4x6',     label: '4×6 photo',      group: 'physical', defaultOn: false },
  { key: 'photo-5x7',     label: '5×7 photo',      group: 'physical', defaultOn: false },
  { key: 'stapling',      label: 'Stapling',       group: 'physical', defaultOn: false, hint: 'Someone has to staple it' },
];

export const SERVICE_GROUPS: ReadonlyArray<{ id: ServiceCapability['group']; label: string; blurb: string }> = [
  { id: 'popular',  label: 'Popular services',  blurb: 'What most counters do. Turn off anything this shop cannot.' },
  { id: 'advanced', label: 'Advanced services', blurb: 'Layout choices the customer makes before paying.' },
  { id: 'physical', label: 'Physical services', blurb: 'Media and finishing that the printer or a person has to handle.' },
];

/** The selection a shop starts with, in catalogue order. */
export function defaultEnabledServices(): string[] {
  return SERVICE_CATALOGUE.filter((c) => c.defaultOn).map((c) => c.key);
}

/**
 * The shop's selection, resolved against the catalogue.
 *
 * An empty stored list means "never configured", not "offers nothing" — a shop
 * that has not opened the setup screen must still be able to sell. Unknown keys
 * are dropped, so a renamed capability degrades instead of breaking the portal.
 */
export function resolveEnabledServices(stored: string[] | undefined | null): string[] {
  if (!stored || stored.length === 0) return defaultEnabledServices();
  const known = new Set(SERVICE_CATALOGUE.map((c) => c.key));
  return stored.filter((k) => known.has(k));
}

/**
 * What a customer may actually choose at one shop.
 *
 * Derived from two independent things: the services the shop says it offers,
 * and whether a priced, enabled rate exists for the combination. Both have to
 * agree — a shop that ticks "colour" but has disabled every colour rate is not
 * offering colour, and showing the option would sell something it then has to
 * refund.
 *
 * Shared by three callers that must not disagree: the customer page decides
 * what to render, the setup screen previews the same thing before saving, and
 * the API refuses a job that asks for something not on this list. Hiding a
 * control is presentation; the refusal is the enforcement.
 */
export interface PortalOptions {
  colourModes: Array<'bw' | 'colour'>;
  sidedModes: Array<'single' | 'duplex'>;
  paperSizes: string[];
  allowMultipleCopies: boolean;
  allowPageSelection: boolean;
}

/** Which capability key gates a given paper size. */
const PAPER_SERVICE_KEYS: Record<string, string> = {
  A4: 'paper-a4',
  A3: 'paper-a3',
  Letter: 'paper-letter',
};

export function derivePortalOptions(
  enabledServices: string[],
  card: ShopRateCard
): PortalOptions {
  const offers = new Set(resolveEnabledServices(enabledServices));

  /** A combination is sellable only if its rate row exists and is switched on. */
  const sellable = (paperSize: string, isColor: boolean, isDuplex: boolean): boolean => {
    const rate = findRate(card, paperSize, isColor, isDuplex);
    return !!rate && rate.enabled && rate.perPageCents >= 0;
  };

  const paperSizes = Object.keys(PAPER_SERVICE_KEYS).filter((size) => {
    if (!offers.has(PAPER_SERVICE_KEYS[size])) return false;
    // At least one combination on this paper has to be sellable, or the size
    // is a dead end the customer can select and then not proceed from.
    return [false, true].some((c) => [false, true].some((d) => sellable(size, c, d)));
  });

  const colourModes: Array<'bw' | 'colour'> = [];
  if (offers.has('bw') && paperSizes.some((p) => [false, true].some((d) => sellable(p, false, d)))) {
    colourModes.push('bw');
  }
  if (offers.has('colour') && paperSizes.some((p) => [false, true].some((d) => sellable(p, true, d)))) {
    colourModes.push('colour');
  }

  const sidedModes: Array<'single' | 'duplex'> = [];
  if (offers.has('single-sided')) sidedModes.push('single');
  if (offers.has('duplex-auto') || offers.has('duplex-manual')) sidedModes.push('duplex');

  return {
    colourModes,
    sidedModes,
    paperSizes,
    allowMultipleCopies: offers.has('multiple-copies'),
    allowPageSelection: offers.has('page-selection'),
  };
}

/**
 * Whether a submitted job configuration is one this shop actually sells.
 *
 * Returns the reason it is not, so the customer is told which choice is
 * unavailable rather than being handed a generic refusal.
 */
export function checkJobAgainstPortal(
  options: PortalOptions,
  job: { isColor: boolean; isDuplex: boolean; paperSize: string; copies: number; pageRange?: string | null }
): string | undefined {
  const wantedColour = job.isColor ? 'colour' : 'bw';
  if (!options.colourModes.includes(wantedColour)) {
    return job.isColor
      ? 'This shop does not print in colour.'
      : 'This shop does not offer black and white printing.';
  }

  const wantedSided = job.isDuplex ? 'duplex' : 'single';
  if (!options.sidedModes.includes(wantedSided)) {
    return job.isDuplex
      ? 'This shop does not print back-to-back.'
      : 'This shop does not offer single-sided printing.';
  }

  if (!options.paperSizes.includes(job.paperSize)) {
    return `This shop does not stock ${job.paperSize} paper.`;
  }

  if (job.copies > 1 && !options.allowMultipleCopies) {
    return 'This shop prints one copy at a time.';
  }

  if (job.pageRange && !options.allowPageSelection) {
    return 'This shop prints whole documents only.';
  }

  return undefined;
}

/** One cell of the rate grid: what this exact configuration costs. */
export interface ShopRate {
  paperSize: string;
  isColor: boolean;
  isDuplex: boolean;
  perPageCents: number;
  /** Rate once the order clears the bulk threshold. Null/undefined = no discount here. */
  bulkPerPageCents?: number | null;
  /** Rate for copies 2+. Null/undefined = same as copy 1. */
  additionalCopyPerPageCents?: number | null;
  /** Whether a customer may choose this combination. */
  enabled: boolean;
}

/**
 * Everything needed to price a job at one shop.
 *
 * The grid plus the two discount switches. Stored whole on each job, so a later
 * edit to a shop's rates can never restate what a past customer was quoted.
 */
export interface ShopRateCard {
  rates: ShopRate[];
  /** Lower rates once an order's normal value crosses the threshold. */
  bulkEnabled: boolean;
  bulkThresholdCents: number;
  /** Copy 1 at the normal rate, copies 2+ at the per-configuration rate. */
  additionalCopyEnabled: boolean;
}

/** Paper sizes the portal offers. A shop enables or prices the ones it stocks. */
export const PAPER_SIZES = ['A4', 'A3', 'Letter'] as const;

/** Every combination a rate grid covers, in the order a merchant reads them. */
export function rateGridKeys(): Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }> {
  const keys: Array<{ paperSize: string; isColor: boolean; isDuplex: boolean }> = [];
  for (const paperSize of PAPER_SIZES) {
    for (const isColor of [false, true]) {
      for (const isDuplex of [false, true]) {
        keys.push({ paperSize, isColor, isDuplex });
      }
    }
  }
  return keys;
}

export function findRate(
  card: ShopRateCard,
  paperSize: string,
  isColor: boolean,
  isDuplex: boolean
): ShopRate | undefined {
  return card.rates.find(
    (r) => r.paperSize === paperSize && r.isColor === isColor && r.isDuplex === isDuplex
  );
}

export interface MerchantPricingConfig {
  bwSinglePerPageCents: number;
  bwDuplexPerPageCents: number;
  colorSinglePerPageCents: number;
  colorDuplexPerPageCents: number;
  a3Multiplier?: number;
  bulkDiscountThreshold?: number;
  bulkDiscountPercent?: number;
  enableSeparatorPage?: boolean;
  separatorMinPages?: number;
}

export interface MerchantStats {
  shopId: string;
  todayRevenueCents: number;
  todayJobsCount: number;
  completedJobsCount: number;
  pendingJobsCount: number;
}


/**
 * Print Job definition
 */
export interface PrintJob {
  id: string;
  /** Customer-facing order reference, stable across job retries. */
  orderId: string;
  shopId: string;
  printerId: string;
  /** Agent device that claimed the job; unset until assignment. */
  deviceId?: string;
  tokenNumber?: string;

  /**
   * Customer identity, present only when the shop asked for it.
   *
   * Undefined is the normal case: collection is opt-in per shop, because the
   * published privacy policy promises anonymity by default.
   */
  customerName?: string;
  customerPhone?: string;

  // Document reference
  fileName: string;
  fileUrl: string;
  fileChecksum: string;
  fileSizeBytes?: number;

  // Print configuration
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
  pageRange?: string;
  printConfig?: PrintConfigSnapshot;

  // Price
  totalPriceInCents: number;
  priceSnapshot?: PriceSnapshot;

  // Payment
  paymentState: PaymentState;
  paymentProvider?: string;
  paymentRef?: string;

  // Print lifecycle
  printState: PrintState;

  // Idempotency & retries (PRD 11)
  idempotencyKey?: string;
  attemptCount?: number;
  maxAttempts?: number;
  lastAttemptAt?: string;

  // Failure handling (PRD 12)
  errorMessage?: string;
  failureCategory?: FailureCategory;

  // Lifecycle timestamps
  queuedAt?: string;
  assignedAt?: string;
  printedAt?: string;
  completedAt?: string;
  documentDeletedAt?: string;

  /** Set when the shop declined the job, with the reason it gave. */
  declineReason?: string;
  /** Razorpay refund id (rfnd_...) once the money has been sent back. */
  refundId?: string;
  refundAmountCents?: number;
  refundedAt?: string;

  /** Razorpay Route settlement for this job, when split at payment time. */
  transferId?: string;
  transferAmountCents?: number;
  serviceFeeCents?: number;

  createdAt: string;
  updatedAt: string;
}

/**
 * DTO: Shop & Printer Registration Input
 */
export interface RegisterShopDto {
  shopName: string;
  ownerEmail: string;
  printerName: string;
  upiId?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
}

/**
 * DTO: Shop & Printer Registration Output
 */
export interface RegisterShopResponse {
  shop: Shop;
  printer: Printer;
}

/**
 * DTO: Create Print Job Input
 */
export interface CreatePrintJobDto {
  printerId: string;
  fileName: string;
  fileBase64: string; // Temporary payload for MVP
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
  /** Sent only when the shop's portal asks for them. */
  customerName?: string;
  customerPhone?: string;
}

/**
 * What the customer portal asks for, decided by the shop.
 *
 * Every field defaults to false. A shop that has not opted in collects nothing,
 * which is what the privacy policy tells its customers.
 */
export interface ShopPortalConfig {
  collectCustomerName: boolean;
  customerNameRequired: boolean;
  collectCustomerPhone: boolean;
  customerPhoneRequired: boolean;
  /** Capability keys offered, in display order. Empty means the defaults. */
  enabledServices: string[];
}

export const DEFAULT_PORTAL_CONFIG: ShopPortalConfig = {
  collectCustomerName: false,
  customerNameRequired: false,
  collectCustomerPhone: false,
  customerPhoneRequired: false,
  enabledServices: [],
};

/** Longest we will store for either field, so a paste of a whole address is refused. */
export const CUSTOMER_NAME_MAX = 80;
export const CUSTOMER_PHONE_MAX = 20;

/**
 * DTO: Create Print Job Output
 */
export interface CreatePrintJobResponse {
  job: PrintJob;
}

/**
 * DTO: Agent Pending Jobs Response
 */
export interface AgentPollResponse {
  jobs: PrintJob[];
}

/**
 * DTO: Agent Update Status Input
 */
export interface AgentUpdateStatusDto {
  jobId: string;
  printState: PrintState;
  errorMessage?: string;
}

/**
 * DTO: Payment Webhook Input
 */
export interface PaymentWebhookDto {
  paymentId: string;
  jobId: string;
  amountInCents: number;
  signature: string;
}

/**
 * DTO: WebSocket Event Messages for Agent
 */
export interface AgentWsMessage {
  type: 'PING' | 'PONG' | 'JOB_QUEUED' | 'AUTH_SUCCESS' | 'AUTH_ERROR';
  payload?: any;
}

export interface JobQueuedEvent {
  jobId: string;
  printerId: string;
  tokenNumber?: string;
  fileName: string;
  fileUrl: string;
  fileChecksum: string;
  pageCount: number;
  copies: number;
  isColor: boolean;
  isDuplex?: boolean;
  paperSize?: string;
}



/* ===========================================================================
 * Plan catalogue (PRD 41)
 *
 * The single source of truth for tiers, prices, service fees and limits. The
 * API prices from it, the admin console edits against it, and the landing page
 * renders it — so the figures a shop is shown are the figures it is charged.
 * Anything duplicating these numbers elsewhere is a bug waiting to happen.
 * =========================================================================== */

export type PlanTier = 'start' | 'smart' | 'business' | 'enterprise';

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** Subscription price in paise. */
  monthlyPriceCents: number;
  /** PrintOk service fee in basis points (800 = 8.00%). */
  commissionBps: number;
  /** Orders included per calendar month. */
  maxOrdersPerMonth: number;
  maxPrinters: number;
  tagline: string;
  features: string[];
  /** Exactly one tier carries this. */
  popular?: boolean;
}

/**
 * Razorpay's charge, deducted by Razorpay before settlement — not by PrintOk.
 * 2% plus 18% GST on that fee. Shown separately so a shop is never surprised
 * by the difference between its order total and its payout, which matters most
 * on Enterprise where our own fee is smaller than the gateway's.
 */
export const PAYMENT_GATEWAY_FEE_BPS = 236;
export const PAYMENT_GATEWAY_LABEL = 'Razorpay 2% + 18% GST';

export const PLAN_CATALOGUE: readonly PlanDefinition[] = [
  {
    tier: 'start',
    name: 'Start',
    monthlyPriceCents: 0,
    commissionBps: 800,
    maxOrdersPerMonth: 100,
    maxPrinters: 1,
    tagline: 'Put your counter online and see if it works for you.',
    features: [
      'QR poster for your counter',
      'Customer pays by UPI or card',
      'Live job queue and tokens',
      'Your own per-page rates',
      'Email support',
    ],
  },
  {
    tier: 'smart',
    name: 'Smart',
    monthlyPriceCents: 7900,
    commissionBps: 400,
    maxOrdersPerMonth: 500,
    maxPrinters: 2,
    tagline: 'For a shop printing every day.',
    features: [
      'Everything in Start',
      'Bulk and duplex pricing',
      'Revenue analytics',
      'Instant payouts',
    ],
  },
  {
    tier: 'business',
    name: 'Business',
    monthlyPriceCents: 24900,
    commissionBps: 200,
    maxOrdersPerMonth: 2500,
    maxPrinters: 5,
    tagline: 'For a busy counter running several printers.',
    features: [
      'Everything in Smart',
      'Multiple connected PCs',
      'Priority support',
      'Onboarding help',
    ],
    popular: true,
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    monthlyPriceCents: 59900,
    commissionBps: 50,
    maxOrdersPerMonth: 10000,
    maxPrinters: 10,
    tagline: 'For print shops and multi-counter operations.',
    features: [
      'Everything in Business',
      'Lowest service fee',
      'Highest order volume',
      'Dedicated support contact',
    ],
  },
];

export function getPlan(tier: string): PlanDefinition | undefined {
  return PLAN_CATALOGUE.find((p) => p.tier === tier);
}

export const PLAN_TIERS: readonly PlanTier[] = PLAN_CATALOGUE.map((p) => p.tier);

/**
 * What a shop actually keeps from an order.
 *
 * The gateway takes its cut before settlement and PrintOk's fee applies to the
 * order value, so the two are calculated independently rather than compounded.
 */
export function calculateShopNetCents(
  grossCents: number,
  commissionBps: number
): { gatewayFeeCents: number; serviceFeeCents: number; netCents: number } {
  const gatewayFeeCents = Math.round((grossCents * PAYMENT_GATEWAY_FEE_BPS) / 10_000);
  const serviceFeeCents = Math.round((grossCents * commissionBps) / 10_000);
  return {
    gatewayFeeCents,
    serviceFeeCents,
    netCents: Math.max(0, grossCents - gatewayFeeCents - serviceFeeCents),
  };
}
