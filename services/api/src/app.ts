import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { IStorageProvider, MemoryStorage } from './storage';
import { generateQrCodeDataUrl } from './qr';
import { AgentWebSocketServer } from './ws';
import { processDocument } from './documentProcessor';
import { RazorpayService } from './razorpayService';
import {
  RegisterShopDto,
  RegisterShopResponse,
  CreatePrintJobDto,
  CreatePrintJobResponse,
  AgentPollResponse,
  AgentUpdateStatusDto,
  PaymentWebhookDto,
  PrintState,
  PaymentState,
} from '@printok/shared-types';

export function createApp(
  storage: IStorageProvider = new MemoryStorage(),
  wsServer?: AgentWebSocketServer
) {
  const app = express();
  const razorpayService = new RazorpayService();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Security: Public API Rate Limiter (Max 60 requests per minute per IP)
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many requests from this IP, please try again after a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/print-jobs', apiLimiter);
  app.use('/api/shops/register', apiLimiter);

  // Health Check Endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'PrintOk API', timestamp: new Date().toISOString() });
  });

  /**
   * Shop & Printer Registration Endpoint
   */
  app.post('/api/shops/register', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName, upiId, bankAccountNumber, bankIfsc } = req.body as RegisterShopDto;

      if (!shopName || !ownerEmail || !printerName) {
        return res.status(400).json({ error: 'shopName, ownerEmail, and printerName are required.' });
      }

      const shop = await storage.createShop(shopName, ownerEmail, upiId, bankAccountNumber, bankIfsc);
      
      const baseUrl = process.env.PUBLIC_WEB_URL || 'http://localhost:3000';
      const qrTargetUrl = `${baseUrl}/p/${shop.id}`;
      const qrCodeDataUrl = await generateQrCodeDataUrl(qrTargetUrl);

      const printer = await storage.createPrinter(shop.id, printerName, qrTargetUrl, qrCodeDataUrl);

      const response: RegisterShopResponse = { shop, printer };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  });

  /**
   * Get Shop Pricing Config
   */
  app.get('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    try {
      const { shopId } = req.params;
      const pricing = await storage.getShopPricing(shopId);
      return res.json({ pricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Update Shop Pricing Config
   */
  app.post('/api/shops/:shopId/pricing', async (req: Request, res: Response) => {
    try {
      const { shopId } = req.params;
      const updatedPricing = await storage.updateShopPricing(shopId, req.body || {});
      return res.json({ pricing: updatedPricing });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Shop Performance Stats & Analytics
   */
  app.get('/api/shops/:shopId/stats', async (req: Request, res: Response) => {
    try {
      const { shopId } = req.params;
      const stats = await storage.getShopStats(shopId);
      return res.json({ stats });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Recent Jobs for Shop Owner Dashboard
   */
  app.get('/api/shops/:shopId/jobs', async (req: Request, res: Response) => {
    try {
      const { shopId } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const jobs = await storage.getRecentJobsForShop(shopId, limit);
      return res.json({ jobs });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Printer & Shop Info by Printer ID
   */
  app.get('/api/printers/:printerId', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }
      const shop = await storage.getShop(printer.shopId);
      const telemetry = await storage.getPrinterTelemetry(printerId);
      return res.json({ printer, shop, telemetry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  /**
   * Get Printer Telemetry & Online Status
   */
  app.get('/api/printers/:printerId/telemetry', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const telemetry = await storage.getPrinterTelemetry(printerId);
      return res.json(telemetry);
  /**
   * Download Pre-Configured appsettings.json for Windows Print Agent
   */
  app.get('/api/printers/:printerId/agent-config', async (req: Request, res: Response) => {
    try {
      const { printerId } = req.params;
      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Printer not found.' });
      }

      const config = {
        PrintOkApiUrl: process.env.API_BASE_URL || 'https://prinok-api.onrender.com',
        ShopId: printer.shopId,
        PrinterId: printer.id,
        AgentApiKey: printer.apiKey,
        HeartbeatIntervalSeconds: 30
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="appsettings.json"`);
      return res.send(JSON.stringify(config, null, 2));
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Customer Create Print Job Endpoint (Multi-Format Document Engine)
   */
  app.post('/api/print-jobs', async (req: Request, res: Response) => {
    try {
      const { printerId, fileName, fileBase64, copies, isColor, isDuplex, paperSize } = req.body as CreatePrintJobDto;
      const autoApprove = req.query.autoApprove !== 'false';

      if (!printerId || !fileName || !fileBase64) {
        return res.status(400).json({ error: 'printerId, fileName, and fileBase64 are required.' });
      }

      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Target printer not found.' });
      }

      // Multi-format document inspection & server-side page count verification
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const docResult = await processDocument(fileName, fileBuffer);

      if (!docResult.isSupported) {
        return res.status(400).json({ error: docResult.errorMessage });
      }

      // Tamper-proof page count override
      const verifiedPageCount = docResult.pageCount;

      const job = await storage.createPrintJob(
        printerId,
        fileName,
        fileBase64,
        verifiedPageCount,
        copies || 1,
        !!isColor,
        autoApprove,
        !!isDuplex,
        paperSize || 'A4'
      );

      // If job is immediately queued, push notification to active WebSocket agent
      if (job.printState === PrintState.Queued && wsServer) {
        wsServer.notifyJobQueued(job);
      }

      const response: CreatePrintJobResponse = { job };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Heartbeat Endpoint
   */
  app.post('/api/agent/heartbeat', async (req: Request, res: Response) => {
    try {
      const apiKey = req.headers['x-agent-api-key'] as string;
      if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Missing x-agent-api-key header.' });
      }

      const printer = await storage.getPrinterByApiKey(apiKey);
      if (!printer) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
      }

      const { paperStatus } = req.body || {};
      const telemetry = await storage.recordHeartbeat(printer.id, paperStatus || 'OK');
      return res.json({ success: true, telemetry });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * One-Click Manual Print Override (For offline cash payment / merchant override)
   */
  app.post('/api/print-jobs/:id/manual-override', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const job = await storage.confirmPaymentAndQueueJob(id);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      if (wsServer) {
        wsServer.notifyJobQueued(job);
      }

      return res.json({ success: true, message: 'Job manually approved & queued for print.', job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });


  /**
   * Create Razorpay Payment Order Endpoint
   */
  app.post('/api/payments/create-order', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ error: 'jobId is required.' });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      const orderResult = await razorpayService.createOrder(jobId, job.totalPriceInCents);
      return res.json(orderResult);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Payment Webhook Endpoint (HMAC SHA256 Signature Verification)
   */
  app.post('/api/payments/webhook', async (req: Request, res: Response) => {
    try {
      const { paymentId, jobId, amountInCents, signature } = req.body as PaymentWebhookDto;

      if (!paymentId || !jobId || !signature) {
        return res.status(400).json({ error: 'paymentId, jobId, and signature are required.' });
      }

      // HMAC Signature Verification
      const isValidSignature = razorpayService.verifyWebhookSignature(req.body, signature);
      if (!isValidSignature) {
        return res.status(400).json({ error: 'Invalid HMAC payment webhook signature.' });
      }

      const job = await storage.getPrintJob(jobId);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      // Idempotency: If job is already paid, return existing status
      if (job.paymentState === PaymentState.Paid) {
        return res.json({ success: true, message: 'Payment already processed.', job });
      }

      const updatedJob = await storage.confirmPaymentAndQueueJob(jobId);
      if (!updatedJob) {
        return res.status(500).json({ error: 'Failed to update job status.' });
      }

      // Instant push notification over WebSocket
      if (wsServer) {
        wsServer.notifyJobQueued(updatedJob);
      }

      return res.json({ success: true, message: 'Payment confirmed & job queued.', job: updatedJob });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Get Print Job Status by Job ID
   */
  app.get('/api/print-jobs/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const job = await storage.getPrintJob(id);
      if (!job) {
        return res.status(404).json({ error: 'Print job not found.' });
      }
      return res.json({ job });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Polling Endpoint
   */
  app.get('/api/agent/jobs/pending', async (req: Request, res: Response) => {
    try {
      const apiKey = req.headers['x-agent-api-key'] as string;
      if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Missing x-agent-api-key header.' });
      }

      const printer = await storage.getPrinterByApiKey(apiKey);
      if (!printer) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
      }

      const pendingJobs = await storage.getPendingJobsForPrinter(printer.id);

      for (const job of pendingJobs) {
        await storage.updateJobPrintState(job.id, PrintState.Downloading);
      }

      const response: AgentPollResponse = { jobs: pendingJobs };
      return res.json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Windows Print Agent Update Status Endpoint
   */
  app.post('/api/agent/jobs/:id/status', async (req: Request, res: Response) => {
    try {
      const apiKey = req.headers['x-agent-api-key'] as string;
      if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: Missing x-agent-api-key header.' });
      }

      const printer = await storage.getPrinterByApiKey(apiKey);
      if (!printer) {
        return res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
      }

      const { id } = req.params;
      const { printState, errorMessage } = req.body as AgentUpdateStatusDto;

      const updatedJob = await storage.updateJobPrintState(id, printState, errorMessage);
      if (!updatedJob) {
        return res.status(404).json({ error: 'Print job not found.' });
      }

      return res.json({ job: updatedJob });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  return app;
}

