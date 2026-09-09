import crypto from 'crypto';
import { Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry, MerchantPricingConfig, MerchantStats } from '@printok/shared-types';
import { S3StorageService } from './s3Storage';
import { calculateJobPrice, DEFAULT_PRICING_CONFIG } from './pricing';

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
    paperSize?: string
  ): Promise<PrintJob>;
  getPrintJob(id: string): Promise<PrintJob | undefined>;
  getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]>;
  getRecentJobsForShop(shopId: string, limit?: number): Promise<PrintJob[]>;
  updateJobPrintState(id: string, printState: PrintState, errorMessage?: string): Promise<PrintJob | undefined>;
  confirmPaymentAndQueueJob(id: string): Promise<PrintJob | undefined>;
  recordHeartbeat(printerId: string, paperStatus?: string): Promise<PrinterTelemetry>;
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
  private telemetries = new Map<string, { lastHeartbeat: string; paperStatus?: string }>();
  private dailyTokenCounters = new Map<string, { dateStr: string; counter: number }>();
  private s3Service = new S3StorageService();

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
    paperSize = 'A4'
  ): Promise<PrintJob> {
    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);
    
    // Fetch printer & pricing config if exists
    const printer = await this.getPrinter(printerId);
    const pricingConfig = printer ? await this.getShopPricing(printer.shopId) : DEFAULT_PRICING_CONFIG;

    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const totalPriceInCents = calculateJobPrice(pageCount, copies, isColor, isDuplex, paperSize, pricingConfig);
    const tokenNumber = this.getNextTokenNumber(printerId);

    const job: PrintJob = {
      id,
      printerId,
      tokenNumber,
      fileName,
      fileUrl: storageResult.fileUrl,
      fileChecksum,
      pageCount,
      copies,
      isColor,
      isDuplex,
      paperSize,
      totalPriceInCents,
      paymentState: autoApprovePayment ? PaymentState.Paid : PaymentState.Pending,
      printState: autoApprovePayment ? PrintState.Queued : PrintState.AwaitingPayment,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.printJobs.set(id, job);
    return job;
  }

  public async confirmPaymentAndQueueJob(id: string): Promise<PrintJob | undefined> {
    const job = this.printJobs.get(id);
    if (!job) return undefined;

    job.paymentState = PaymentState.Paid;
    job.printState = PrintState.Queued;
    job.updatedAt = new Date().toISOString();
    this.printJobs.set(id, job);
    return job;
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
    errorMessage?: string
  ): Promise<PrintJob | undefined> {
    const job = this.printJobs.get(id);
    if (!job) return undefined;

    job.printState = printState;
    job.updatedAt = new Date().toISOString();
    if (errorMessage) {
      job.errorMessage = errorMessage;
    }
    this.printJobs.set(id, job);

    if (printState === PrintState.Completed || printState === PrintState.Failed) {
      const s3Key = `temp_docs/${job.id}_${job.fileName}`;
      await this.s3Service.deleteDocument(s3Key);
    }

    return job;
  }

  public async recordHeartbeat(printerId: string, paperStatus: string = 'OK'): Promise<PrinterTelemetry> {
    const nowIso = new Date().toISOString();
    this.telemetries.set(printerId, { lastHeartbeat: nowIso, paperStatus });
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


