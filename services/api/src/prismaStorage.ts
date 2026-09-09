import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry, MerchantPricingConfig, MerchantStats } from '@printok/shared-types';
import { IStorageProvider } from './storage';
import { S3StorageService } from './s3Storage';

/**
 * Production storage provider backed by PostgreSQL via Prisma ORM.
 * All data persists across server restarts.
 */
export class PrismaStorage implements IStorageProvider {
  private prisma = new PrismaClient();
  private s3Service = new S3StorageService();
  private telemetries = new Map<string, { lastHeartbeat: string; paperStatus?: string }>();

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
    const shop = await this.prisma.shop.create({
      data: {
        id,
        name,
        ownerEmail,
        upiId,
        bankAccountNumber,
        bankIfsc,
        payoutStatus: upiId || bankAccountNumber ? 'active' : 'pending',
      },
    });

    return {
      id: shop.id,
      name: shop.name,
      ownerEmail: shop.ownerEmail,
      upiId: shop.upiId ?? undefined,
      bankAccountNumber: shop.bankAccountNumber ?? undefined,
      bankIfsc: shop.bankIfsc ?? undefined,
      payoutStatus: shop.payoutStatus,
      createdAt: shop.createdAt.toISOString(),
    };
  }

  public async getShop(id: string): Promise<Shop | undefined> {
    const shop = await this.prisma.shop.findUnique({ where: { id } });
    if (!shop) return undefined;

    return {
      id: shop.id,
      name: shop.name,
      ownerEmail: shop.ownerEmail,
      upiId: shop.upiId ?? undefined,
      bankAccountNumber: shop.bankAccountNumber ?? undefined,
      bankIfsc: shop.bankIfsc ?? undefined,
      payoutStatus: shop.payoutStatus,
      createdAt: shop.createdAt.toISOString(),
    };
  }

  public async createPrinter(
    shopId: string,
    printerName: string,
    qrTargetUrl: string,
    qrCodeDataUrl: string
  ): Promise<Printer> {
    const id = `prn_${crypto.randomBytes(6).toString('hex')}`;
    const apiKey = `prn_key_${crypto.randomBytes(16).toString('hex')}`;

    const printer = await this.prisma.printer.create({
      data: {
        id,
        shopId,
        printerName,
        qrTargetUrl,
        qrCodeDataUrl,
        apiKey,
        status: 'online',
      },
    });

    return this.mapPrinter(printer);
  }

  public async getPrinter(id: string): Promise<Printer | undefined> {
    const printer = await this.prisma.printer.findUnique({ where: { id } });
    if (!printer) return undefined;
    return this.mapPrinter(printer);
  }

  public async getPrinterByApiKey(apiKey: string): Promise<Printer | undefined> {
    const printer = await this.prisma.printer.findUnique({ where: { apiKey } });
    if (!printer) return undefined;
    return this.mapPrinter(printer);
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

    // Checksum raw bytes to match C# agent SHA256.HashData(fileBytes)
    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);

    // Store in S3 / Temp Storage
    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const pricePerPage = isColor ? 1000 : 200;
    const totalPriceInCents = pricePerPage * pageCount * copies;

    const paymentState = autoApprovePayment ? PaymentState.Paid : PaymentState.Pending;
    const printState = autoApprovePayment ? PrintState.Queued : PrintState.AwaitingPayment;

    const job = await this.prisma.printJob.create({
      data: {
        id,
        printerId,
        fileName,
        s3Key: storageResult.s3Key,
        fileUrl: storageResult.fileUrl,
        fileChecksum,
        pageCount,
        copies,
        isColor,
        totalPriceInCents,
        paymentState,
        printState,
      },
    });

    return this.mapPrintJob(job);
  }

  public async getPrintJob(id: string): Promise<PrintJob | undefined> {
    const job = await this.prisma.printJob.findUnique({ where: { id } });
    if (!job) return undefined;
    return this.mapPrintJob(job);
  }

  public async getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]> {
    const jobs = await this.prisma.printJob.findMany({
      where: { printerId, printState: PrintState.Queued },
    });
    return jobs.map((j) => this.mapPrintJob(j));
  }

  public async updateJobPrintState(
    id: string,
    printState: PrintState,
    errorMessage?: string
  ): Promise<PrintJob | undefined> {
    const existing = await this.prisma.printJob.findUnique({ where: { id } });
    if (!existing) return undefined;

    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        printState,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });

    // Privacy Cleanup: delete temporary document from S3 on terminal states
    if (printState === PrintState.Completed || printState === PrintState.Failed) {
      if (job.s3Key) {
        await this.s3Service.deleteDocument(job.s3Key);
      }
    }

    return this.mapPrintJob(job);
  }

  public async confirmPaymentAndQueueJob(id: string): Promise<PrintJob | undefined> {
    const existing = await this.prisma.printJob.findUnique({ where: { id } });
    if (!existing) return undefined;

    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        paymentState: PaymentState.Paid,
        printState: PrintState.Queued,
      },
    });

    return this.mapPrintJob(job);
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

  public async getRecentJobsForShop(shopId: string, limit = 20): Promise<PrintJob[]> {
    const printers = await this.prisma.printer.findMany({ where: { shopId } });
    const printerIds = printers.map(p => p.id);

    const jobs = await this.prisma.printJob.findMany({
      where: { printerId: { in: printerIds } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return jobs.map(j => this.mapPrintJob(j));
  }

  public async getShopPricing(shopId: string): Promise<MerchantPricingConfig> {
    return {
      bwSinglePerPageCents: 200,
      bwDuplexPerPageCents: 150,
      colorSinglePerPageCents: 1000,
      colorDuplexPerPageCents: 800,
      a3Multiplier: 2.0,
      bulkDiscountThreshold: 50,
      bulkDiscountPercent: 10,
      enableSeparatorPage: false,
      separatorMinPages: 5,
    };
  }

  public async updateShopPricing(shopId: string, config: Partial<MerchantPricingConfig>): Promise<MerchantPricingConfig> {
    const current = await this.getShopPricing(shopId);
    return { ...current, ...config };
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

  // --- Internal mappers: Prisma row → shared-types interface ---

  private mapPrinter(p: {
    id: string; shopId: string; printerName: string; qrTargetUrl: string;
    qrCodeDataUrl: string; apiKey: string; status: string; createdAt: Date;
  }): Printer {
    return {
      id: p.id,
      shopId: p.shopId,
      printerName: p.printerName,
      qrTargetUrl: p.qrTargetUrl,
      qrCodeDataUrl: p.qrCodeDataUrl,
      apiKey: p.apiKey,
      status: p.status as Printer['status'],
      createdAt: p.createdAt.toISOString(),
    };
  }

  private mapPrintJob(j: {
    id: string; printerId: string; fileName: string; fileUrl: string;
    fileChecksum: string; pageCount: number; copies: number; isColor: boolean;
    totalPriceInCents: number; paymentState: string; printState: string;
    errorMessage: string | null; createdAt: Date; updatedAt: Date;
  }): PrintJob {
    return {
      id: j.id,
      printerId: j.printerId,
      fileName: j.fileName,
      fileUrl: j.fileUrl,
      fileChecksum: j.fileChecksum,
      pageCount: j.pageCount,
      copies: j.copies,
      isColor: j.isColor,
      totalPriceInCents: j.totalPriceInCents,
      paymentState: j.paymentState as PaymentState,
      printState: j.printState as PrintState,
      errorMessage: j.errorMessage ?? undefined,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    };
  }
}


