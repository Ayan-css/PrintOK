import express, { Request, Response } from 'express';
import cors from 'cors';
import { IStorageProvider, MemoryStorage } from './storage';
import { generateQrCodeDataUrl } from './qr';
import { AgentWebSocketServer } from './ws';
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

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Health Check Endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'PrintOk API', timestamp: new Date().toISOString() });
  });

  /**
   * Shop & Printer Registration Endpoint
   */
  app.post('/api/shops/register', async (req: Request, res: Response) => {
    try {
      const { shopName, ownerEmail, printerName } = req.body as RegisterShopDto;

      if (!shopName || !ownerEmail || !printerName) {
        return res.status(400).json({ error: 'shopName, ownerEmail, and printerName are required.' });
      }

      const shop = await storage.createShop(shopName, ownerEmail);
      
      const baseUrl = process.env.PUBLIC_WEB_URL || 'http://localhost:3000';
      const qrTargetUrl = `${baseUrl}/p/${shop.id}`;
      const qrCodeDataUrl = generateQrCodeDataUrl(qrTargetUrl);

      const printer = await storage.createPrinter(shop.id, printerName, qrTargetUrl, qrCodeDataUrl);

      const response: RegisterShopResponse = { shop, printer };
      return res.status(201).json(response);
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
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
      return res.json({ printer, shop });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * Customer Create Print Job Endpoint
   */
  app.post('/api/print-jobs', async (req: Request, res: Response) => {
    try {
      const { printerId, fileName, fileBase64, pageCount, copies, isColor } = req.body as CreatePrintJobDto;
      const autoApprove = req.query.autoApprove !== 'false';

      if (!printerId || !fileName || !fileBase64) {
        return res.status(400).json({ error: 'printerId, fileName, and fileBase64 are required.' });
      }

      const printer = await storage.getPrinter(printerId);
      if (!printer) {
        return res.status(404).json({ error: 'Target printer not found.' });
      }

      const job = await storage.createPrintJob(
        printerId,
        fileName,
        fileBase64,
        pageCount || 1,
        copies || 1,
        !!isColor,
        autoApprove
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
   * Payment Webhook Endpoint (Simulating Razorpay/UPI gateway)
   */
  app.post('/api/payments/webhook', async (req: Request, res: Response) => {
    try {
      const { paymentId, jobId, amountInCents, signature } = req.body as PaymentWebhookDto;

      if (!paymentId || !jobId || !signature) {
        return res.status(400).json({ error: 'paymentId, jobId, and signature are required.' });
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

