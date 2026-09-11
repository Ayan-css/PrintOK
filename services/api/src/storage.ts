import crypto from 'crypto';
import {
  Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry,
  MerchantPricingConfig, MerchantStats, JobEvent, FailureCategory,
} from '@printok/shared-types';
import { S3StorageService } from './s3Storage';
import { calculateJobPriceBreakdown, DEFAULT_PRICING_CONFIG } from './pricing';
import { canTransitionPrintState, canTransitionPaymentState, isDocumentPurgeable } from './jobStateMachine';

/** Optional inputs captured at job creation (PRD 9, 11). */
export interface CreateJobOptions {
  pageRange?: string;
  /** Client-supplied key that deduplicates repeated submissions. */
  idempotencyKey?: string;
  fileSizeBytes?: number;
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
  createShop(name: string, ownerEmail: string, upiId?: string, bankAccountNumber?: string, bankIfsc?: string): Promise<Shop>;
  getShop(id: string): Promise<Shop | undefined>;
  createPrinter(shopId: string, printerName: string, baseUrlOrTargetUrl: string, qrCodeDataUrl?: string, qrGeneratorFn?: (url: string) => Promise<string>): Promise<Printer>;
  getPrinter(id: string): Promise<Printer | undefined>;
  getPrinterByApiKey(apiKey: string): Promise<Printer | undefined>;
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
  findJobByIdempotencyKey(key: string): Promise<PrintJob | undefined>;
  getIdempotencyRecord(key: string): Promise<StoredIdempotencyRecord | undefined>;
  saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void>;

  recordHeartbeat(printerId: string, paperStatus?: string, deviceId?: string, agentVersion?: string): Promise<PrinterTelemetry>;
  getPrinterTelemetry(printerId: string): Promise<PrinterTelemetry>;
  getShopPricing(shopId: string): Promise<MerchantPricingConfig>;
  updateShopPricing(shopId: string, config: Partial<MerchantPricingConfig>): Promise<MerchantPricingConfig>;
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
    bankIfsc?: string
  ): Promise<Shop> {
    const id = `shop_${crypto.randomBytes(6).toString('hex')}`;
    const shop: Shop = {
      id,
      name,
      ownerEmail,
      upiId,
      bankAccountNumber,
      bankIfsc,
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

  public async getPrinterByApiKey(apiKey: string): Promise<Printer | undefined> {
    for (const printer of this.printers.values()) {
      if (printer.apiKey === apiKey) {
        return printer;
      }
    }
    return undefined;
  }

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
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);

    const printer = await this.getPrinter(printerId);
    const pricingConfig = printer ? await this.getShopPricing(printer.shopId) : DEFAULT_PRICING_CONFIG;

    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const priceSnapshot = calculateJobPriceBreakdown(pageCount, copies, isColor, isDuplex, paperSize, pricingConfig);
    const tokenNumber = this.getNextTokenNumber(printerId);
    const nowIso = new Date().toISOString();
    const printState = autoApprovePayment ? PrintState.Queued : PrintState.AwaitingPayment;

    const job: PrintJob = {
      id,
      orderId,
      shopId: printer?.shopId ?? '',
      printerId,
      tokenNumber,
      fileName,
      fileUrl: storageResult.fileUrl,
      fileChecksum,
      fileSizeBytes: options.fileSizeBytes ?? fileBuffer.length,
      pageCount,
      copies,
      isColor,
      isDuplex,
      paperSize,
      pageRange: options.pageRange,
      printConfig: { pageCount, copies, isColor, isDuplex, paperSize, pageRange: options.pageRange },
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
    const printCheck = canTransitionPrintState(job.printState, PrintState.Queued);
    const previousPrintState = job.printState;

    job.paymentState = PaymentState.Paid;
    if (printCheck.allowed) {
      job.printState = PrintState.Queued;
      job.queuedAt = job.queuedAt || new Date().toISOString();
    }
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(id, job);

    this.appendEvent(id, 'PAYMENT_CONFIRMED', previousPrintState, job.printState, {
      actor: meta.actor || 'webhook',
      detail: meta.detail,
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
      const s3Key = `temp_docs/${job.id}_${job.fileName}`;
      await this.s3Service.deleteDocument(s3Key);
      job.documentDeletedAt = nowIso;
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


