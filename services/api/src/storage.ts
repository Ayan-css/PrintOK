import crypto from 'crypto';
import {
  Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry,
  MerchantPricingConfig, MerchantStats, JobEvent, FailureCategory, PlanTier, getPlan,
  DEFAULT_PLAN_TIER, platformFeeFor,
  ShopContactDetails, ShopPortalConfig, DEFAULT_PORTAL_CONFIG, ShopRateCard, ShopRate,
  PrintOrientation,
} from '@printok/shared-types';
import { S3StorageService } from './s3Storage';
import { calculateJobPriceBreakdown, calculateGridPriceBreakdown, buildDefaultRateCard, DEFAULT_PRICING_CONFIG } from './pricing';
import { canTransitionPrintState, canTransitionPaymentState, isDocumentPurgeable } from './jobStateMachine';
import { isStale, recoveryActionFor } from './jobRecovery';
import { isDocumentExpired } from './documentRetention';

/** Optional inputs captured at job creation (PRD 9, 11). */
export interface CreateJobOptions {
  pageRange?: string;
  /** auto | portrait | landscape. Defaults to `auto`, which is what every job did before. */
  orientation?: PrintOrientation;
  /** Client-supplied key that deduplicates repeated submissions. */
  idempotencyKey?: string;
  fileSizeBytes?: number;
  /** Present only when the shop's portal asked for them. */
  customerName?: string;
  customerPhone?: string;
  /**
   * Queue the job immediately without claiming it is paid.
   *
   * For shops printing before the money clears. Deliberately separate from
   * autoApprovePayment: that marks the payment settled, and using it to mean
   * "start printing" would record an unpaid job as Paid, corrupting the payout
   * figures and breaking the rule that payment state and print state are never
   * derived from one another.
   */
  queueWithoutPayment?: boolean;
}

/** Extra context recorded alongside a print state change. */
export interface TransitionMeta {
  /** customer | agent:<deviceId> | shop:<id> | system | webhook */
  actor?: string;
  deviceId?: string;
  failureCategory?: FailureCategory;
  detail?: Record<string, unknown>;
}

/**
 * Result of a guarded state change. An illegal transition is reported
 * distinctly from a missing job so callers can answer 409 vs 404 (PRD 10).
 */
export type StateChangeResult =
  | { ok: true; job: PrintJob }
  | { ok: false; code: 'NOT_FOUND'; reason: string }
  | { ok: false; code: 'ILLEGAL_TRANSITION'; reason: string; job: PrintJob };

/** A paired agent install (PRD 7.1). */
export interface AgentDeviceRecord {
  id: string;
  printerId: string;
  deviceName?: string;
  osVersion?: string;
  agentVersion?: string;
  status: 'active' | 'revoked';
  tokenIssuedAt: string;
  tokenExpiresAt?: string;
  revokedAt?: string;
  revokedReason?: string;
  lastSeenAt?: string;
  createdAt: string;
}

/** Auditable agent security event (PRD 7.2). */
export interface AgentSecurityEventRecord {
  id: string;
  printerId?: string;
  deviceId?: string;
  type: string;
  severity: 'info' | 'warning' | 'critical';
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface PairingCodeRecord {
  code: string;
  printerId: string;
  expiresAt: string;
  usedAt?: string;
}

/** A shop owner or staff member who signs in to the dashboard (PRD 20). */
/** Editable shop details. Absent fields are left alone; empty strings clear. */
export interface ShopProfileUpdate {
  name?: string;
  contactPhone?: string;
  addressStreet1?: string;
  addressStreet2?: string;
  addressCity?: string;
  addressState?: string;
  addressPostalCode?: string;
  addressCountry?: string;
  gstin?: string;

  // --- Payout destination ---
  // Where the shop's money goes. Settable only at registration until now, so a
  // shop that signed up without them, or typed them wrong, could never fix it —
  // and the payout screen read an upiId that was permanently null.
  upiId?: string;
  bankAccountNumber?: string;
  bankIfsc?: string;
}

export interface MerchantUserRecord {
  id: string;
  shopId: string;
  email: string;
  name?: string;
  phone?: string;
  role: string;
  status: string;
  lastLoginAt?: string;
  createdAt: string;
}

/** Platform operator account (PRD 21). */
export interface AdminUserRecord {
  id: string;
  email: string;
  name?: string;
  role: string;
  status: string;
  lastLoginAt?: string;
  createdAt: string;
}

/** Commercial settings for a shop (PRD 41, hybrid tier + commission). */
export interface ShopPlan {
  planTier: PlanTier;
  commissionBps: number;
  planStatus: 'active' | 'suspended' | 'cancelled';
}

/** Whether a shop is safe to remove, and how (PRD 21). */
export interface ShopRemovalSafety {
  shopId: string;
  exists: boolean;
  paidJobCount: number;
  totalJobCount: number;
  printerCount: number;
  /** Hard delete is permitted only when no real money ever moved through it. */
  canHardDelete: boolean;
  reason?: string;
}

export interface ShopRemovalResult {
  shopId: string;
  ok: boolean;
  action: 'deleted' | 'archived' | 'restored' | 'refused';
  reason?: string;
}

/** An enquiry from the public contact form. */
export interface ContactEnquiryRecord {
  id: string;
  name: string;
  email: string;
  phone?: string;
  shopName?: string;
  message: string;
  status: 'new' | 'read' | 'replied' | 'archived';
  source: string;
  handledBy?: string;
  handledAt?: string;
  notes?: string;
  createdAt: string;
}

export interface CreateContactEnquiryInput {
  name: string;
  email: string;
  phone?: string;
  shopName?: string;
  message: string;
  source?: string;
  ipHash?: string;
  userAgent?: string;
}

export interface AdminAuditEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

/** One row of the admin shop table (PRD 21). */
export interface AdminShopSummary {
  shop: Shop;
  plan: ShopPlan;
  printerCount: number;
  onlinePrinterCount: number;
  pairedDeviceCount: number;
  totalJobs: number;
  jobsLast30Days: number;
  grossRevenueCents: number;
  commissionCents: number;
  jobsRequiringAction: number;
  lastJobAt?: string;
  archivedAt?: string;
  archiveReason?: string;
  /** Mirrors canHardDelete, so the console can offer the right action. */
  canHardDelete: boolean;
}

/** Network-wide operational overview (PRD 21, 25). */
export interface AdminOverview {
  totalShops: number;
  activeShops: number;
  totalPrinters: number;
  onlinePrinters: number;
  totalJobs: number;
  jobsToday: number;
  grossRevenueCents: number;
  commissionCents: number;
  jobsRequiringAction: number;
  shopsByTier: Record<string, number>;
}

/** Outcome of one sweep for abandoned jobs (PRD 12, 13). */
export interface ReclaimResult {
  /** Jobs safely returned to the queue because nothing reached paper. */
  requeued: string[];
  /** Jobs handed to a human because reprinting could double-print or double-charge. */
  escalated: string[];
}

/** Stored response of a previously executed idempotent request (PRD 11). */
export interface StoredIdempotencyRecord {
  key: string;
  scope: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface IStorageProvider {
  calculateChecksum(content: string | Buffer): string;
  createShop(
    name: string,
    ownerEmail: string,
    upiId?: string,
    bankAccountNumber?: string,
    bankIfsc?: string,
    contact?: ShopContactDetails
  ): Promise<Shop>;
  getShop(id: string): Promise<Shop | undefined>;
  createPrinter(shopId: string, printerName: string, baseUrlOrTargetUrl: string, qrCodeDataUrl?: string, qrGeneratorFn?: (url: string) => Promise<string>): Promise<Printer>;
  getPrinter(id: string): Promise<Printer | undefined>;
  getPrinterByApiKey(apiKey: string): Promise<Printer | undefined>;

  /**
   * Issues a new legacy agent key for a printer, invalidating the old one.
   *
   * The key was minted once when the printer was created and there was no way
   * to change it — so a key that leaked was a permanent full-access agent
   * credential for that printer, for the life of the printer. Device-scoped
   * tokens already had per-device revocation; this gives the older shared
   * credential the same escape route.
   */
  rotatePrinterApiKey(printerId: string): Promise<{ apiKey: string } | undefined>;
  /** Printers belonging to a shop, for the dashboard after sign-in. */
  listPrintersForShop(shopId: string): Promise<Printer[]>;
  /**
   * Rebuilds a printer's QR target and image against a new web base URL, for
   * printers registered while the public URL was misconfigured.
   */
  regeneratePrinterQr(
    printerId: string,
    baseUrl: string,
    qrGeneratorFn: (url: string) => Promise<string>
  ): Promise<Printer | undefined>;
  createPrintJob(
    printerId: string,
    fileName: string,
    fileBase64: string,
    pageCount: number,
    copies: number,
    isColor: boolean,
    autoApprovePayment?: boolean,
    isDuplex?: boolean,
    paperSize?: string,
    options?: CreateJobOptions
  ): Promise<PrintJob>;
  getPrintJob(id: string): Promise<PrintJob | undefined>;
  getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]>;
  getRecentJobsForShop(shopId: string, limit?: number): Promise<PrintJob[]>;
  updateJobPrintState(id: string, printState: PrintState, errorMessage?: string, meta?: TransitionMeta): Promise<StateChangeResult>;
  confirmPaymentAndQueueJob(id: string, meta?: TransitionMeta): Promise<StateChangeResult>;

  /** Claims a queued job for one agent device so no other device prints it (PRD 11). */
  assignJobToDevice(jobId: string, deviceId: string): Promise<StateChangeResult>;
  /** Append-only lifecycle trail for a job (PRD 9, 22). */
  getJobEvents(jobId: string, limit?: number): Promise<JobEvent[]>;
  /**
   * Recovers jobs abandoned mid-flight by an agent that died or lost the network
   * (PRD 12, 13). Safe to call repeatedly; it only acts on jobs past their
   * staleness threshold.
   */
  reclaimStaleJobs(now?: Date): Promise<ReclaimResult>;
  /** Jobs currently waiting on a human decision (PRD 12). */
  getJobsRequiringAction(shopId: string, limit?: number): Promise<PrintJob[]>;
  findJobByIdempotencyKey(key: string): Promise<PrintJob | undefined>;
  getIdempotencyRecord(key: string): Promise<StoredIdempotencyRecord | undefined>;
  saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void>;

  // --- Agent device identity & pairing (PRD 7.1, 7.2) ---
  createPairingCode(printerId: string, code: string, expiresAt: Date): Promise<PairingCodeRecord>;
  /** Atomically consumes a pairing code. Returns undefined if unknown, expired or already used. */
  consumePairingCode(code: string, deviceId: string): Promise<PairingCodeRecord | undefined>;
  createAgentDevice(input: {
    printerId: string;
    deviceId: string;
    tokenHash: string;
    tokenExpiresAt: Date;
    deviceName?: string;
    osVersion?: string;
    agentVersion?: string;
  }): Promise<AgentDeviceRecord>;
  /** Resolves an active, unexpired device by its token hash. */
  getActiveDeviceByTokenHash(tokenHash: string): Promise<AgentDeviceRecord | undefined>;
  getAgentDevice(deviceId: string): Promise<AgentDeviceRecord | undefined>;
  listAgentDevices(printerId: string): Promise<AgentDeviceRecord[]>;
  revokeAgentDevice(deviceId: string, reason?: string): Promise<AgentDeviceRecord | undefined>;
  touchAgentDevice(deviceId: string, agentVersion?: string): Promise<void>;
  recordSecurityEvent(event: Omit<AgentSecurityEventRecord, 'id' | 'createdAt'>): Promise<void>;
  listSecurityEvents(printerId: string, limit?: number): Promise<AgentSecurityEventRecord[]>;

  // --- Platform administration (PRD 21, 41) ---
  createAdminUser(input: { email: string; passwordHash: string; name?: string; role?: string }): Promise<AdminUserRecord>;
  getAdminUserByEmail(email: string): Promise<(AdminUserRecord & { passwordHash: string }) | undefined>;
  getAdminUser(id: string): Promise<AdminUserRecord | undefined>;
  countAdminUsers(): Promise<number>;

  /**
   * Claims the very first operator account, atomically.
   *
   * The bootstrap route counted admins and then created one, with no
   * transaction, lock or singleton constraint — only email @unique. A COUNT
   * takes no lock and does not see uncommitted inserts, so under READ
   * COMMITTED two concurrent requests with different emails both counted zero
   * and both succeeded, producing two full-privilege owner accounts. Narrow
   * window, on a freshly deployed instance, and unrecoverable once it happens.
   *
   * Returns a refusal rather than throwing, so the route answers 409 exactly as
   * it did when it lost the race by luck instead of by design.
   */
  createFirstAdminUser(input: {
    email: string; passwordHash: string; name?: string;
  }): Promise<{ ok: true; user: AdminUserRecord } | { ok: false; reason: string }>;
  recordAdminLogin(id: string): Promise<void>;
  getShopPlan(shopId: string): Promise<ShopPlan | undefined>;
  updateShopPlan(shopId: string, plan: Partial<ShopPlan>): Promise<ShopPlan | undefined>;
  listAdminShopSummaries(limit?: number, includeArchived?: boolean): Promise<AdminShopSummary[]>;
  /** Checks whether a shop can be hard deleted, without changing anything. */
  getShopRemovalSafety(shopId: string): Promise<ShopRemovalSafety>;
  /**
   * Permanently removes a shop and everything cascading from it.
   * `force` overrides the paid-job guard and destroys payment records with it,
   * so callers must gate it behind an explicit operator confirmation.
   */
  hardDeleteShop(shopId: string, force?: boolean): Promise<ShopRemovalResult>;
  archiveShop(shopId: string, actor: string, reason?: string): Promise<ShopRemovalResult>;
  restoreShop(shopId: string): Promise<ShopRemovalResult>;
  recordAdminAudit(entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<void>;
  /** Records a shop's Razorpay Route linkage state. */
  updateShopRazorpayAccount(shopId: string, update: {
    accountId?: string; status: string; error?: string | null;
  }): Promise<void>;
  /** Stores what was split to the shop and retained by PrintOk for one job. */
  recordJobSettlement(jobId: string, transferAmountCents: number, serviceFeeCents: number): Promise<void>;

  /**
   * Freezes what this order's money actually did.
   *
   * Written once, at confirmation, and read thereafter instead of being
   * recomputed. Recomputing is how a shop that upgraded mid-month found last
   * week's orders restated at its new commission rate, and how every order
   * showed the published gateway percentage rather than what Razorpay charged.
   *
   * `gatewayFeeCents` and `gatewayTaxCents` come from the payment entity when
   * the gateway reported them — `feesAreActual` says which — and from the
   * published rate when it did not, so the figures are never silently a guess
   * presented as a measurement.
   */
  /**
   * How many jobs a shop has created this calendar month, and how many printers
   * and staff accounts it has.
   *
   * For entitlement checks. The plan catalogue has carried per-tier caps on all
   * three since it was written and nothing ever consulted them, so a shop on the
   * free tier could run any volume it liked on any number of printers — the
   * ladder had no rung anybody had to climb.
   */
  /**
   * Issues a one-time password-reset token for a merchant.
   *
   * Only the hash is stored. The caller emails the token and then forgets it,
   * so a leaked database yields nothing usable — the same reason agent device
   * tokens are stored this way.
   */
  createPasswordResetToken(input: {
    tokenHash: string; merchantId: string; email: string; expiresAt: Date;
  }): Promise<void>;

  /**
   * Redeems a reset token, returning whose it was.
   *
   * Marks it used in the same operation, so two requests carrying the same
   * token cannot both succeed — a reset link is a password for as long as it
   * works, and it should work exactly once.
   */
  consumePasswordResetToken(tokenHash: string, now?: Date): Promise<
    { ok: true; merchantId: string } | { ok: false; reason: string }
  >;

  countShopUsage(shopId: string, now?: Date): Promise<{
    ordersThisMonth: number;
    printers: number;
    staff: number;
  }>;

  recordFeeLedger(
    jobId: string,
    ledger: {
      grossCents: number;
      gatewayFeeCents: number;
      gatewayTaxCents: number;
      commissionBpsUsed: number;
      feesAreActual: boolean;
      routeFeeCents?: number;
    }
  ): Promise<void>;

  /**
   * Deletes documents for jobs that have come to rest and will not be printed.
   *
   * Purging used to happen only on a state transition, so a job that never
   * transitioned again kept its document for ever — and Created,
   * AwaitingPayment, HeldForRelease, Queued and RequiresShopAction are exactly
   * where an abandoning customer lands. Upload a file, close the tab before
   * paying, and it was stored indefinitely. The published privacy policy
   * promised otherwise.
   *
   * Safe to call repeatedly; it only acts on jobs past their window.
   */
  purgeAbandonedDocuments(now?: Date): Promise<{ purged: string[] }>;

  /**
   * A short-lived link to a job's document, for a caller already authorised to
   * have it.
   *
   * Minted here rather than stored on the job, so a link cannot outlive the
   * job's need for it. Returns null once the document has been purged.
   */
  createJobDownloadUrl(jobId: string): Promise<string | null>;

  /**
   * Records the gateway order minted for a job.
   *
   * This is what a later confirmation is checked against. Without it the
   * confirm endpoint has nothing to bind a claimed payment to, and any real
   * payment can be applied to any job.
   */
  attachGatewayOrder(jobId: string, gatewayOrderId: string, amountCents: number): Promise<void>;

  /**
   * Claims a gateway payment for exactly one job.
   *
   * Returns false when another job already holds that payment, which is what
   * stops one payment settling several jobs. The uniqueness is enforced by the
   * database rather than by a preceding read, so two concurrent confirmations
   * naming the same payment cannot both win.
   */
  claimGatewayPayment(jobId: string, gatewayPaymentId: string): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Records a webhook delivery, returning false if it has already been acted on.
   *
   * Keyed by the gateway's own event id, so a retry is idempotent independently
   * of the job's current payment state — the two are different questions, and
   * answering the first with the second is what let a retry walk a refunded job
   * back to Paid.
   */
  markWebhookEventProcessed(eventId: string, event: string, jobId?: string): Promise<boolean>;

  /**
   * The shop refuses a job it will not print.
   *
   * Cancels the print side and, where the customer has already paid, moves the
   * payment to RefundPending. It does not move money — the caller issues the
   * refund and then calls recordJobRefund, so a job is never recorded as
   * refunded before Razorpay has actually accepted it.
   */
  declineJob(jobId: string, reason: string, meta?: TransitionMeta): Promise<StateChangeResult>;

  /**
   * Records a refund Razorpay has *settled*.
   *
   * Moves the payment to Refunded, or PartiallyRefunded when less than the
   * order total came back. Only for a refund whose status is 'processed' — see
   * recordRefundRequested for one that has merely been accepted.
   */
  recordJobRefund(
    jobId: string,
    refund: { refundId: string; amountInCents: number },
    meta?: TransitionMeta
  ): Promise<StateChangeResult>;

  /**
   * Records a refund Razorpay has accepted but not yet settled.
   *
   * Razorpay refunds are asynchronous: the API call returns a refund created as
   * 'pending', which becomes 'processed' when the bank has actually taken the
   * money — days later, sometimes — and which can fail. The job was being
   * marked Refunded the moment the call returned, so the customer was told
   * their money was back while it had not moved and might never.
   *
   * The payment stays in RefundPending; only the reference is stored, so the
   * refund can be recognised when its webhook arrives.
   */
  recordRefundRequested(
    jobId: string,
    refund: { refundId: string; amountInCents: number; status: string },
    meta?: TransitionMeta
  ): Promise<StateChangeResult>;

  /**
   * Marks a refund Razorpay has told us failed.
   *
   * The payment stands, which is the one legitimate use of the
   * RefundPending -> Paid transition: the provider rejected our refund, so the
   * money is still the shop's and the job is still cancelled. Distinct from a
   * customer's browser asserting payment, which is refused.
   */
  recordRefundFailed(jobId: string, refundId: string, meta?: TransitionMeta): Promise<StateChangeResult>;

  // --- Merchant accounts (PRD 20) ---
  createMerchantUser(input: {
    shopId: string; email: string; passwordHash: string;
    name?: string; phone?: string; role?: string;
  }): Promise<MerchantUserRecord>;
  getMerchantByEmail(email: string): Promise<(MerchantUserRecord & { passwordHash: string }) | undefined>;
  getMerchantUser(id: string): Promise<MerchantUserRecord | undefined>;
  /** Everyone who can sign in to this shop. */
  listMerchantUsers(shopId: string): Promise<MerchantUserRecord[]>;
  /** Changes a staff member's name, role or status. Never their password. */
  updateMerchantUser(id: string, update: { name?: string; role?: string; status?: string }): Promise<MerchantUserRecord | undefined>;
  /** Separate from the above so a profile edit can never rewrite a credential. */
  updateMerchantPassword(id: string, passwordHash: string): Promise<boolean>;
  /** The shop's own details: name, contact, registered address, GSTIN. */
  updateShopProfile(shopId: string, update: ShopProfileUpdate): Promise<Shop | undefined>;
  countMerchantsForShop(shopId: string): Promise<number>;
  recordMerchantLogin(id: string): Promise<void>;

  createContactEnquiry(input: CreateContactEnquiryInput): Promise<ContactEnquiryRecord>;
  listContactEnquiries(status?: string, limit?: number): Promise<ContactEnquiryRecord[]>;
  updateContactEnquiryStatus(
    id: string, status: string, handledBy: string, notes?: string
  ): Promise<ContactEnquiryRecord | undefined>;
  countNewContactEnquiries(): Promise<number>;
  /** How many enquiries this sender has left recently, to blunt form spam. */
  countRecentEnquiriesFrom(email: string, sinceMs: number): Promise<number>;
  listAdminAudit(limit?: number): Promise<AdminAuditEntry[]>;
  getAdminOverview(): Promise<AdminOverview>;

  recordHeartbeat(printerId: string, paperStatus?: string, deviceId?: string, agentVersion?: string): Promise<PrinterTelemetry>;
  getPrinterTelemetry(printerId: string): Promise<PrinterTelemetry>;
  getShopPricing(shopId: string): Promise<MerchantPricingConfig>;
  updateShopPricing(shopId: string, config: Partial<MerchantPricingConfig>): Promise<MerchantPricingConfig>;

  /** What the shop's customer portal asks for. Defaults to collecting nothing. */
  getShopPortalConfig(shopId: string): Promise<ShopPortalConfig>;
  updateShopPortalConfig(shopId: string, config: Partial<ShopPortalConfig>): Promise<ShopPortalConfig>;

  /** The shop's rate grid and discount switches. Seeded from its flat rates. */
  getShopRateCard(shopId: string): Promise<ShopRateCard>;
  updateShopRateCard(shopId: string, card: Partial<ShopRateCard>): Promise<ShopRateCard>;
  getShopStats(shopId: string): Promise<MerchantStats>;
}

export class MemoryStorage implements IStorageProvider {
  private shops = new Map<string, Shop>();
  private printers = new Map<string, Printer>();
  private printJobs = new Map<string, PrintJob>();
  private shopPricings = new Map<string, MerchantPricingConfig>();
  private telemetries = new Map<string, { lastHeartbeat: string; paperStatus?: string; deviceId?: string }>();
  private dailyTokenCounters = new Map<string, { dateStr: string; counter: number }>();
  private jobEvents = new Map<string, JobEvent[]>();
  private idempotencyRecords = new Map<string, StoredIdempotencyRecord>();
  private portalConfigs = new Map<string, ShopPortalConfig>();
  private rateCards = new Map<string, ShopRateCard>();
  /// Gateway payment id -> the one job it settled. Stands in for the unique
  /// index the Postgres path relies on.
  private gatewayPayments = new Map<string, string>();
  /// Reset tokens, keyed by hash exactly as the database keys them.
  private passwordResets = new Map<string, {
    tokenHash: string; merchantId: string; email: string; expiresAt: Date; usedAt?: Date;
  }>();
  /// Webhook event ids already acted on, so a retry is a no-op.
  private webhookEvents = new Set<string>();
  private agentDevices = new Map<string, AgentDeviceRecord & { tokenHash: string }>();
  private pairingCodes = new Map<string, PairingCodeRecord>();
  private securityEvents: AgentSecurityEventRecord[] = [];
  private adminUsers = new Map<string, AdminUserRecord & { passwordHash: string }>();
  private shopPlans = new Map<string, ShopPlan>();
  private archivedShops = new Map<string, { at: string; by: string; reason?: string }>();
  private auditLog: AdminAuditEntry[] = [];
  private contactEnquiries: ContactEnquiryRecord[] = [];
  private merchantUsers = new Map<string, MerchantUserRecord & { passwordHash: string }>();
  private s3Service = new S3StorageService();

  /** Appends to the job's lifecycle trail. Never overwrites earlier entries. */
  private appendEvent(
    jobId: string,
    type: string,
    fromState?: string,
    toState?: string,
    meta?: TransitionMeta
  ): void {
    const list = this.jobEvents.get(jobId) || [];
    list.push({
      id: `evt_${crypto.randomBytes(8).toString('hex')}`,
      jobId,
      type,
      fromState,
      toState,
      actor: meta?.actor,
      detail: meta?.detail,
      createdAt: new Date().toISOString(),
    });
    this.jobEvents.set(jobId, list);
  }

  public calculateChecksum(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  public async createShop(
    name: string,
    ownerEmail: string,
    upiId?: string,
    bankAccountNumber?: string,
    bankIfsc?: string,
    contact: ShopContactDetails = {}
  ): Promise<Shop> {
    const id = `shop_${crypto.randomBytes(6).toString('hex')}`;
    const shop: Shop = {
      id,
      name,
      ownerEmail,
      upiId,
      bankAccountNumber,
      bankIfsc,
      ...contact,
      addressCountry: contact.addressCountry || 'IN',
      payoutStatus: upiId || bankAccountNumber ? 'active' : 'pending',
      createdAt: new Date().toISOString(),
    };
    this.shops.set(id, shop);
    this.shopPricings.set(id, { ...DEFAULT_PRICING_CONFIG });
    return shop;
  }

  public async getShop(id: string): Promise<Shop | undefined> {
    return this.shops.get(id);
  }

  public async createPrinter(
    shopId: string,
    printerName: string,
    baseUrlOrTargetUrl: string,
    qrCodeDataUrl?: string,
    qrGeneratorFn?: (url: string) => Promise<string>
  ): Promise<Printer> {
    const id = `prn_${crypto.randomBytes(6).toString('hex')}`;
    const apiKey = `prn_key_${crypto.randomBytes(16).toString('hex')}`;
    const cleanBase = baseUrlOrTargetUrl.split('/?printer=')[0].split('/p/')[0].replace(/\/$/, '');
    const qrTargetUrl = `${cleanBase}/?printer=${id}`;
    const finalQrDataUrl = qrGeneratorFn ? await qrGeneratorFn(qrTargetUrl) : (qrCodeDataUrl || qrTargetUrl);

    const printer: Printer = {
      id,
      shopId,
      printerName,
      qrTargetUrl,
      qrCodeDataUrl: finalQrDataUrl,
      apiKey,
      status: 'online',
      createdAt: new Date().toISOString(),
    };
    this.printers.set(id, printer);
    return printer;
  }

  public async getPrinter(id: string): Promise<Printer | undefined> {
    return this.printers.get(id);
  }

  public async rotatePrinterApiKey(printerId: string): Promise<{ apiKey: string } | undefined> {
    const printer = this.printers.get(printerId);
    if (!printer) return undefined;
    printer.apiKey = `prn_key_${crypto.randomBytes(16).toString('hex')}`;
    this.printers.set(printerId, printer);
    return { apiKey: printer.apiKey };
  }

  public async getPrinterByApiKey(apiKey: string): Promise<Printer | undefined> {
    for (const printer of this.printers.values()) {
      if (printer.apiKey === apiKey) {
        return printer;
      }
    }
    return undefined;
  }

  public async listPrintersForShop(shopId: string): Promise<Printer[]> {
    return [...this.printers.values()].filter((p) => p.shopId === shopId);
  }

  public async regeneratePrinterQr(
    printerId: string,
    baseUrl: string,
    qrGeneratorFn: (url: string) => Promise<string>
  ): Promise<Printer | undefined> {
    const printer = this.printers.get(printerId);
    if (!printer) return undefined;

    const qrTargetUrl = `${baseUrl.replace(/\/$/, '')}/?printer=${printerId}`;
    printer.qrTargetUrl = qrTargetUrl;
    printer.qrCodeDataUrl = await qrGeneratorFn(qrTargetUrl);
    this.printers.set(printerId, printer);
    return printer;
  }

  /**
   * Allocates a counter token.
   *
   * Already atomic here, and worth saying why rather than leaving it to look
   * like luck: the method is synchronous with no await between reading the
   * counter and writing it back, so Node runs it to completion before serving
   * another request. The Postgres path cannot rely on that and increments a
   * dedicated row in one statement instead.
   */
  private getNextTokenNumber(printerId: string): string {
    const today = new Date().toISOString().substring(0, 10);
    const existing = this.dailyTokenCounters.get(printerId);
    let counter = 1;

    if (existing && existing.dateStr === today) {
      counter = existing.counter + 1;
    }

    this.dailyTokenCounters.set(printerId, { dateStr: today, counter });
    return `#${String(counter).padStart(3, '0')}`;
  }

  public async createPrintJob(
    printerId: string,
    fileName: string,
    fileBase64: string,
    pageCount: number,
    copies: number,
    isColor: boolean,
    autoApprovePayment = true,
    isDuplex = false,
    paperSize = 'A4',
    options: CreateJobOptions = {}
  ): Promise<PrintJob> {
    // Replaying a submission with the same idempotency key returns the original
    // job rather than charging and printing twice (PRD 11).
    if (options.idempotencyKey) {
      const existing = await this.findJobByIdempotencyKey(options.idempotencyKey);
      if (existing) return existing;
    }

    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const orderId = `ord_${crypto.randomBytes(6).toString('hex')}`;
    const orientation: PrintOrientation = options.orientation ?? 'auto';
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);

    const printer = await this.getPrinter(printerId);
    const pricingConfig = printer ? await this.getShopPricing(printer.shopId) : DEFAULT_PRICING_CONFIG;
    // Priced from the grid, which carries A3 as its own rate and both discount
    // models. Falls back to the flat card when the shop has no grid.
    const rateCard = printer ? await this.getShopRateCard(printer.shopId) : buildDefaultRateCard(pricingConfig);

    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const priceSnapshot = calculateGridPriceBreakdown(
      pageCount, copies, isColor, isDuplex, paperSize, rateCard, pricingConfig
    );
    const tokenNumber = this.getNextTokenNumber(printerId);
    const nowIso = new Date().toISOString();
    const printState = autoApprovePayment || options.queueWithoutPayment
      ? PrintState.Queued
      : PrintState.AwaitingPayment;

    const job: PrintJob = {
      id,
      orderId,
      shopId: printer?.shopId ?? '',
      printerId,
      tokenNumber,
      tokenDay: new Date().toISOString().substring(0, 10),
      fileName,
      fileUrl: storageResult.fileUrl,
      s3Key: storageResult.s3Key,
      fileChecksum,
      fileSizeBytes: options.fileSizeBytes ?? fileBuffer.length,
      pageCount,
      copies,
      isColor,
      isDuplex,
      paperSize,
      pageRange: options.pageRange,
      orientation,
      customerName: options.customerName,
      customerPhone: options.customerPhone,
      printConfig: {
        pageCount, copies, isColor, isDuplex, paperSize, pageRange: options.pageRange, orientation,
      },
      totalPriceInCents: priceSnapshot.totalPriceInCents,
      priceSnapshot,
      paymentState: autoApprovePayment ? PaymentState.Paid : PaymentState.Pending,
      printState,
      idempotencyKey: options.idempotencyKey,
      attemptCount: 0,
      maxAttempts: 3,
      queuedAt: printState === PrintState.Queued ? nowIso : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    this.printJobs.set(id, job);
    this.appendEvent(id, 'JOB_CREATED', undefined, printState, { actor: 'customer' });
    return job;
  }

  public async confirmPaymentAndQueueJob(id: string, meta: TransitionMeta = {}): Promise<StateChangeResult> {
    const job = this.printJobs.get(id);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${id}' not found.` };

    const paymentCheck = canTransitionPaymentState(job.paymentState, PaymentState.Paid);
    if (!paymentCheck.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: paymentCheck.reason!, job };
    }

    // A confirmed payment only ever queues the job; it never asserts printing.
    //
    // Where it goes depends on the shop: most queue on payment, some hold every
    // job until someone presses print. Decided here rather than at each of the
    // three callers — webhook, verify and manual override — so they cannot
    // drift into three different ideas of what a paid job does next.
    const portal = await this.getShopPortalConfig(job.shopId);
    const target = portal.autoPrintMode === 'off' ? PrintState.HeldForRelease : PrintState.Queued;

    const printCheck = canTransitionPrintState(job.printState, target);
    const previousPrintState = job.printState;

    job.paymentState = PaymentState.Paid;
    if (printCheck.allowed) {
      job.printState = target;
      if (target === PrintState.Queued) {
        job.queuedAt = job.queuedAt || new Date().toISOString();
      }
    }
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(id, job);

    this.appendEvent(id, 'PAYMENT_CONFIRMED', previousPrintState, job.printState, {
      actor: meta.actor || 'webhook',
      detail: meta.detail,
    });

    return { ok: true, job };
  }

  public async declineJob(jobId: string, reason: string, meta: TransitionMeta = {}): Promise<StateChangeResult> {
    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    const printCheck = canTransitionPrintState(job.printState, PrintState.Cancelled);
    if (!printCheck.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: printCheck.reason!, job };
    }

    // Paid jobs owe the customer money back; unpaid ones simply stop.
    const wasPaid = job.paymentState === PaymentState.Paid;
    const nextPayment = wasPaid ? PaymentState.RefundPending : PaymentState.Cancelled;
    const paymentCheck = canTransitionPaymentState(job.paymentState, nextPayment);

    const from = job.printState;
    job.printState = PrintState.Cancelled;
    job.declineReason = reason;
    if (paymentCheck.allowed) job.paymentState = nextPayment;
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(jobId, job);

    this.appendEvent(jobId, 'JOB_DECLINED', from, PrintState.Cancelled, {
      actor: meta.actor || 'shop',
      detail: { ...(meta.detail || {}), reason, refundDue: wasPaid },
    });

    return { ok: true, job };
  }

  public async recordJobRefund(
    jobId: string,
    refund: { refundId: string; amountInCents: number },
    meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    const check = canTransitionPaymentState(job.paymentState, PaymentState.Refunded);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job };
    }

    // Less than the order total came back, so say so rather than calling a
    // partial refund a refund.
    const partial = refund.amountInCents < (job.totalPriceInCents || 0);

    job.paymentState = partial ? PaymentState.PartiallyRefunded : PaymentState.Refunded;
    job.refundId = refund.refundId;
    job.refundAmountCents = refund.amountInCents;
    job.refundedAt = new Date().toISOString();
    job.updatedAt = job.refundedAt;
    this.printJobs.set(jobId, job);

    this.appendEvent(jobId, 'PAYMENT_REFUNDED', job.printState, job.printState, {
      actor: meta.actor || 'shop',
      detail: { refundId: refund.refundId, amountInCents: refund.amountInCents, partial },
    });

    return { ok: true, job };
  }

  public async recordRefundRequested(
    jobId: string,
    refund: { refundId: string; amountInCents: number; status: string },
    meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    // No state change: the payment stays in RefundPending until the money has
    // actually moved. Only the reference is kept, so the refund's webhook can
    // be matched to this job when it arrives.
    job.refundId = refund.refundId;
    job.refundAmountCents = refund.amountInCents;
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(jobId, job);

    this.appendEvent(jobId, 'REFUND_REQUESTED', job.printState, job.printState, {
      actor: meta.actor || 'shop',
      detail: { refundId: refund.refundId, amountInCents: refund.amountInCents, status: refund.status },
    });

    return { ok: true, job };
  }

  public async recordRefundFailed(
    jobId: string, refundId: string, meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    const check = canTransitionPaymentState(job.paymentState, PaymentState.Paid);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job };
    }

    // The provider rejected the refund, so the money is still the shop's. The
    // print side stays cancelled — the customer is not getting their document —
    // which is why this needs a human to resolve rather than silently standing.
    job.paymentState = PaymentState.Paid;
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(jobId, job);

    this.appendEvent(jobId, 'REFUND_FAILED', job.printState, job.printState, {
      actor: meta.actor || 'webhook',
      detail: { refundId, needsAttention: true },
    });

    return { ok: true, job };
  }

  public async assignJobToDevice(jobId: string, deviceId: string): Promise<StateChangeResult> {
    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    // Already claimed by another device: refuse rather than double-print.
    if (job.deviceId && job.deviceId !== deviceId && job.printState !== PrintState.Queued) {
      return {
        ok: false,
        code: 'ILLEGAL_TRANSITION',
        reason: `Job is already assigned to device '${job.deviceId}'.`,
        job,
      };
    }

    const check = canTransitionPrintState(job.printState, PrintState.Assigned);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job };
    }

    const from = job.printState;
    job.deviceId = deviceId;
    job.printState = PrintState.Assigned;
    job.assignedAt = new Date().toISOString();
    job.attemptCount = (job.attemptCount ?? 0) + 1;
    job.lastAttemptAt = job.assignedAt;
    job.updatedAt = job.assignedAt;
    this.printJobs.set(jobId, job);

    this.appendEvent(jobId, 'ASSIGNED', from, PrintState.Assigned, { actor: `agent:${deviceId}` });
    return { ok: true, job };
  }

  public async getJobEvents(jobId: string, limit = 100): Promise<JobEvent[]> {
    return (this.jobEvents.get(jobId) || []).slice(-limit);
  }

  public async findJobByIdempotencyKey(key: string): Promise<PrintJob | undefined> {
    for (const job of this.printJobs.values()) {
      if (job.idempotencyKey === key) return job;
    }
    return undefined;
  }

  public async reclaimStaleJobs(now: Date = new Date()): Promise<ReclaimResult> {
    const result: ReclaimResult = { requeued: [], escalated: [] };

    for (const job of this.printJobs.values()) {
      // Measure from the last sign of life, not from creation.
      const since = job.lastAttemptAt || job.assignedAt || job.updatedAt;
      if (!isStale(job.printState, since ? new Date(since) : undefined, now)) continue;

      const decision = recoveryActionFor(
        job.printState,
        job.attemptCount ?? 0,
        job.maxAttempts ?? 3
      );

      if (decision.action === 'requeue') {
        const from = job.printState;
        job.printState = PrintState.Queued;
        job.deviceId = undefined;
        job.updatedAt = now.toISOString();
        this.printJobs.set(job.id, job);
        this.appendEvent(job.id, 'RECLAIMED_REQUEUED', from, PrintState.Queued, {
          actor: 'system',
          detail: { reason: decision.reason },
        });
        result.requeued.push(job.id);
      } else {
        const from = job.printState;
        job.printState = PrintState.RequiresShopAction;
        job.failureCategory = FailureCategory.SafetyCritical;
        job.errorMessage = decision.reason;
        job.updatedAt = now.toISOString();
        this.printJobs.set(job.id, job);
        this.appendEvent(job.id, 'RECLAIM_ESCALATED', from, PrintState.RequiresShopAction, {
          actor: 'system',
          detail: { reason: decision.reason },
        });
        result.escalated.push(job.id);
      }
    }

    return result;
  }

  public async getJobsRequiringAction(shopId: string, limit = 50): Promise<PrintJob[]> {
    const jobs = await this.getRecentJobsForShop(shopId, 500);
    return jobs.filter((j) => j.printState === PrintState.RequiresShopAction).slice(0, limit);
  }

  // --- Platform administration (PRD 21, 41) ---

  public async createAdminUser(input: {
    email: string; passwordHash: string; name?: string; role?: string;
  }): Promise<AdminUserRecord> {
    const record: AdminUserRecord & { passwordHash: string } = {
      id: `adm_${crypto.randomBytes(8).toString('hex')}`,
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      name: input.name,
      role: input.role || 'admin',
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.adminUsers.set(record.email, record);
    const { passwordHash, ...safe } = record;
    return safe;
  }

  public async getAdminUserByEmail(
    email: string
  ): Promise<(AdminUserRecord & { passwordHash: string }) | undefined> {
    return this.adminUsers.get(email.trim().toLowerCase());
  }

  public async getAdminUser(id: string): Promise<AdminUserRecord | undefined> {
    for (const user of this.adminUsers.values()) {
      if (user.id === id) {
        const { passwordHash, ...safe } = user;
        return safe;
      }
    }
    return undefined;
  }

  public async countAdminUsers(): Promise<number> {
    return this.adminUsers.size;
  }

  public async createFirstAdminUser(input: {
    email: string; passwordHash: string; name?: string;
  }): Promise<{ ok: true; user: AdminUserRecord } | { ok: false; reason: string }> {
    // Deliberately no await between the check and the write: Node runs this
    // body to completion before any other request is served, so the pair is
    // atomic here without a lock. The Postgres path cannot rely on that and
    // takes an advisory lock instead.
    if (this.adminUsers.size > 0) {
      return { ok: false, reason: 'An administrator already exists. Sign in instead.' };
    }

    const record: AdminUserRecord & { passwordHash: string } = {
      id: `adm_${crypto.randomBytes(8).toString('hex')}`,
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      name: input.name,
      role: 'owner',
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.adminUsers.set(record.email, record);
    const { passwordHash, ...safe } = record;
    return { ok: true, user: safe };
  }

  public async recordAdminLogin(id: string): Promise<void> {
    for (const user of this.adminUsers.values()) {
      if (user.id === id) user.lastLoginAt = new Date().toISOString();
    }
  }

  public async getShopPlan(shopId: string): Promise<ShopPlan | undefined> {
    if (!this.shops.has(shopId)) return undefined;
    const entry = getPlan(DEFAULT_PLAN_TIER)!;
    return this.shopPlans.get(shopId)
      || { planTier: DEFAULT_PLAN_TIER, commissionBps: entry.platformFeeBps, planStatus: 'active' };
  }

  public async updateShopPlan(shopId: string, plan: Partial<ShopPlan>): Promise<ShopPlan | undefined> {
    const current = await this.getShopPlan(shopId);
    if (!current) return undefined;
    const updated: ShopPlan = { ...current, ...plan };
    this.shopPlans.set(shopId, updated);
    return updated;
  }

  public async listAdminShopSummaries(limit = 200, includeArchived = false): Promise<AdminShopSummary[]> {
    const summaries: AdminShopSummary[] = [];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const candidates = [...this.shops.values()]
      .filter((shop) => includeArchived || !this.archivedShops.has(shop.id))
      .slice(0, limit);

    for (const shop of candidates) {
      const printers = [...this.printers.values()].filter((p) => p.shopId === shop.id);
      const jobs = [...this.printJobs.values()].filter((j) => j.shopId === shop.id);
      const plan = (await this.getShopPlan(shop.id))!;

      const grossRevenueCents = jobs
        .filter((j) => j.paymentState === PaymentState.Paid)
        .reduce((sum, j) => sum + j.totalPriceInCents, 0);

      let onlinePrinterCount = 0;
      for (const printer of printers) {
        const telemetry = await this.getPrinterTelemetry(printer.id);
        if (telemetry.isOnline) onlinePrinterCount++;
      }

      const lastJob = jobs
        .map((j) => j.createdAt)
        .sort()
        .pop();

      summaries.push({
        shop,
        plan,
        printerCount: printers.length,
        onlinePrinterCount,
        pairedDeviceCount: [...this.agentDevices.values()].filter(
          (d) => d.status === 'active' && printers.some((p) => p.id === d.printerId)
        ).length,
        totalJobs: jobs.length,
        jobsLast30Days: jobs.filter((j) => new Date(j.createdAt).getTime() >= cutoff).length,
        grossRevenueCents,
        commissionCents: platformFeeFor(grossRevenueCents, plan.commissionBps),
        jobsRequiringAction: jobs.filter((j) => j.printState === PrintState.RequiresShopAction).length,
        lastJobAt: lastJob,
        archivedAt: this.archivedShops.get(shop.id)?.at,
        archiveReason: this.archivedShops.get(shop.id)?.reason,
        canHardDelete: jobs.filter((j) => j.paymentState === PaymentState.Paid).length === 0,
      });
    }

    return summaries;
  }

  public async getAdminOverview(): Promise<AdminOverview> {
    const summaries = await this.listAdminShopSummaries(1000);
    const todayStr = new Date().toISOString().substring(0, 10);
    const allJobs = [...this.printJobs.values()];

    const shopsByTier: Record<string, number> = {};
    for (const s of summaries) {
      shopsByTier[s.plan.planTier] = (shopsByTier[s.plan.planTier] || 0) + 1;
    }

    return {
      totalShops: summaries.length,
      activeShops: summaries.filter((s) => s.jobsLast30Days > 0).length,
      totalPrinters: summaries.reduce((n, s) => n + s.printerCount, 0),
      onlinePrinters: summaries.reduce((n, s) => n + s.onlinePrinterCount, 0),
      totalJobs: allJobs.length,
      jobsToday: allJobs.filter((j) => j.createdAt.startsWith(todayStr)).length,
      grossRevenueCents: summaries.reduce((n, s) => n + s.grossRevenueCents, 0),
      commissionCents: summaries.reduce((n, s) => n + s.commissionCents, 0),
      jobsRequiringAction: summaries.reduce((n, s) => n + s.jobsRequiringAction, 0),
      shopsByTier,
    };
  }

  // --- Shop lifecycle (PRD 21) ---

  public async getShopRemovalSafety(shopId: string): Promise<ShopRemovalSafety> {
    if (!this.shops.has(shopId)) {
      return {
        shopId, exists: false, paidJobCount: 0, totalJobCount: 0,
        printerCount: 0, canHardDelete: false, reason: 'Shop not found.',
      };
    }

    const printers = [...this.printers.values()].filter((p) => p.shopId === shopId);
    const jobs = [...this.printJobs.values()].filter((j) => j.shopId === shopId);
    const paidJobCount = jobs.filter((j) => j.paymentState === PaymentState.Paid).length;
    const canHardDelete = paidJobCount === 0;

    return {
      shopId,
      exists: true,
      paidJobCount,
      totalJobCount: jobs.length,
      printerCount: printers.length,
      canHardDelete,
      reason: canHardDelete
        ? undefined
        : `This shop has ${paidJobCount} paid job(s). Deleting it would destroy payment records, so it can only be archived.`,
    };
  }

  public async hardDeleteShop(shopId: string, force = false): Promise<ShopRemovalResult> {
    const safety = await this.getShopRemovalSafety(shopId);
    if (!safety.exists) return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };
    if (!safety.canHardDelete && !force) {
      return { shopId, ok: false, action: 'refused', reason: safety.reason };
    }

    const printerIds = [...this.printers.values()]
      .filter((p) => p.shopId === shopId)
      .map((p) => p.id);

    for (const job of [...this.printJobs.values()]) {
      if (job.shopId === shopId) {
        this.printJobs.delete(job.id);
        this.jobEvents.delete(job.id);
      }
    }
    for (const id of printerIds) {
      this.printers.delete(id);
      this.telemetries.delete(id);
      for (const [deviceId, device] of this.agentDevices) {
        if (device.printerId === id) this.agentDevices.delete(deviceId);
      }
      for (const [code, pairing] of this.pairingCodes) {
        if (pairing.printerId === id) this.pairingCodes.delete(code);
      }
    }

    this.shops.delete(shopId);
    this.shopPricings.delete(shopId);
    this.shopPlans.delete(shopId);
    this.archivedShops.delete(shopId);

    return { shopId, ok: true, action: 'deleted' };
  }

  public async archiveShop(shopId: string, actor: string, reason?: string): Promise<ShopRemovalResult> {
    if (!this.shops.has(shopId)) return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };

    this.archivedShops.set(shopId, { at: new Date().toISOString(), by: actor, reason });
    const plan = await this.getShopPlan(shopId);
    if (plan) this.shopPlans.set(shopId, { ...plan, planStatus: 'cancelled' });

    return { shopId, ok: true, action: 'archived' };
  }

  public async restoreShop(shopId: string): Promise<ShopRemovalResult> {
    if (!this.shops.has(shopId)) return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };

    this.archivedShops.delete(shopId);
    const plan = await this.getShopPlan(shopId);
    if (plan) this.shopPlans.set(shopId, { ...plan, planStatus: 'active' });

    return { shopId, ok: true, action: 'restored' };
  }

  public async createMerchantUser(input: {
    shopId: string; email: string; passwordHash: string;
    name?: string; phone?: string; role?: string;
  }): Promise<MerchantUserRecord> {
    const record: MerchantUserRecord & { passwordHash: string } = {
      id: `mch_${crypto.randomBytes(8).toString('hex')}`,
      shopId: input.shopId,
      email: input.email.trim().toLowerCase(),
      passwordHash: input.passwordHash,
      name: input.name,
      phone: input.phone,
      role: input.role || 'owner',
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.merchantUsers.set(record.email, record);
    const { passwordHash, ...safe } = record;
    return safe;
  }

  public async getMerchantByEmail(
    email: string
  ): Promise<(MerchantUserRecord & { passwordHash: string }) | undefined> {
    return this.merchantUsers.get(email.trim().toLowerCase());
  }

  public async getMerchantUser(id: string): Promise<MerchantUserRecord | undefined> {
    for (const user of this.merchantUsers.values()) {
      if (user.id === id) {
        const { passwordHash, ...safe } = user;
        return safe;
      }
    }
    return undefined;
  }

  public async countMerchantsForShop(shopId: string): Promise<number> {
    return [...this.merchantUsers.values()].filter((m) => m.shopId === shopId).length;
  }

  public async recordMerchantLogin(id: string): Promise<void> {
    for (const user of this.merchantUsers.values()) {
      if (user.id === id) user.lastLoginAt = new Date().toISOString();
    }
  }

  public async updateShopRazorpayAccount(shopId: string, update: {
    accountId?: string; status: string; error?: string | null;
  }): Promise<void> {
    const shop = this.shops.get(shopId);
    if (!shop) return;

    if (update.accountId) shop.razorpayAccountId = update.accountId;
    shop.razorpayAccountStatus = update.status;
    shop.razorpayAccountError = update.error ?? undefined;
    if (update.status === 'activated' && !shop.razorpayLinkedAt) {
      shop.razorpayLinkedAt = new Date().toISOString();
    }
    this.shops.set(shopId, shop);
  }

  public async recordJobSettlement(
    jobId: string, transferAmountCents: number, serviceFeeCents: number
  ): Promise<void> {
    const job = this.printJobs.get(jobId);
    if (!job) return;
    job.transferAmountCents = transferAmountCents;
    job.serviceFeeCents = serviceFeeCents;
    this.printJobs.set(jobId, job);
  }

  public async purgeAbandonedDocuments(now: Date = new Date()): Promise<{ purged: string[] }> {
    const purged: string[] = [];

    for (const job of this.printJobs.values()) {
      if (job.documentDeletedAt || !job.s3Key) continue;
      if (!isDocumentExpired(job.printState, job.createdAt, now)) continue;

      await this.s3Service.deleteDocument(job.s3Key);
      job.documentDeletedAt = now.toISOString();
      job.fileUrl = '';
      this.printJobs.set(job.id, job);
      this.appendEvent(job.id, 'DOCUMENT_PURGED', job.printState, job.printState, {
        actor: 'system',
        detail: { reason: 'retention window elapsed' },
      });
      purged.push(job.id);
    }

    return { purged };
  }

  public async createJobDownloadUrl(jobId: string): Promise<string | null> {
    const job = this.printJobs.get(jobId);
    if (!job || !job.s3Key || job.documentDeletedAt) return null;
    return this.s3Service.createDownloadUrl(job.s3Key);
  }

  public async createPasswordResetToken(input: {
    tokenHash: string; merchantId: string; email: string; expiresAt: Date;
  }): Promise<void> {
    this.passwordResets.set(input.tokenHash, { ...input });
  }

  public async consumePasswordResetToken(tokenHash: string, now: Date = new Date()): Promise<
    { ok: true; merchantId: string } | { ok: false; reason: string }
  > {
    const record = this.passwordResets.get(tokenHash);
    if (!record) return { ok: false, reason: 'That reset link is not valid.' };
    if (record.usedAt) return { ok: false, reason: 'That reset link has already been used.' };
    if (record.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'That reset link has expired. Request a new one.' };
    }

    record.usedAt = now;
    this.passwordResets.set(tokenHash, record);
    return { ok: true, merchantId: record.merchantId };
  }

  public async countShopUsage(shopId: string, now: Date = new Date()): Promise<{
    ordersThisMonth: number; printers: number; staff: number;
  }> {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let ordersThisMonth = 0;
    for (const job of this.printJobs.values()) {
      if (job.shopId !== shopId) continue;
      if (new Date(job.createdAt) < monthStart) continue;
      ordersThisMonth += 1;
    }

    let printers = 0;
    for (const printer of this.printers.values()) {
      if (printer.shopId === shopId) printers += 1;
    }

    let staff = 0;
    for (const user of this.merchantUsers.values()) {
      if (user.shopId === shopId && user.status === 'active') staff += 1;
    }

    return { ordersThisMonth, printers, staff };
  }

  public async recordFeeLedger(
    jobId: string,
    ledger: {
      grossCents: number; gatewayFeeCents: number; gatewayTaxCents: number;
      commissionBpsUsed: number; feesAreActual: boolean; routeFeeCents?: number;
    }
  ): Promise<void> {
    const job = this.printJobs.get(jobId);
    if (!job) return;
    Object.assign(job, ledger);
    this.printJobs.set(jobId, job);
  }

  public async attachGatewayOrder(
    jobId: string, gatewayOrderId: string, amountCents: number
  ): Promise<void> {
    const job = this.printJobs.get(jobId);
    if (!job) return;
    job.razorpayOrderId = gatewayOrderId;
    job.razorpayOrderAmountCents = amountCents;
    this.printJobs.set(jobId, job);
  }

  public async claimGatewayPayment(
    jobId: string, gatewayPaymentId: string
  ): Promise<{ ok: boolean; reason?: string }> {
    const holder = this.gatewayPayments.get(gatewayPaymentId);
    if (holder && holder !== jobId) {
      return { ok: false, reason: 'That payment has already been used for another order.' };
    }

    const job = this.printJobs.get(jobId);
    if (!job) return { ok: false, reason: `Job '${jobId}' not found.` };

    this.gatewayPayments.set(gatewayPaymentId, jobId);
    job.razorpayPaymentId = gatewayPaymentId;
    this.printJobs.set(jobId, job);
    return { ok: true };
  }

  public async markWebhookEventProcessed(
    eventId: string, _event: string, _jobId?: string
  ): Promise<boolean> {
    if (this.webhookEvents.has(eventId)) return false;
    this.webhookEvents.add(eventId);
    return true;
  }

  public async createContactEnquiry(input: CreateContactEnquiryInput): Promise<ContactEnquiryRecord> {
    const record: ContactEnquiryRecord = {
      id: `enq_${crypto.randomBytes(8).toString('hex')}`,
      name: input.name,
      email: input.email,
      phone: input.phone,
      shopName: input.shopName,
      message: input.message,
      status: 'new',
      source: input.source || 'landing',
      createdAt: new Date().toISOString(),
    };
    this.contactEnquiries.unshift(record);
    return record;
  }

  public async listContactEnquiries(status?: string, limit = 100): Promise<ContactEnquiryRecord[]> {
    return this.contactEnquiries
      .filter((e) => !status || status === 'all' || e.status === status)
      .slice(0, limit);
  }

  public async updateContactEnquiryStatus(
    id: string, status: string, handledBy: string, notes?: string
  ): Promise<ContactEnquiryRecord | undefined> {
    const record = this.contactEnquiries.find((e) => e.id === id);
    if (!record) return undefined;

    record.status = status as ContactEnquiryRecord['status'];
    record.handledBy = handledBy;
    record.handledAt = new Date().toISOString();
    if (notes !== undefined) record.notes = notes;
    return record;
  }

  public async countNewContactEnquiries(): Promise<number> {
    return this.contactEnquiries.filter((e) => e.status === 'new').length;
  }

  public async countRecentEnquiriesFrom(email: string, sinceMs: number): Promise<number> {
    const cutoff = Date.now() - sinceMs;
    const needle = email.trim().toLowerCase();
    return this.contactEnquiries.filter(
      (e) => e.email.toLowerCase() === needle && new Date(e.createdAt).getTime() >= cutoff
    ).length;
  }

  public async recordAdminAudit(entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<void> {
    this.auditLog.unshift({
      ...entry,
      id: `aud_${crypto.randomBytes(8).toString('hex')}`,
      createdAt: new Date().toISOString(),
    });
  }

  public async listAdminAudit(limit = 100): Promise<AdminAuditEntry[]> {
    return this.auditLog.slice(0, limit);
  }

  public async getIdempotencyRecord(key: string): Promise<StoredIdempotencyRecord | undefined> {
    const record = this.idempotencyRecords.get(key);
    if (!record) return undefined;
    if (new Date(record.expiresAt).getTime() < Date.now()) {
      this.idempotencyRecords.delete(key);
      return undefined;
    }
    return record;
  }

  public async saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void> {
    this.idempotencyRecords.set(record.key, record);
  }

  public async getPrintJob(id: string): Promise<PrintJob | undefined> {
    return this.printJobs.get(id);
  }

  public async getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]> {
    const pending: PrintJob[] = [];
    for (const job of this.printJobs.values()) {
      if (job.printerId === printerId && job.printState === PrintState.Queued) {
        pending.push(job);
      }
    }
    return pending;
  }

  public async getRecentJobsForShop(shopId: string, limit = 20): Promise<PrintJob[]> {
    const shopPrinters = new Set<string>();
    for (const printer of this.printers.values()) {
      if (printer.shopId === shopId) {
        shopPrinters.add(printer.id);
      }
    }

    const jobs: PrintJob[] = [];
    for (const job of this.printJobs.values()) {
      if (shopPrinters.has(job.printerId)) {
        jobs.push(job);
      }
    }

    // Sort descending by createdAt
    jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return jobs.slice(0, limit);
  }

  public async updateJobPrintState(
    id: string,
    printState: PrintState,
    errorMessage?: string,
    meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const job = this.printJobs.get(id);
    if (!job) return { ok: false, code: 'NOT_FOUND', reason: `Job '${id}' not found.` };

    const check = canTransitionPrintState(job.printState, printState);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job };
    }

    const from = job.printState;
    const nowIso = new Date().toISOString();

    job.printState = printState;
    job.updatedAt = nowIso;
    if (errorMessage) job.errorMessage = errorMessage;
    if (meta.deviceId) job.deviceId = meta.deviceId;
    if (meta.failureCategory) job.failureCategory = meta.failureCategory;

    if (printState === PrintState.Queued && !job.queuedAt) job.queuedAt = nowIso;
    if (printState === PrintState.Printed) job.printedAt = nowIso;
    if (printState === PrintState.Completed) {
      job.completedAt = nowIso;
      job.printedAt = job.printedAt || nowIso;
    }

    this.printJobs.set(id, job);
    this.appendEvent(id, 'PRINT_STATE_CHANGED', from, printState, {
      actor: meta.actor || 'system',
      detail: errorMessage ? { ...meta.detail, errorMessage } : meta.detail,
    });

    // Purge the stored document as soon as the state no longer needs it (PRD 15).
    if (isDocumentPurgeable(printState) && !job.documentDeletedAt) {
      // The job's own recorded key, not a reconstruction of it. This used to
      // rebuild `temp_docs/${job.id}_${job.fileName}` by hand, which stopped
      // matching the moment the stored name stopped embedding the customer's
      // filename — and a key that does not match deletes nothing.
      if (job.s3Key) await this.s3Service.deleteDocument(job.s3Key);
      job.documentDeletedAt = nowIso;
      // Cleared as well as recorded. A row that says the document is purged
      // while still carrying a usable link to it is not purged.
      job.fileUrl = '';
      this.printJobs.set(id, job);
      this.appendEvent(id, 'DOCUMENT_PURGED', printState, printState, { actor: 'system' });
    }

    return { ok: true, job };
  }

  public async recordHeartbeat(printerId: string, paperStatus: string = 'OK', deviceId?: string): Promise<PrinterTelemetry> {
    const nowIso = new Date().toISOString();
    this.telemetries.set(printerId, { lastHeartbeat: nowIso, paperStatus, deviceId });
    return {
      printerId,
      lastHeartbeat: nowIso,
      isOnline: true,
      paperStatus,
    };
  }

  public async getPrinterTelemetry(printerId: string): Promise<PrinterTelemetry> {
    const record = this.telemetries.get(printerId);
    if (!record) {
      return {
        printerId,
        lastHeartbeat: '',
        isOnline: false,
        paperStatus: 'UNKNOWN',
      };
    }

    const elapsedMs = Date.now() - new Date(record.lastHeartbeat).getTime();
    const isOnline = elapsedMs <= 45000;

    return {
      printerId,
      lastHeartbeat: record.lastHeartbeat,
      isOnline,
      paperStatus: record.paperStatus || 'OK',
    };
  }

  public async listMerchantUsers(shopId: string): Promise<MerchantUserRecord[]> {
    return [...this.merchantUsers.values()]
      .filter((u) => u.shopId === shopId)
      .map(({ passwordHash, ...rest }) => rest)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Finds a merchant by id.
   *
   * The map is keyed by email, because that is what sign-in looks up. Anything
   * working from an id has to scan — which is fine for one shop's staff, and a
   * good deal better than a second index that can fall out of step.
   */
  private findMerchantById(id: string): (MerchantUserRecord & { passwordHash: string }) | undefined {
    for (const user of this.merchantUsers.values()) {
      if (user.id === id) return user;
    }
    return undefined;
  }

  public async updateMerchantUser(
    id: string,
    update: { name?: string; role?: string; status?: string }
  ): Promise<MerchantUserRecord | undefined> {
    const user = this.findMerchantById(id);
    if (!user) return undefined;

    if (update.name !== undefined) user.name = update.name;
    if (update.role !== undefined) user.role = update.role;
    if (update.status !== undefined) user.status = update.status;

    this.merchantUsers.set(user.email, user);
    const { passwordHash, ...rest } = user;
    return rest;
  }

  public async updateMerchantPassword(id: string, passwordHash: string): Promise<boolean> {
    const user = this.findMerchantById(id);
    if (!user) return false;
    user.passwordHash = passwordHash;
    this.merchantUsers.set(user.email, user);
    return true;
  }

  public async updateShopProfile(shopId: string, update: ShopProfileUpdate): Promise<Shop | undefined> {
    const shop = this.shops.get(shopId);
    if (!shop) return undefined;

    const writable = shop as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(update)) {
      if (value === undefined) continue;
      // An empty string clears the field; undefined leaves it alone. Without
      // that distinction a shop could never remove a GSTIN it entered wrongly.
      writable[key] = value === '' ? undefined : value;
    }

    this.shops.set(shopId, shop);
    return shop;
  }

  public async getShopRateCard(shopId: string): Promise<ShopRateCard> {
    const existing = this.rateCards.get(shopId);
    if (existing) return existing;

    // Seeded from the shop's flat rates, so a grid that has never been edited
    // prices exactly as the flat card did.
    const seeded = buildDefaultRateCard(await this.getShopPricing(shopId));
    this.rateCards.set(shopId, seeded);
    return seeded;
  }

  public async updateShopRateCard(shopId: string, card: Partial<ShopRateCard>): Promise<ShopRateCard> {
    const current = await this.getShopRateCard(shopId);

    // Rates are merged cell by cell rather than replaced wholesale: a screen
    // that edits one paper size must not silently delete the others.
    const merged: ShopRateCard = {
      ...current,
      ...card,
      rates: card.rates
        ? mergeRates(current.rates, card.rates)
        : current.rates,
    };

    this.rateCards.set(shopId, merged);
    return merged;
  }

  public async getShopPortalConfig(shopId: string): Promise<ShopPortalConfig> {
    return { ...DEFAULT_PORTAL_CONFIG, ...(this.portalConfigs.get(shopId) ?? {}) };
  }

  public async updateShopPortalConfig(
    shopId: string,
    config: Partial<ShopPortalConfig>
  ): Promise<ShopPortalConfig> {
    const next = { ...(await this.getShopPortalConfig(shopId)), ...config };
    this.portalConfigs.set(shopId, next);
    return next;
  }

  public async getShopPricing(shopId: string): Promise<MerchantPricingConfig> {
    const existing = this.shopPricings.get(shopId);
    return existing || { ...DEFAULT_PRICING_CONFIG };
  }

  public async updateShopPricing(shopId: string, config: Partial<MerchantPricingConfig>): Promise<MerchantPricingConfig> {
    const current = await this.getShopPricing(shopId);
    const updated: MerchantPricingConfig = { ...current, ...config };
    this.shopPricings.set(shopId, updated);
    return updated;
  }

  // --- Agent device identity & pairing (PRD 7.1, 7.2) ---

  public async createPairingCode(printerId: string, code: string, expiresAt: Date): Promise<PairingCodeRecord> {
    const record: PairingCodeRecord = { code, printerId, expiresAt: expiresAt.toISOString() };
    this.pairingCodes.set(code, record);
    return record;
  }

  public async consumePairingCode(code: string, deviceId: string): Promise<PairingCodeRecord | undefined> {
    const record = this.pairingCodes.get(code);
    if (!record) return undefined;
    // Single use, and useless once expired.
    if (record.usedAt) return undefined;
    if (new Date(record.expiresAt).getTime() < Date.now()) return undefined;

    record.usedAt = new Date().toISOString();
    this.pairingCodes.set(code, record);
    return record;
  }

  public async createAgentDevice(input: {
    printerId: string; deviceId: string; tokenHash: string; tokenExpiresAt: Date;
    deviceName?: string; osVersion?: string; agentVersion?: string;
  }): Promise<AgentDeviceRecord> {
    const nowIso = new Date().toISOString();
    const record: AgentDeviceRecord & { tokenHash: string } = {
      id: input.deviceId,
      printerId: input.printerId,
      deviceName: input.deviceName,
      osVersion: input.osVersion,
      agentVersion: input.agentVersion,
      status: 'active',
      tokenHash: input.tokenHash,
      tokenIssuedAt: nowIso,
      tokenExpiresAt: input.tokenExpiresAt.toISOString(),
      createdAt: nowIso,
    };
    this.agentDevices.set(input.deviceId, record);
    return record;
  }

  public async getActiveDeviceByTokenHash(tokenHash: string): Promise<AgentDeviceRecord | undefined> {
    for (const device of this.agentDevices.values()) {
      if (device.tokenHash !== tokenHash) continue;
      if (device.status !== 'active') return undefined;
      if (device.tokenExpiresAt && new Date(device.tokenExpiresAt).getTime() < Date.now()) return undefined;
      return device;
    }
    return undefined;
  }

  public async getAgentDevice(deviceId: string): Promise<AgentDeviceRecord | undefined> {
    return this.agentDevices.get(deviceId);
  }

  public async listAgentDevices(printerId: string): Promise<AgentDeviceRecord[]> {
    return [...this.agentDevices.values()].filter((d) => d.printerId === printerId);
  }

  public async revokeAgentDevice(deviceId: string, reason?: string): Promise<AgentDeviceRecord | undefined> {
    const device = this.agentDevices.get(deviceId);
    if (!device) return undefined;

    device.status = 'revoked';
    device.revokedAt = new Date().toISOString();
    device.revokedReason = reason;
    this.agentDevices.set(deviceId, device);
    return device;
  }

  public async touchAgentDevice(deviceId: string, agentVersion?: string): Promise<void> {
    const device = this.agentDevices.get(deviceId);
    if (!device) return;
    device.lastSeenAt = new Date().toISOString();
    if (agentVersion) device.agentVersion = agentVersion;
    this.agentDevices.set(deviceId, device);
  }

  public async recordSecurityEvent(event: Omit<AgentSecurityEventRecord, 'id' | 'createdAt'>): Promise<void> {
    this.securityEvents.push({
      ...event,
      id: `sec_${crypto.randomBytes(8).toString('hex')}`,
      createdAt: new Date().toISOString(),
    });
  }

  public async listSecurityEvents(printerId: string, limit = 100): Promise<AgentSecurityEventRecord[]> {
    return this.securityEvents.filter((e) => e.printerId === printerId).slice(-limit).reverse();
  }

  public async getShopStats(shopId: string): Promise<MerchantStats> {
    const recent = await this.getRecentJobsForShop(shopId, 500);
    const todayStr = new Date().toISOString().substring(0, 10);

    let todayRevenueCents = 0;
    let todayJobsCount = 0;
    let completedJobsCount = 0;
    let pendingJobsCount = 0;

    for (const job of recent) {
      if (job.createdAt.startsWith(todayStr)) {
        todayJobsCount++;
        if (job.paymentState === PaymentState.Paid) {
          todayRevenueCents += job.totalPriceInCents;
        }
      }
      if (job.printState === PrintState.Completed) {
        completedJobsCount++;
      } else if (job.printState === PrintState.Queued || job.printState === PrintState.Downloading || job.printState === PrintState.Printing) {
        pendingJobsCount++;
      }
    }

    return {
      shopId,
      todayRevenueCents,
      todayJobsCount,
      completedJobsCount,
      pendingJobsCount,
    };
  }
}



/**
 * Applies incoming rate cells over the existing grid.
 *
 * Keyed on the combination rather than position, because a merchant screen may
 * send only the rows it changed and the rest must survive untouched.
 */
export function mergeRates(current: ShopRate[], incoming: ShopRate[]): ShopRate[] {
  const key = (r: { paperSize: string; isColor: boolean; isDuplex: boolean }) =>
    `${r.paperSize}|${r.isColor}|${r.isDuplex}`;

  const byKey = new Map(current.map((r) => [key(r), r]));
  for (const rate of incoming) {
    byKey.set(key(rate), { ...(byKey.get(key(rate)) ?? {}), ...rate });
  }
  return [...byKey.values()];
}
