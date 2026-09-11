import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry,
  MerchantPricingConfig, MerchantStats, JobEvent, PriceSnapshot, PrintConfigSnapshot,
  FailureCategory,
} from '@printok/shared-types';
import {
  IStorageProvider, CreateJobOptions, TransitionMeta, StateChangeResult, StoredIdempotencyRecord,
  AgentDeviceRecord, AgentSecurityEventRecord, PairingCodeRecord,
} from './storage';
import { S3StorageService } from './s3Storage';
import { calculateJobPriceBreakdown, DEFAULT_PRICING_CONFIG } from './pricing';
import { canTransitionPrintState, canTransitionPaymentState, isDocumentPurgeable } from './jobStateMachine';

const HEARTBEAT_ONLINE_WINDOW_MS = 45_000;

/**
 * Production storage provider backed by PostgreSQL via Prisma.
 *
 * Everything here is durable by design: shop rate cards, agent telemetry and the
 * job lifecycle trail all live in the database rather than in process memory, so
 * they survive a restart and stay correct behind more than one API instance.
 */
export class PrismaStorage implements IStorageProvider {
  private prisma = new PrismaClient();
  private s3Service = new S3StorageService();

  public calculateChecksum(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  // ---------------------------------------------------------------- shops ---

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
        // Every shop starts with an explicit rate card row so the merchant
        // Rates Matrix has something real to edit.
        pricing: { create: {} },
      },
    });

    return this.mapShop(shop);
  }

  public async getShop(id: string): Promise<Shop | undefined> {
    const shop = await this.prisma.shop.findUnique({ where: { id } });
    return shop ? this.mapShop(shop) : undefined;
  }

  // -------------------------------------------------------------- printers ---

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

    const printer = await this.prisma.printer.create({
      data: { id, shopId, printerName, qrTargetUrl, qrCodeDataUrl: finalQrDataUrl, apiKey, status: 'online' },
    });

    return this.mapPrinter(printer);
  }

  public async getPrinter(id: string): Promise<Printer | undefined> {
    const printer = await this.prisma.printer.findUnique({ where: { id } });
    return printer ? this.mapPrinter(printer) : undefined;
  }

  public async getPrinterByApiKey(apiKey: string): Promise<Printer | undefined> {
    const printer = await this.prisma.printer.findUnique({ where: { apiKey } });
    return printer ? this.mapPrinter(printer) : undefined;
  }

  // ------------------------------------------------------------------ jobs ---

  /**
   * Per-printer daily counter shown to the customer at the counter.
   *
   * Derived from the day's job count, so two submissions landing in the same
   * millisecond can collide on a token. The token is a human-facing convenience,
   * not an identifier — `orderId` is the unique reference.
   */
  private async getNextTokenNumber(printerId: string): Promise<string> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await this.prisma.printJob.count({
      where: { printerId, createdAt: { gte: startOfDay } },
    });

    return `#${String(todayCount + 1).padStart(3, '0')}`;
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
    // Replaying a submission with the same key returns the original job rather
    // than charging the customer and printing a second time (PRD 11).
    if (options.idempotencyKey) {
      const existing = await this.findJobByIdempotencyKey(options.idempotencyKey);
      if (existing) return existing;
    }

    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const orderId = `ord_${crypto.randomBytes(6).toString('hex')}`;

    const fileBuffer = Buffer.from(fileBase64, 'base64');
    const fileChecksum = this.calculateChecksum(fileBuffer);

    const printer = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!printer) {
      throw new Error(`Printer '${printerId}' not found.`);
    }

    // Price from the shop's own rate card. This previously used hardcoded
    // constants, which made every merchant's configured rates a no-op.
    const pricingConfig = await this.getShopPricing(printer.shopId);
    const priceSnapshot = calculateJobPriceBreakdown(pageCount, copies, isColor, isDuplex, paperSize, pricingConfig);

    const storageResult = await this.s3Service.storeDocument(id, fileName, fileBase64);

    const tokenNumber = await this.getNextTokenNumber(printerId);
    const now = new Date();
    const printState = autoApprovePayment ? PrintState.Queued : PrintState.AwaitingPayment;

    const printConfig: PrintConfigSnapshot = {
      pageCount, copies, isColor, isDuplex, paperSize, pageRange: options.pageRange,
    };

    const job = await this.prisma.printJob.create({
      data: {
        id,
        orderId,
        shopId: printer.shopId,
        printerId,
        tokenNumber,
        fileName,
        s3Key: storageResult.s3Key,
        fileUrl: storageResult.fileUrl,
        fileChecksum,
        fileSizeBytes: options.fileSizeBytes ?? fileBuffer.length,
        pageCount,
        copies,
        isColor,
        isDuplex,
        paperSize,
        pageRange: options.pageRange,
        printConfig: printConfig as unknown as Prisma.InputJsonValue,
        totalPriceInCents: priceSnapshot.totalPriceInCents,
        priceSnapshot: priceSnapshot as unknown as Prisma.InputJsonValue,
        paymentState: autoApprovePayment ? PaymentState.Paid : PaymentState.Pending,
        printState,
        idempotencyKey: options.idempotencyKey,
        queuedAt: printState === PrintState.Queued ? now : null,
        events: {
          create: {
            type: 'JOB_CREATED',
            toState: printState,
            actor: 'customer',
            detail: {
              totalPriceInCents: priceSnapshot.totalPriceInCents,
              perPageRateCents: priceSnapshot.perPageRateCents,
            } as Prisma.InputJsonValue,
          },
        },
      },
    });

    return this.mapPrintJob(job);
  }

  public async getPrintJob(id: string): Promise<PrintJob | undefined> {
    const job = await this.prisma.printJob.findUnique({ where: { id } });
    return job ? this.mapPrintJob(job) : undefined;
  }

  public async findJobByIdempotencyKey(key: string): Promise<PrintJob | undefined> {
    const job = await this.prisma.printJob.findUnique({ where: { idempotencyKey: key } });
    return job ? this.mapPrintJob(job) : undefined;
  }

  public async getPendingJobsForPrinter(printerId: string): Promise<PrintJob[]> {
    const jobs = await this.prisma.printJob.findMany({
      where: { printerId, printState: PrintState.Queued },
      orderBy: { createdAt: 'asc' },
    });
    return jobs.map((j) => this.mapPrintJob(j));
  }

  public async getRecentJobsForShop(shopId: string, limit = 20): Promise<PrintJob[]> {
    const jobs = await this.prisma.printJob.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return jobs.map((j) => this.mapPrintJob(j));
  }

  public async updateJobPrintState(
    id: string,
    printState: PrintState,
    errorMessage?: string,
    meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const existing = await this.prisma.printJob.findUnique({ where: { id } });
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: `Job '${id}' not found.` };

    const from = existing.printState as PrintState;
    const check = canTransitionPrintState(from, printState);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job: this.mapPrintJob(existing) };
    }

    const now = new Date();
    const purge = isDocumentPurgeable(printState) && !existing.documentDeletedAt;

    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        printState,
        ...(errorMessage ? { errorMessage } : {}),
        ...(meta.deviceId ? { deviceId: meta.deviceId } : {}),
        ...(meta.failureCategory ? { failureCategory: meta.failureCategory } : {}),
        ...(printState === PrintState.Queued && !existing.queuedAt ? { queuedAt: now } : {}),
        ...(printState === PrintState.Printed ? { printedAt: now } : {}),
        ...(printState === PrintState.Completed
          ? { completedAt: now, printedAt: existing.printedAt ?? now }
          : {}),
        ...(purge ? { documentDeletedAt: now } : {}),
        events: {
          create: {
            type: 'PRINT_STATE_CHANGED',
            fromState: from,
            toState: printState,
            actor: meta.actor || 'system',
            detail: (errorMessage
              ? { ...(meta.detail || {}), errorMessage }
              : meta.detail || {}) as Prisma.InputJsonValue,
          },
        },
      },
    });

    // Delete the stored bytes once the state no longer needs them (PRD 15).
    // Recorded as an event so a failed deletion is observable and retryable.
    if (purge && existing.s3Key) {
      try {
        await this.s3Service.deleteDocument(existing.s3Key);
        await this.recordEvent(id, 'DOCUMENT_PURGED', printState, printState, 'system');
      } catch (err: any) {
        await this.recordEvent(id, 'DOCUMENT_PURGE_FAILED', printState, printState, 'system', {
          error: String(err?.message || err),
          s3Key: existing.s3Key,
        });
      }
    }

    return { ok: true, job: this.mapPrintJob(job) };
  }

  public async confirmPaymentAndQueueJob(id: string, meta: TransitionMeta = {}): Promise<StateChangeResult> {
    const existing = await this.prisma.printJob.findUnique({ where: { id } });
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: `Job '${id}' not found.` };

    const paymentCheck = canTransitionPaymentState(existing.paymentState as PaymentState, PaymentState.Paid);
    if (!paymentCheck.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: paymentCheck.reason!, job: this.mapPrintJob(existing) };
    }

    // Payment success queues the job. It never claims the document printed.
    const from = existing.printState as PrintState;
    const canQueue = canTransitionPrintState(from, PrintState.Queued).allowed;
    const now = new Date();

    const job = await this.prisma.printJob.update({
      where: { id },
      data: {
        paymentState: PaymentState.Paid,
        ...(meta.detail?.paymentRef ? { paymentRef: String(meta.detail.paymentRef) } : {}),
        ...(canQueue ? { printState: PrintState.Queued, queuedAt: existing.queuedAt ?? now } : {}),
        events: {
          create: {
            type: 'PAYMENT_CONFIRMED',
            fromState: from,
            toState: canQueue ? PrintState.Queued : from,
            actor: meta.actor || 'webhook',
            detail: (meta.detail || {}) as Prisma.InputJsonValue,
          },
        },
      },
    });

    return { ok: true, job: this.mapPrintJob(job) };
  }

  public async assignJobToDevice(jobId: string, deviceId: string): Promise<StateChangeResult> {
    const existing = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    if (existing.deviceId && existing.deviceId !== deviceId && existing.printState !== PrintState.Queued) {
      return {
        ok: false,
        code: 'ILLEGAL_TRANSITION',
        reason: `Job is already assigned to device '${existing.deviceId}'.`,
        job: this.mapPrintJob(existing),
      };
    }

    const from = existing.printState as PrintState;
    const check = canTransitionPrintState(from, PrintState.Assigned);
    if (!check.allowed) {
      return { ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!, job: this.mapPrintJob(existing) };
    }

    const now = new Date();

    // Conditional update: only claim the job if it is still in the state we
    // read. A second agent racing for the same job updates zero rows and is
    // told to back off rather than printing a duplicate (PRD 11).
    const claimed = await this.prisma.printJob.updateMany({
      where: { id: jobId, printState: from },
      data: {
        printState: PrintState.Assigned,
        deviceId,
        assignedAt: now,
        lastAttemptAt: now,
        attemptCount: { increment: 1 },
      },
    });

    if (claimed.count === 0) {
      const current = await this.prisma.printJob.findUnique({ where: { id: jobId } });
      return {
        ok: false,
        code: 'ILLEGAL_TRANSITION',
        reason: 'Job was claimed by another device.',
        job: this.mapPrintJob(current!),
      };
    }

    await this.recordEvent(jobId, 'ASSIGNED', from, PrintState.Assigned, `agent:${deviceId}`);

    const job = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    return { ok: true, job: this.mapPrintJob(job!) };
  }

  public async getJobEvents(jobId: string, limit = 100): Promise<JobEvent[]> {
    const events = await this.prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return events.map((e) => ({
      id: e.id,
      jobId: e.jobId,
      type: e.type,
      fromState: e.fromState ?? undefined,
      toState: e.toState ?? undefined,
      actor: e.actor ?? undefined,
      detail: (e.detail as Record<string, unknown>) ?? undefined,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private async recordEvent(
    jobId: string,
    type: string,
    fromState?: string,
    toState?: string,
    actor?: string,
    detail?: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.jobEvent.create({
      data: {
        jobId,
        type,
        fromState,
        toState,
        actor,
        detail: (detail || {}) as Prisma.InputJsonValue,
      },
    });
  }

  // ---------------------------------------------------------- idempotency ---

  public async getIdempotencyRecord(key: string): Promise<StoredIdempotencyRecord | undefined> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
    if (!record) return undefined;

    if (record.expiresAt.getTime() < Date.now()) {
      await this.prisma.idempotencyRecord.delete({ where: { key } }).catch(() => undefined);
      return undefined;
    }

    return {
      key: record.key,
      scope: record.scope,
      requestHash: record.requestHash,
      statusCode: record.statusCode,
      responseBody: record.responseBody,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  public async saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void> {
    const data = {
      scope: record.scope,
      requestHash: record.requestHash,
      statusCode: record.statusCode,
      responseBody: (record.responseBody ?? {}) as Prisma.InputJsonValue,
      expiresAt: new Date(record.expiresAt),
    };

    await this.prisma.idempotencyRecord.upsert({
      where: { key: record.key },
      create: { key: record.key, ...data },
      update: data,
    });
  }

  // --------------------------------------- agent device identity & pairing ---

  public async createPairingCode(printerId: string, code: string, expiresAt: Date): Promise<PairingCodeRecord> {
    const record = await this.prisma.agentPairingCode.create({
      data: { code, printerId, expiresAt },
    });
    return {
      code: record.code,
      printerId: record.printerId,
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  public async consumePairingCode(code: string, deviceId: string): Promise<PairingCodeRecord | undefined> {
    // Conditional update: the code is claimed only if it is still unused and
    // unexpired, so two machines racing on the same code cannot both pair.
    const claimed = await this.prisma.agentPairingCode.updateMany({
      where: { code, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date(), usedByDeviceId: deviceId },
    });

    if (claimed.count === 0) return undefined;

    const record = await this.prisma.agentPairingCode.findUnique({ where: { code } });
    if (!record) return undefined;

    return {
      code: record.code,
      printerId: record.printerId,
      expiresAt: record.expiresAt.toISOString(),
      usedAt: record.usedAt?.toISOString(),
    };
  }

  public async createAgentDevice(input: {
    printerId: string; deviceId: string; tokenHash: string; tokenExpiresAt: Date;
    deviceName?: string; osVersion?: string; agentVersion?: string;
  }): Promise<AgentDeviceRecord> {
    const device = await this.prisma.agentDevice.create({
      data: {
        id: input.deviceId,
        printerId: input.printerId,
        tokenHash: input.tokenHash,
        tokenExpiresAt: input.tokenExpiresAt,
        deviceName: input.deviceName,
        osVersion: input.osVersion,
        agentVersion: input.agentVersion,
      },
    });
    return this.mapDevice(device);
  }

  public async getActiveDeviceByTokenHash(tokenHash: string): Promise<AgentDeviceRecord | undefined> {
    const device = await this.prisma.agentDevice.findUnique({ where: { tokenHash } });
    if (!device || device.status !== 'active') return undefined;
    if (device.tokenExpiresAt && device.tokenExpiresAt.getTime() < Date.now()) return undefined;
    return this.mapDevice(device);
  }

  public async getAgentDevice(deviceId: string): Promise<AgentDeviceRecord | undefined> {
    const device = await this.prisma.agentDevice.findUnique({ where: { id: deviceId } });
    return device ? this.mapDevice(device) : undefined;
  }

  public async listAgentDevices(printerId: string): Promise<AgentDeviceRecord[]> {
    const devices = await this.prisma.agentDevice.findMany({
      where: { printerId },
      orderBy: { createdAt: 'desc' },
    });
    return devices.map((d) => this.mapDevice(d));
  }

  public async revokeAgentDevice(deviceId: string, reason?: string): Promise<AgentDeviceRecord | undefined> {
    const existing = await this.prisma.agentDevice.findUnique({ where: { id: deviceId } });
    if (!existing) return undefined;

    const device = await this.prisma.agentDevice.update({
      where: { id: deviceId },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
    });

    return this.mapDevice(device);
  }

  public async touchAgentDevice(deviceId: string, agentVersion?: string): Promise<void> {
    await this.prisma.agentDevice.updateMany({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), ...(agentVersion ? { agentVersion } : {}) },
    });
  }

  public async recordSecurityEvent(event: Omit<AgentSecurityEventRecord, 'id' | 'createdAt'>): Promise<void> {
    await this.prisma.agentSecurityEvent.create({
      data: {
        printerId: event.printerId,
        deviceId: event.deviceId,
        type: event.type,
        severity: event.severity,
        detail: (event.detail || {}) as Prisma.InputJsonValue,
      },
    });
  }

  public async listSecurityEvents(printerId: string, limit = 100): Promise<AgentSecurityEventRecord[]> {
    const events = await this.prisma.agentSecurityEvent.findMany({
      where: { printerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return events.map((e) => ({
      id: e.id,
      printerId: e.printerId ?? undefined,
      deviceId: e.deviceId ?? undefined,
      type: e.type,
      severity: e.severity as AgentSecurityEventRecord['severity'],
      detail: (e.detail as Record<string, unknown>) ?? undefined,
      createdAt: e.createdAt.toISOString(),
    }));
  }

  private mapDevice(d: {
    id: string; printerId: string; deviceName: string | null; osVersion: string | null;
    agentVersion: string | null; status: string; tokenIssuedAt: Date; tokenExpiresAt: Date | null;
    revokedAt: Date | null; revokedReason: string | null; lastSeenAt: Date | null; createdAt: Date;
  }): AgentDeviceRecord {
    return {
      id: d.id,
      printerId: d.printerId,
      deviceName: d.deviceName ?? undefined,
      osVersion: d.osVersion ?? undefined,
      agentVersion: d.agentVersion ?? undefined,
      status: d.status as AgentDeviceRecord['status'],
      tokenIssuedAt: d.tokenIssuedAt.toISOString(),
      tokenExpiresAt: d.tokenExpiresAt?.toISOString(),
      revokedAt: d.revokedAt?.toISOString(),
      revokedReason: d.revokedReason ?? undefined,
      lastSeenAt: d.lastSeenAt?.toISOString(),
      createdAt: d.createdAt.toISOString(),
    };
  }

  // ------------------------------------------------------------ telemetry ---

  public async recordHeartbeat(
    printerId: string,
    paperStatus: string = 'OK',
    deviceId?: string,
    agentVersion?: string
  ): Promise<PrinterTelemetry> {
    const now = new Date();

    const record = await this.prisma.printerTelemetry.upsert({
      where: { printerId },
      create: { printerId, lastHeartbeat: now, paperStatus, deviceId, agentVersion },
      update: { lastHeartbeat: now, paperStatus, ...(deviceId ? { deviceId } : {}), ...(agentVersion ? { agentVersion } : {}) },
    });

    return {
      printerId,
      lastHeartbeat: record.lastHeartbeat.toISOString(),
      isOnline: true,
      paperStatus: record.paperStatus,
    };
  }

  public async getPrinterTelemetry(printerId: string): Promise<PrinterTelemetry> {
    const record = await this.prisma.printerTelemetry.findUnique({ where: { printerId } });

    if (!record) {
      return { printerId, lastHeartbeat: '', isOnline: false, paperStatus: 'UNKNOWN' };
    }

    return {
      printerId,
      lastHeartbeat: record.lastHeartbeat.toISOString(),
      isOnline: Date.now() - record.lastHeartbeat.getTime() <= HEARTBEAT_ONLINE_WINDOW_MS,
      paperStatus: record.paperStatus || 'OK',
    };
  }

  // -------------------------------------------------------------- pricing ---

  public async getShopPricing(shopId: string): Promise<MerchantPricingConfig> {
    const row = await this.prisma.shopPricing.findUnique({ where: { shopId } });
    if (!row) return { ...DEFAULT_PRICING_CONFIG };

    return {
      bwSinglePerPageCents: row.bwSinglePerPageCents,
      bwDuplexPerPageCents: row.bwDuplexPerPageCents,
      colorSinglePerPageCents: row.colorSinglePerPageCents,
      colorDuplexPerPageCents: row.colorDuplexPerPageCents,
      a3Multiplier: row.a3Multiplier,
      bulkDiscountThreshold: row.bulkDiscountThreshold,
      bulkDiscountPercent: row.bulkDiscountPercent,
      enableSeparatorPage: row.enableSeparatorPage,
      separatorMinPages: row.separatorMinPages,
    };
  }

  public async updateShopPricing(
    shopId: string,
    config: Partial<MerchantPricingConfig>
  ): Promise<MerchantPricingConfig> {
    const current = await this.getShopPricing(shopId);
    const merged: MerchantPricingConfig = { ...current, ...config };

    // Persisted, unlike the previous implementation which returned the merged
    // object without writing it, so merchant rate edits silently vanished.
    await this.prisma.shopPricing.upsert({
      where: { shopId },
      create: { shopId, ...merged },
      update: merged,
    });

    return merged;
  }

  public async getShopStats(shopId: string): Promise<MerchantStats> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // Aggregated in the database rather than by scanning recent jobs in Node,
    // so the numbers stay correct once a shop exceeds the page size.
    const [todayAgg, completedCount, pendingCount] = await Promise.all([
      this.prisma.printJob.aggregate({
        where: { shopId, createdAt: { gte: startOfDay } },
        _count: { _all: true },
        _sum: { totalPriceInCents: true },
      }),
      this.prisma.printJob.count({ where: { shopId, printState: PrintState.Completed } }),
      this.prisma.printJob.count({
        where: {
          shopId,
          printState: {
            in: [PrintState.Queued, PrintState.Assigned, PrintState.Downloading, PrintState.Printing],
          },
        },
      }),
    ]);

    const paidToday = await this.prisma.printJob.aggregate({
      where: { shopId, createdAt: { gte: startOfDay }, paymentState: PaymentState.Paid },
      _sum: { totalPriceInCents: true },
    });

    return {
      shopId,
      todayRevenueCents: paidToday._sum.totalPriceInCents ?? 0,
      todayJobsCount: todayAgg._count._all,
      completedJobsCount: completedCount,
      pendingJobsCount: pendingCount,
    };
  }

  // --- Internal mappers: Prisma row → shared-types interface ---

  private mapShop(s: {
    id: string; name: string; ownerEmail: string; upiId: string | null;
    bankAccountNumber: string | null; bankIfsc: string | null;
    payoutStatus: string; createdAt: Date;
  }): Shop {
    return {
      id: s.id,
      name: s.name,
      ownerEmail: s.ownerEmail,
      upiId: s.upiId ?? undefined,
      bankAccountNumber: s.bankAccountNumber ?? undefined,
      bankIfsc: s.bankIfsc ?? undefined,
      payoutStatus: s.payoutStatus,
      createdAt: s.createdAt.toISOString(),
    };
  }

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

  private mapPrintJob(j: Prisma.PrintJobGetPayload<Record<string, never>>): PrintJob {
    return {
      id: j.id,
      orderId: j.orderId,
      shopId: j.shopId,
      printerId: j.printerId,
      deviceId: j.deviceId ?? undefined,
      tokenNumber: j.tokenNumber ?? undefined,

      fileName: j.fileName,
      fileUrl: j.fileUrl,
      fileChecksum: j.fileChecksum,
      fileSizeBytes: j.fileSizeBytes,

      pageCount: j.pageCount,
      copies: j.copies,
      isColor: j.isColor,
      isDuplex: j.isDuplex,
      paperSize: j.paperSize,
      pageRange: j.pageRange ?? undefined,
      printConfig: (j.printConfig as unknown as PrintConfigSnapshot) ?? undefined,

      totalPriceInCents: j.totalPriceInCents,
      priceSnapshot: (j.priceSnapshot as unknown as PriceSnapshot) ?? undefined,

      paymentState: j.paymentState as PaymentState,
      paymentProvider: j.paymentProvider ?? undefined,
      paymentRef: j.paymentRef ?? undefined,

      printState: j.printState as PrintState,

      idempotencyKey: j.idempotencyKey ?? undefined,
      attemptCount: j.attemptCount,
      maxAttempts: j.maxAttempts,
      lastAttemptAt: j.lastAttemptAt?.toISOString(),

      errorMessage: j.errorMessage ?? undefined,
      failureCategory: (j.failureCategory as FailureCategory) ?? undefined,

      queuedAt: j.queuedAt?.toISOString(),
      assignedAt: j.assignedAt?.toISOString(),
      printedAt: j.printedAt?.toISOString(),
      completedAt: j.completedAt?.toISOString(),
      documentDeletedAt: j.documentDeletedAt?.toISOString(),

      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
    };
  }
}
