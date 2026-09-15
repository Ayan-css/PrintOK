import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  Shop, Printer, PrintJob, PaymentState, PrintState, PrinterTelemetry,
  MerchantPricingConfig, MerchantStats, JobEvent, PriceSnapshot, PrintConfigSnapshot,
  FailureCategory,
  ShopContactDetails, ShopPortalConfig, DEFAULT_PORTAL_CONFIG, ShopRateCard,
} from '@printok/shared-types';
import {
  IStorageProvider, CreateJobOptions, TransitionMeta, StateChangeResult, StoredIdempotencyRecord,
  AgentDeviceRecord, AgentSecurityEventRecord, PairingCodeRecord, ReclaimResult,
  AdminUserRecord, ShopPlan, AdminShopSummary, AdminOverview,
  ShopRemovalSafety, ShopRemovalResult, AdminAuditEntry,
  ContactEnquiryRecord, CreateContactEnquiryInput, MerchantUserRecord,
} from './storage';
import { S3StorageService } from './s3Storage';
import { calculateJobPriceBreakdown, calculateGridPriceBreakdown, buildDefaultRateCard, DEFAULT_PRICING_CONFIG } from './pricing';
import { mergeRates } from './storage';
import { canTransitionPrintState, canTransitionPaymentState, isDocumentPurgeable } from './jobStateMachine';
import {
  recoveryActionFor, ASSIGNED_STALE_MS, DOWNLOADING_STALE_MS, PRINTING_STALE_MS,
} from './jobRecovery';

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
    bankIfsc?: string,
    contact: ShopContactDetails = {}
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
        ...contact,
        addressCountry: contact.addressCountry || 'IN',
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

  public async listPrintersForShop(shopId: string): Promise<Printer[]> {
    const printers = await this.prisma.printer.findMany({
      where: { shopId },
      orderBy: { createdAt: 'asc' },
    });
    return printers.map((p) => this.mapPrinter(p));
  }

  public async regeneratePrinterQr(
    printerId: string,
    baseUrl: string,
    qrGeneratorFn: (url: string) => Promise<string>
  ): Promise<Printer | undefined> {
    const existing = await this.prisma.printer.findUnique({ where: { id: printerId } });
    if (!existing) return undefined;

    const qrTargetUrl = `${baseUrl.replace(/\/$/, '')}/?printer=${printerId}`;
    const qrCodeDataUrl = await qrGeneratorFn(qrTargetUrl);

    const printer = await this.prisma.printer.update({
      where: { id: printerId },
      data: { qrTargetUrl, qrCodeDataUrl },
    });

    return this.mapPrinter(printer);
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
    // Priced from the grid: A3 is its own rate rather than a multiplier, and
    // both discount models live here. Falls back to the flat card if unseeded.
    const rateCard = await this.getShopRateCard(printer.shopId);
    const priceSnapshot = calculateGridPriceBreakdown(
      pageCount, copies, isColor, isDuplex, paperSize, rateCard, pricingConfig
    );

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
        customerName: options.customerName ?? null,
        customerPhone: options.customerPhone ?? null,
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

  public async declineJob(jobId: string, reason: string, meta: TransitionMeta = {}): Promise<StateChangeResult> {
    const existing = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    const from = existing.printState as PrintState;
    const printCheck = canTransitionPrintState(from, PrintState.Cancelled);
    if (!printCheck.allowed) {
      return {
        ok: false, code: 'ILLEGAL_TRANSITION', reason: printCheck.reason!,
        job: this.mapPrintJob(existing),
      };
    }

    // Paid jobs owe the customer money back; unpaid ones simply stop.
    const wasPaid = existing.paymentState === PaymentState.Paid;
    const nextPayment = wasPaid ? PaymentState.RefundPending : PaymentState.Cancelled;
    const canMovePayment = canTransitionPaymentState(
      existing.paymentState as PaymentState, nextPayment
    ).allowed;

    // Cancelled is a purgeable state: a declined job will never be printed, so
    // the customer's document should not outlive the decision.
    const purge = isDocumentPurgeable(PrintState.Cancelled) && !existing.documentDeletedAt;

    const job = await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        printState: PrintState.Cancelled,
        declineReason: reason,
        ...(canMovePayment ? { paymentState: nextPayment } : {}),
        ...(purge ? { documentDeletedAt: new Date() } : {}),
        events: {
          create: {
            type: 'JOB_DECLINED',
            fromState: from,
            toState: PrintState.Cancelled,
            actor: meta.actor || 'shop',
            detail: { ...(meta.detail || {}), reason, refundDue: wasPaid } as Prisma.InputJsonValue,
          },
        },
      },
    });

    if (purge && existing.s3Key) {
      try {
        await this.s3Service.deleteDocument(existing.s3Key);
        await this.recordEvent(jobId, 'DOCUMENT_PURGED', PrintState.Cancelled, PrintState.Cancelled, 'shop');
      } catch (err: any) {
        await this.recordEvent(jobId, 'DOCUMENT_PURGE_FAILED', PrintState.Cancelled, PrintState.Cancelled, 'shop', {
          error: String(err?.message || err),
          s3Key: existing.s3Key,
        });
      }
    }

    return { ok: true, job: this.mapPrintJob(job) };
  }

  public async recordJobRefund(
    jobId: string,
    refund: { refundId: string; amountInCents: number },
    meta: TransitionMeta = {}
  ): Promise<StateChangeResult> {
    const existing = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!existing) return { ok: false, code: 'NOT_FOUND', reason: `Job '${jobId}' not found.` };

    const check = canTransitionPaymentState(existing.paymentState as PaymentState, PaymentState.Refunded);
    if (!check.allowed) {
      return {
        ok: false, code: 'ILLEGAL_TRANSITION', reason: check.reason!,
        job: this.mapPrintJob(existing),
      };
    }

    const job = await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        paymentState: PaymentState.Refunded,
        refundId: refund.refundId,
        refundAmountCents: refund.amountInCents,
        refundedAt: new Date(),
        events: {
          create: {
            type: 'PAYMENT_REFUNDED',
            fromState: existing.printState,
            toState: existing.printState,
            actor: meta.actor || 'shop',
            detail: { refundId: refund.refundId, amountInCents: refund.amountInCents } as Prisma.InputJsonValue,
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

  /**
   * Recovers jobs abandoned mid-flight (PRD 12, 13).
   *
   * Each transient state has its own staleness threshold, and the decision to
   * requeue or escalate is made by jobRecovery so both storage providers apply
   * exactly the same policy.
   */
  public async reclaimStaleJobs(now: Date = new Date()): Promise<ReclaimResult> {
    const result: ReclaimResult = { requeued: [], escalated: [] };

    const windows: Array<{ state: PrintState; cutoff: Date }> = [
      { state: PrintState.Assigned, cutoff: new Date(now.getTime() - ASSIGNED_STALE_MS) },
      { state: PrintState.Downloading, cutoff: new Date(now.getTime() - DOWNLOADING_STALE_MS) },
      { state: PrintState.Printing, cutoff: new Date(now.getTime() - PRINTING_STALE_MS) },
    ];

    for (const { state, cutoff } of windows) {
      const stale = await this.prisma.printJob.findMany({
        where: {
          printState: state,
          // Measure from the last sign of life, falling back to the last write.
          OR: [
            { lastAttemptAt: { lt: cutoff } },
            { AND: [{ lastAttemptAt: null }, { updatedAt: { lt: cutoff } }] },
          ],
        },
        take: 200,
      });

      for (const job of stale) {
        const decision = recoveryActionFor(state, job.attemptCount, job.maxAttempts);

        if (decision.action === 'requeue') {
          // Conditional update: if an agent reported progress since we read the
          // row, leave it alone rather than yanking a live job back.
          const moved = await this.prisma.printJob.updateMany({
            where: { id: job.id, printState: state },
            data: { printState: PrintState.Queued, deviceId: null },
          });
          if (moved.count === 0) continue;

          await this.recordEvent(job.id, 'RECLAIMED_REQUEUED', state, PrintState.Queued, 'system', {
            reason: decision.reason,
          });
          result.requeued.push(job.id);
        } else {
          const moved = await this.prisma.printJob.updateMany({
            where: { id: job.id, printState: state },
            data: {
              printState: PrintState.RequiresShopAction,
              failureCategory: FailureCategory.SafetyCritical,
              errorMessage: decision.reason,
            },
          });
          if (moved.count === 0) continue;

          await this.recordEvent(
            job.id, 'RECLAIM_ESCALATED', state, PrintState.RequiresShopAction, 'system',
            { reason: decision.reason }
          );
          result.escalated.push(job.id);
        }
      }
    }

    return result;
  }

  public async getJobsRequiringAction(shopId: string, limit = 50): Promise<PrintJob[]> {
    const jobs = await this.prisma.printJob.findMany({
      where: { shopId, printState: PrintState.RequiresShopAction },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    return jobs.map((j) => this.mapPrintJob(j));
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

  // ------------------------------------------------- platform administration ---

  public async createAdminUser(input: {
    email: string; passwordHash: string; name?: string; role?: string;
  }): Promise<AdminUserRecord> {
    const user = await this.prisma.adminUser.create({
      data: {
        id: `adm_${crypto.randomBytes(8).toString('hex')}`,
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        name: input.name,
        role: input.role || 'admin',
      },
    });
    return this.mapAdmin(user);
  }

  public async getAdminUserByEmail(
    email: string
  ): Promise<(AdminUserRecord & { passwordHash: string }) | undefined> {
    const user = await this.prisma.adminUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user) return undefined;
    return { ...this.mapAdmin(user), passwordHash: user.passwordHash };
  }

  public async getAdminUser(id: string): Promise<AdminUserRecord | undefined> {
    const user = await this.prisma.adminUser.findUnique({ where: { id } });
    return user ? this.mapAdmin(user) : undefined;
  }

  public async countAdminUsers(): Promise<number> {
    return this.prisma.adminUser.count();
  }

  public async recordAdminLogin(id: string): Promise<void> {
    await this.prisma.adminUser.updateMany({ where: { id }, data: { lastLoginAt: new Date() } });
  }

  public async getShopPlan(shopId: string): Promise<ShopPlan | undefined> {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return undefined;
    return {
      planTier: shop.planTier as ShopPlan['planTier'],
      commissionBps: shop.commissionBps,
      planStatus: shop.planStatus as ShopPlan['planStatus'],
    };
  }

  public async updateShopPlan(shopId: string, plan: Partial<ShopPlan>): Promise<ShopPlan | undefined> {
    const existing = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!existing) return undefined;

    const shop = await this.prisma.shop.update({
      where: { id: shopId },
      data: {
        ...(plan.planTier ? { planTier: plan.planTier } : {}),
        ...(plan.commissionBps !== undefined ? { commissionBps: plan.commissionBps } : {}),
        ...(plan.planStatus ? { planStatus: plan.planStatus } : {}),
      },
    });

    return {
      planTier: shop.planTier as ShopPlan['planTier'],
      commissionBps: shop.commissionBps,
      planStatus: shop.planStatus as ShopPlan['planStatus'],
    };
  }

  public async listAdminShopSummaries(limit = 200, includeArchived = false): Promise<AdminShopSummary[]> {
    const shops = await this.prisma.shop.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { printers: { include: { telemetry: true, devices: true } } },
    });

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const onlineSince = new Date(Date.now() - HEARTBEAT_ONLINE_WINDOW_MS);

    // Aggregate per shop in the database rather than loading every job.
    const [paidTotals, jobCounts, recentCounts, actionCounts, lastJobs, paidJobCounts] = await Promise.all([
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        where: { paymentState: PaymentState.Paid },
        _sum: { totalPriceInCents: true },
      }),
      this.prisma.printJob.groupBy({ by: ['shopId'], _count: { _all: true } }),
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        where: { createdAt: { gte: cutoff } },
        _count: { _all: true },
      }),
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        where: { printState: PrintState.RequiresShopAction },
        _count: { _all: true },
      }),
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        _max: { createdAt: true },
      }),
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        where: { paymentState: PaymentState.Paid },
        _count: { _all: true },
      }),
    ]);

    const revenueByShop = new Map(paidTotals.map((r) => [r.shopId, r._sum.totalPriceInCents ?? 0]));
    const totalByShop = new Map(jobCounts.map((r) => [r.shopId, r._count._all]));
    const recentByShop = new Map(recentCounts.map((r) => [r.shopId, r._count._all]));
    const actionByShop = new Map(actionCounts.map((r) => [r.shopId, r._count._all]));
    const lastJobByShop = new Map(lastJobs.map((r) => [r.shopId, r._max.createdAt]));
    const paidJobCountByShop = new Map(paidJobCounts.map((r) => [r.shopId, r._count._all]));

    return shops.map((shop) => {
      const grossRevenueCents = revenueByShop.get(shop.id) ?? 0;
      return {
        shop: this.mapShop(shop),
        plan: {
          planTier: shop.planTier as ShopPlan['planTier'],
          commissionBps: shop.commissionBps,
          planStatus: shop.planStatus as ShopPlan['planStatus'],
        },
        printerCount: shop.printers.length,
        onlinePrinterCount: shop.printers.filter(
          (p) => p.telemetry && p.telemetry.lastHeartbeat >= onlineSince
        ).length,
        pairedDeviceCount: shop.printers.reduce(
          (n, p) => n + p.devices.filter((d) => d.status === 'active').length,
          0
        ),
        totalJobs: totalByShop.get(shop.id) ?? 0,
        jobsLast30Days: recentByShop.get(shop.id) ?? 0,
        grossRevenueCents,
        // Commission is derived from the shop's own rate, not a global constant.
        commissionCents: Math.round((grossRevenueCents * shop.commissionBps) / 10_000),
        jobsRequiringAction: actionByShop.get(shop.id) ?? 0,
        lastJobAt: lastJobByShop.get(shop.id)?.toISOString(),
        archivedAt: shop.archivedAt?.toISOString(),
        archiveReason: shop.archiveReason ?? undefined,
        // No paid job means no real money ever moved, so the row is disposable.
        canHardDelete: (paidJobCountByShop.get(shop.id) ?? 0) === 0,
      };
    });
  }

  // ------------------------------------------------- shop lifecycle (PRD 21) ---

  public async getShopRemovalSafety(shopId: string): Promise<ShopRemovalSafety> {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) {
      return {
        shopId, exists: false, paidJobCount: 0, totalJobCount: 0,
        printerCount: 0, canHardDelete: false, reason: 'Shop not found.',
      };
    }

    const [paidJobCount, totalJobCount, printerCount] = await Promise.all([
      this.prisma.printJob.count({ where: { shopId, paymentState: PaymentState.Paid } }),
      this.prisma.printJob.count({ where: { shopId } }),
      this.prisma.printer.count({ where: { shopId } }),
    ]);

    const canHardDelete = paidJobCount === 0;

    return {
      shopId,
      exists: true,
      paidJobCount,
      totalJobCount,
      printerCount,
      canHardDelete,
      reason: canHardDelete
        ? undefined
        : `This shop has ${paidJobCount} paid job(s). Deleting it would destroy payment records, so it can only be archived.`,
    };
  }

  public async hardDeleteShop(shopId: string, force = false): Promise<ShopRemovalResult> {
    const safety = await this.getShopRemovalSafety(shopId);
    if (!safety.exists) {
      return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };
    }
    // The guard exists to protect payment records. Overriding it is a
    // deliberate act, separately confirmed and separately audited.
    if (!safety.canHardDelete && !force) {
      return { shopId, ok: false, action: 'refused', reason: safety.reason };
    }

    // Pairing codes reference a printer by id without a foreign key, so they
    // would survive the cascade as orphans. Clear them explicitly.
    const printers = await this.prisma.printer.findMany({
      where: { shopId },
      select: { id: true },
    });
    const printerIds = printers.map((p) => p.id);

    if (printerIds.length) {
      await this.prisma.agentPairingCode.deleteMany({ where: { printerId: { in: printerIds } } });
    }

    // Printers, jobs, job events, telemetry, devices and pricing all cascade
    // from Shop. AgentSecurityEvent is deliberately left: a security trail
    // should outlive the thing it describes.
    await this.prisma.shop.delete({ where: { id: shopId } });

    return { shopId, ok: true, action: 'deleted' };
  }

  public async archiveShop(shopId: string, actor: string, reason?: string): Promise<ShopRemovalResult> {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };
    if (shop.archivedAt) return { shopId, ok: true, action: 'archived', reason: 'Already archived.' };

    await this.prisma.shop.update({
      where: { id: shopId },
      data: { archivedAt: new Date(), archivedBy: actor, archiveReason: reason, planStatus: 'cancelled' },
    });

    return { shopId, ok: true, action: 'archived' };
  }

  public async restoreShop(shopId: string): Promise<ShopRemovalResult> {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return { shopId, ok: false, action: 'refused', reason: 'Shop not found.' };

    await this.prisma.shop.update({
      where: { id: shopId },
      data: { archivedAt: null, archivedBy: null, archiveReason: null, planStatus: 'active' },
    });

    return { shopId, ok: true, action: 'restored' };
  }

  public async recordAdminAudit(entry: Omit<AdminAuditEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.prisma.adminAuditLog.create({
      data: {
        id: `aud_${crypto.randomBytes(8).toString('hex')}`,
        actorId: entry.actorId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        detail: (entry.detail || {}) as Prisma.InputJsonValue,
      },
    });
  }

  public async createMerchantUser(input: {
    shopId: string; email: string; passwordHash: string;
    name?: string; phone?: string; role?: string;
  }): Promise<MerchantUserRecord> {
    const user = await this.prisma.merchantUser.create({
      data: {
        id: `mch_${crypto.randomBytes(8).toString('hex')}`,
        shopId: input.shopId,
        email: input.email.trim().toLowerCase(),
        passwordHash: input.passwordHash,
        name: input.name,
        phone: input.phone,
        role: input.role || 'owner',
      },
    });
    return this.mapMerchant(user);
  }

  public async getMerchantByEmail(
    email: string
  ): Promise<(MerchantUserRecord & { passwordHash: string }) | undefined> {
    const user = await this.prisma.merchantUser.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user) return undefined;
    return { ...this.mapMerchant(user), passwordHash: user.passwordHash };
  }

  public async getMerchantUser(id: string): Promise<MerchantUserRecord | undefined> {
    const user = await this.prisma.merchantUser.findUnique({ where: { id } });
    return user ? this.mapMerchant(user) : undefined;
  }

  public async countMerchantsForShop(shopId: string): Promise<number> {
    return this.prisma.merchantUser.count({ where: { shopId } });
  }

  public async recordMerchantLogin(id: string): Promise<void> {
    await this.prisma.merchantUser.updateMany({
      where: { id }, data: { lastLoginAt: new Date() },
    });
  }

  private mapMerchant(m: {
    id: string; shopId: string; email: string; name: string | null; phone: string | null;
    role: string; status: string; lastLoginAt: Date | null; createdAt: Date;
  }): MerchantUserRecord {
    return {
      id: m.id,
      shopId: m.shopId,
      email: m.email,
      name: m.name ?? undefined,
      phone: m.phone ?? undefined,
      role: m.role,
      status: m.status,
      lastLoginAt: m.lastLoginAt?.toISOString(),
      createdAt: m.createdAt.toISOString(),
    };
  }

  public async updateShopRazorpayAccount(shopId: string, update: {
    accountId?: string; status: string; error?: string | null;
  }): Promise<void> {
    await this.prisma.shop.updateMany({
      where: { id: shopId },
      data: {
        ...(update.accountId ? { razorpayAccountId: update.accountId } : {}),
        razorpayAccountStatus: update.status,
        razorpayAccountError: update.error ?? null,
        ...(update.status === 'activated' ? { razorpayLinkedAt: new Date() } : {}),
      },
    });
  }

  public async recordJobSettlement(
    jobId: string, transferAmountCents: number, serviceFeeCents: number
  ): Promise<void> {
    await this.prisma.printJob.updateMany({
      where: { id: jobId },
      data: { transferAmountCents, serviceFeeCents },
    });
  }

  public async createContactEnquiry(input: CreateContactEnquiryInput): Promise<ContactEnquiryRecord> {
    const enquiry = await this.prisma.contactEnquiry.create({
      data: {
        id: `enq_${crypto.randomBytes(8).toString('hex')}`,
        name: input.name,
        email: input.email,
        phone: input.phone,
        shopName: input.shopName,
        message: input.message,
        source: input.source || 'landing',
        ipHash: input.ipHash,
        userAgent: input.userAgent,
      },
    });
    return this.mapEnquiry(enquiry);
  }

  public async listContactEnquiries(status?: string, limit = 100): Promise<ContactEnquiryRecord[]> {
    const enquiries = await this.prisma.contactEnquiry.findMany({
      where: status && status !== 'all' ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return enquiries.map((e) => this.mapEnquiry(e));
  }

  public async updateContactEnquiryStatus(
    id: string, status: string, handledBy: string, notes?: string
  ): Promise<ContactEnquiryRecord | undefined> {
    const existing = await this.prisma.contactEnquiry.findUnique({ where: { id } });
    if (!existing) return undefined;

    const enquiry = await this.prisma.contactEnquiry.update({
      where: { id },
      data: {
        status,
        handledBy,
        handledAt: new Date(),
        ...(notes !== undefined ? { notes } : {}),
      },
    });
    return this.mapEnquiry(enquiry);
  }

  public async countNewContactEnquiries(): Promise<number> {
    return this.prisma.contactEnquiry.count({ where: { status: 'new' } });
  }

  public async countRecentEnquiriesFrom(email: string, sinceMs: number): Promise<number> {
    return this.prisma.contactEnquiry.count({
      where: {
        email: email.trim().toLowerCase(),
        createdAt: { gte: new Date(Date.now() - sinceMs) },
      },
    });
  }

  private mapEnquiry(e: {
    id: string; name: string; email: string; phone: string | null; shopName: string | null;
    message: string; status: string; source: string; handledBy: string | null;
    handledAt: Date | null; notes: string | null; createdAt: Date;
  }): ContactEnquiryRecord {
    return {
      id: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone ?? undefined,
      shopName: e.shopName ?? undefined,
      message: e.message,
      status: e.status as ContactEnquiryRecord['status'],
      source: e.source,
      handledBy: e.handledBy ?? undefined,
      handledAt: e.handledAt?.toISOString(),
      notes: e.notes ?? undefined,
      createdAt: e.createdAt.toISOString(),
    };
  }

  public async listAdminAudit(limit = 100): Promise<AdminAuditEntry[]> {
    const rows = await this.prisma.adminAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorEmail: r.actorEmail,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      detail: (r.detail as Record<string, unknown>) ?? undefined,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  public async getAdminOverview(): Promise<AdminOverview> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const onlineSince = new Date(Date.now() - HEARTBEAT_ONLINE_WINDOW_MS);

    const [
      totalShops, totalPrinters, onlinePrinters, totalJobs, jobsToday,
      requiresAction, tierGroups, shopsWithJobs,
    ] = await Promise.all([
      this.prisma.shop.count(),
      this.prisma.printer.count(),
      this.prisma.printerTelemetry.count({ where: { lastHeartbeat: { gte: onlineSince } } }),
      this.prisma.printJob.count(),
      this.prisma.printJob.count({ where: { createdAt: { gte: startOfDay } } }),
      this.prisma.printJob.count({ where: { printState: PrintState.RequiresShopAction } }),
      this.prisma.shop.groupBy({ by: ['planTier'], _count: { _all: true } }),
      this.prisma.printJob.groupBy({
        by: ['shopId'],
        where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        _count: { _all: true },
      }),
    ]);

    // Commission varies per shop, so it cannot be a single aggregate query.
    const paidByShop = await this.prisma.printJob.groupBy({
      by: ['shopId'],
      where: { paymentState: PaymentState.Paid },
      _sum: { totalPriceInCents: true },
    });
    const shopRates = await this.prisma.shop.findMany({ select: { id: true, commissionBps: true } });
    const rateByShop = new Map(shopRates.map((s) => [s.id, s.commissionBps]));

    let grossRevenueCents = 0;
    let commissionCents = 0;
    for (const row of paidByShop) {
      const gross = row._sum.totalPriceInCents ?? 0;
      grossRevenueCents += gross;
      commissionCents += Math.round((gross * (rateByShop.get(row.shopId) ?? 500)) / 10_000);
    }

    return {
      totalShops,
      // "Active" means it actually printed something recently, not merely that
      // a row exists.
      activeShops: shopsWithJobs.length,
      totalPrinters,
      onlinePrinters,
      totalJobs,
      jobsToday,
      grossRevenueCents,
      commissionCents,
      jobsRequiringAction: requiresAction,
      shopsByTier: Object.fromEntries(tierGroups.map((g) => [g.planTier, g._count._all])),
    };
  }

  private mapAdmin(u: {
    id: string; email: string; name: string | null; role: string; status: string;
    lastLoginAt: Date | null; createdAt: Date;
  }): AdminUserRecord {
    return {
      id: u.id,
      email: u.email,
      name: u.name ?? undefined,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt?.toISOString(),
      createdAt: u.createdAt.toISOString(),
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

  public async getShopRateCard(shopId: string): Promise<ShopRateCard> {
    const [rows, pricing] = await Promise.all([
      this.prisma.shopRate.findMany({ where: { shopId }, orderBy: [{ paperSize: 'asc' }, { isColor: 'asc' }, { isDuplex: 'asc' }] }),
      this.prisma.shopPricing.findUnique({ where: { shopId } }),
    ]);

    // A shop whose grid was never seeded still has to be able to sell, so it
    // gets one derived from its flat rates rather than an empty card.
    if (rows.length === 0) {
      return buildDefaultRateCard(await this.getShopPricing(shopId));
    }

    return {
      rates: rows.map((r) => ({
        paperSize: r.paperSize,
        isColor: r.isColor,
        isDuplex: r.isDuplex,
        perPageCents: r.perPageCents,
        bulkPerPageCents: r.bulkPerPageCents,
        additionalCopyPerPageCents: r.additionalCopyPerPageCents,
        enabled: r.enabled,
      })),
      bulkEnabled: pricing?.bulkEnabled ?? false,
      bulkThresholdCents: pricing?.bulkThresholdCents ?? 10000,
      additionalCopyEnabled: pricing?.additionalCopyEnabled ?? false,
    };
  }

  public async updateShopRateCard(shopId: string, card: Partial<ShopRateCard>): Promise<ShopRateCard> {
    // Seed first if the grid is empty, so a partial edit does not create a card
    // containing only the cells that happened to be on screen.
    const current = await this.getShopRateCard(shopId);
    const rates = card.rates ? mergeRates(current.rates, card.rates) : current.rates;

    await this.prisma.$transaction(async (tx) => {
      for (const r of rates) {
        const data = {
          perPageCents: r.perPageCents,
          bulkPerPageCents: r.bulkPerPageCents ?? null,
          additionalCopyPerPageCents: r.additionalCopyPerPageCents ?? null,
          enabled: r.enabled,
        };

        await tx.shopRate.upsert({
          where: {
            shopId_paperSize_isColor_isDuplex: {
              shopId, paperSize: r.paperSize, isColor: r.isColor, isDuplex: r.isDuplex,
            },
          },
          create: {
            id: `${shopId}_${r.paperSize}_${r.isColor ? 'c' : 'b'}${r.isDuplex ? 'd' : 's'}`,
            shopId, paperSize: r.paperSize, isColor: r.isColor, isDuplex: r.isDuplex, ...data,
          },
          update: data,
        });
      }

      const switches: Record<string, unknown> = {};
      if (card.bulkEnabled !== undefined) switches.bulkEnabled = card.bulkEnabled;
      if (card.bulkThresholdCents !== undefined) switches.bulkThresholdCents = card.bulkThresholdCents;
      if (card.additionalCopyEnabled !== undefined) switches.additionalCopyEnabled = card.additionalCopyEnabled;

      if (Object.keys(switches).length > 0) {
        await tx.shopPricing.upsert({
          where: { shopId },
          create: { shopId, ...switches },
          update: switches,
        });
      }
    });

    return this.getShopRateCard(shopId);
  }

  public async getShopPortalConfig(shopId: string): Promise<ShopPortalConfig> {
    const row = await this.prisma.shopPortalConfig.findUnique({ where: { shopId } });
    if (!row) return { ...DEFAULT_PORTAL_CONFIG };

    return {
      collectCustomerName: row.collectCustomerName,
      customerNameRequired: row.customerNameRequired,
      collectCustomerPhone: row.collectCustomerPhone,
      customerPhoneRequired: row.customerPhoneRequired,
      enabledServices: row.enabledServices ?? [],
    };
  }

  public async updateShopPortalConfig(
    shopId: string,
    config: Partial<ShopPortalConfig>
  ): Promise<ShopPortalConfig> {
    const merged = { ...(await this.getShopPortalConfig(shopId)), ...config };

    await this.prisma.shopPortalConfig.upsert({
      where: { shopId },
      create: { shopId, ...merged },
      update: merged,
    });

    return merged;
  }

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
    razorpayAccountId?: string | null;
    razorpayAccountStatus?: string | null;
    razorpayLinkedAt?: Date | null;
    razorpayAccountError?: string | null;
  }): Shop {
    return {
      id: s.id,
      name: s.name,
      ownerEmail: s.ownerEmail,
      upiId: s.upiId ?? undefined,
      bankAccountNumber: s.bankAccountNumber ?? undefined,
      bankIfsc: s.bankIfsc ?? undefined,
      payoutStatus: s.payoutStatus,
      // Without these the Route split silently never fires, because the caller
      // checks razorpayAccountId before attaching a transfer.
      razorpayAccountId: s.razorpayAccountId ?? undefined,
      razorpayAccountStatus: s.razorpayAccountStatus ?? 'not_linked',
      razorpayLinkedAt: s.razorpayLinkedAt?.toISOString(),
      razorpayAccountError: s.razorpayAccountError ?? undefined,
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

      customerName: j.customerName ?? undefined,
      customerPhone: j.customerPhone ?? undefined,

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

      declineReason: j.declineReason ?? undefined,
      refundId: j.refundId ?? undefined,
      refundAmountCents: j.refundAmountCents ?? undefined,
      refundedAt: j.refundedAt?.toISOString(),

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
