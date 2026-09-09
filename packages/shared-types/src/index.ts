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
}

/**
 * Print job execution state model
 */
export enum PrintState {
  Created = 'Created',
  AwaitingPayment = 'AwaitingPayment',
  Queued = 'Queued',
  Downloading = 'Downloading',
  Printing = 'Printing',
  Printed = 'Printed',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled',
  RequiresShopAction = 'RequiresShopAction',
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
  totalPriceInCents: number;
  paymentState: PaymentState;
  printState: PrintState;
  errorMessage?: string;
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


