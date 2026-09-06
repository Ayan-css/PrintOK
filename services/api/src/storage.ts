import crypto from 'crypto';
import { Shop, Printer, PrintJob, PaymentState, PrintState } from '@printok/shared-types';

export class MemoryStorage {
  private shops = new Map<string, Shop>();
  private printers = new Map<string, Printer>();
  private printJobs = new Map<string, PrintJob>();

  // Helper: Create MD5/SHA256 checksum for PDF content verification
  public calculateChecksum(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // Shop Operations
  public createShop(name: string, ownerEmail: string): Shop {
    const id = `shop_${crypto.randomBytes(6).toString('hex')}`;
    const shop: Shop = {
      id,
      name,
      ownerEmail,
      createdAt: new Date().toISOString(),
    };
    this.shops.set(id, shop);
    return shop;
  }

  public getShop(id: string): Shop | undefined {
    return this.shops.get(id);
  }

  // Printer Operations
  public createPrinter(
    shopId: string,
    printerName: string,
    qrTargetUrl: string,
    qrCodeDataUrl: string
  ): Printer {
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

  public getPrinter(id: string): Printer | undefined {
    return this.printers.get(id);
  }

  public getPrinterByApiKey(apiKey: string): Printer | undefined {
    for (const printer of this.printers.values()) {
      if (printer.apiKey === apiKey) {
        return printer;
      }
    }
    return undefined;
  }

  // Print Job Operations
  public createPrintJob(
    printerId: string,
    fileName: string,
    fileBase64: string,
    pageCount: number,
    copies: number,
    isColor: boolean
  ): PrintJob {
    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const fileChecksum = this.calculateChecksum(fileBase64);
    
    // Simple Pricing logic: 200 cents (₹2 / $2) per BW page, 1000 cents for color page
    const pricePerPage = isColor ? 1000 : 200;
    const totalPriceInCents = pricePerPage * pageCount * copies;

    const job: PrintJob = {
      id,
      printerId,
      fileName,
      fileUrl: `data:application/pdf;base64,${fileBase64}`,
      fileChecksum,
      pageCount,
      copies,
      isColor,
      totalPriceInCents,
      paymentState: PaymentState.Paid, // Auto-marked Paid for Milestone 1 prototype
      printState: PrintState.Queued,   // Queued immediately after payment
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.printJobs.set(id, job);
    return job;
  }

  public getPrintJob(id: string): PrintJob | undefined {
    return this.printJobs.get(id);
  }

  public getPendingJobsForPrinter(printerId: string): PrintJob[] {
    const pending: PrintJob[] = [];
    for (const job of this.printJobs.values()) {
      if (job.printerId === printerId && job.printState === PrintState.Queued) {
        pending.push(job);
      }
    }
    return pending;
  }

  public updateJobPrintState(
    id: string,
    printState: PrintState,
    errorMessage?: string
  ): PrintJob | undefined {
    const job = this.printJobs.get(id);
    if (!job) return undefined;

    job.printState = printState;
    job.updatedAt = new Date().toISOString();
    if (errorMessage) {
      job.errorMessage = errorMessage;
    }
    this.printJobs.set(id, job);
    return job;
  }
}
