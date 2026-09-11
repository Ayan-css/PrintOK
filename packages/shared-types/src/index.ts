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
export interface Shop {
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
}

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
