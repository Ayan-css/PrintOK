import crypto from 'crypto';
import { Shop, Printer, PrintJob, PaymentState, PrintState } from '@printok/shared-types';
import { S3StorageService } from './s3Storage';

export interface IStorageProvider {
  calculateChecksum(content: string | Buffer): string;
  createShop(name: string, ownerEmail: string, upiId?: string, bankAccountNumber?: string, bankIfsc?: string): Promise<Shop>;
  getShop(id: string): Promise<Shop | undefined>;
  createPrinter(shopId: string, printerName: string, qrTargetUrl: string, qrCodeDataUrl: string): Promise<Printer>;
  getPrinter(id: string): Promise<Printer | undefined>;
  getPrinterByApiKey(apiKey: string): Promise<Printer | undefined>;
  createPrintJob(
    printerId: string,
    fileName: string,
    fileBase64: string,
    pageCount: number,
    copies: number,
    isColor: boolean,
    autoApprovePayment?: boolean
  ): Promise<PrintJob>;
  getPrintJob(id: string): Promise<PrintJob | undefined>;
  getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]>;
  updateJobPrintState(id: string, printState: PrintState, errorMessage?: string): Promise<PrintJob | undefined>;
  confirmPaymentAndQueueJob(id: string): Promise<PrintJob | undefined>;
}

export class MemoryStorage implements IStorageProvider {
  private shops = new Map<string, Shop>();
  private printers = new Map<string, Printer>();
  private printJobs = new Map<string, PrintJob>();
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
    return shop;
  }

  public async getShop(id: string): Promise<Shop | undefined> {
    return this.shops.get(id);
  }

  public async createPrinter(
    shopId: string,
    printerName: string,
    qrTargetUrl: string,
    qrCodeDataUrl: string
  ): Promise<Printer> {
    const id = `prn_${crypto.randomBytes(6).toString('hex')}`;
    const apiKey = `prn_key_${crypto.randomBytes(16).toString('hex')}`;
    const printer: Printer = {
      id,
      shopId,
      printerName,
      qrTargetUrl,
      qrCodeDataUrl,
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

  public async createPrintJob(
    printerId: string,
    fileName: string,
    fileBase64: string,
    pageCount: number,
    copies: number,
    isColor: boolean,
    autoApprovePayment = true
  ): Promise<PrintJob> {
    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    // Checksum raw bytes (not base64 string) to match C# agent SHA256.HashData(fileBytes)
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);
    
    // Store in S3 / Temp Storage
    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const pricePerPage = isColor ? 1000 : 200;
    const totalPriceInCents = pricePerPage * pageCount * copies;

    const job: PrintJob = {
      id,
      printerId,
      fileName,
      fileUrl: storageResult.fileUrl,
      fileChecksum,
      pageCount,
      copies,
      isColor,
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

    // Privacy Cleanup: If job is Completed or Failed, delete temporary document from S3
    if (printState === PrintState.Completed || printState === PrintState.Failed) {
      const s3Key = `temp_docs/${job.id}_${job.fileName}`;
      await this.s3Service.deleteDocument(s3Key);
    }

    return job;
  }
}
