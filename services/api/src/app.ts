import express, { Request, Response } from 'express';
import cors from 'cors';
import { MemoryStorage } from './storage';
import { generateQrCodeDataUrl } from './qr';
import {
  RegisterShopDto,
  RegisterShopResponse,
  CreatePrintJobDto,
  CreatePrintJobResponse,
  AgentPollResponse,
  AgentUpdateStatusDto,
  PrintState,
} from '@printok/shared-types';

export function createApp(storage: MemoryStorage = new MemoryStorage()) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Health Check Endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'PrintOk API', timestamp: new Date().toISOString() });
  });

  /**
   * Shop & Printer Registration Endpoint
   * Registers a shop owner and generates a unique QR code URL linked to their printer.
   */
  app.post('/api/shops/register', (req: Request, res: Response) => {
    const { shopName, ownerEmail, printerName } = req.body as RegisterShopDto;

    if (!shopName || !ownerEmail || !printerName) {
      return res.status(400).json({ error: 'shopName, ownerEmail, and printerName are required.' });
    }

    const shop = storage.createShop(shopName, ownerEmail);
    
    // QR Target URL points to customer mobile printing view for this specific printer
    const baseUrl = process.env.PUBLIC_WEB_URL || 'http://localhost:3000';
    const qrTargetUrl = `${baseUrl}/p/${shop.id}`;
    const qrCodeDataUrl = generateQrCodeDataUrl(qrTargetUrl);

    const printer = storage.createPrinter(shop.id, printerName, qrTargetUrl, qrCodeDataUrl);

    const response: RegisterShopResponse = { shop, printer };
    return res.status(201).json(response);
  });

  /**
   * Get Printer & Shop Info by Printer ID (for QR scan landing)
   */
  app.get('/api/printers/:printerId', (req: Request, res: Response) => {
    const { printerId } = req.params;
    const printer = storage.getPrinter(printerId);
    if (!printer) {
      return res.status(404).json({ error: 'Printer not found.' });
    }
    const shop = storage.getShop(printer.shopId);
    return res.json({ printer, shop });
  });

  /**
   * Customer Create Print Job Endpoint
   */
  app.post('/api/print-jobs', (req: Request, res: Response) => {
    const { printerId, fileName, fileBase64, pageCount, copies, isColor } = req.body as CreatePrintJobDto;

    if (!printerId || !fileName || !fileBase64) {
      return res.status(400).json({ error: 'printerId, fileName, and fileBase64 are required.' });
    }

    const printer = storage.getPrinter(printerId);
    if (!printer) {
      return res.status(404).json({ error: 'Target printer not found.' });
    }

    const job = storage.createPrintJob(
      printerId,
      fileName,
      fileBase64,
      pageCount || 1,
      copies || 1,
      !!isColor
    );

    const response: CreatePrintJobResponse = { job };
    return res.status(201).json(response);
  });

  /**
   * Get Print Job Status by Job ID
   */
  app.get('/api/print-jobs/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    const job = storage.getPrintJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Print job not found.' });
    }
    return res.json({ job });
  });

  /**
   * Windows Print Agent Polling Endpoint
   * Authenticates agent via x-agent-api-key header and retrieves pending jobs.
   */
  app.get('/api/agent/jobs/pending', (req: Request, res: Response) => {
    const apiKey = req.headers['x-agent-api-key'] as string;
    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized: Missing x-agent-api-key header.' });
    }

    const printer = storage.getPrinterByApiKey(apiKey);
    if (!printer) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
    }

    const pendingJobs = storage.getPendingJobsForPrinter(printer.id);

    // Transition polled jobs from Queued -> Downloading
    for (const job of pendingJobs) {
      storage.updateJobPrintState(job.id, PrintState.Downloading);
    }

    const response: AgentPollResponse = { jobs: pendingJobs };
    return res.json(response);
  });

  /**
   * Windows Print Agent Update Status Endpoint
   */
  app.post('/api/agent/jobs/:id/status', (req: Request, res: Response) => {
    const apiKey = req.headers['x-agent-api-key'] as string;
    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized: Missing x-agent-api-key header.' });
    }

    const printer = storage.getPrinterByApiKey(apiKey);
    if (!printer) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Agent API Key.' });
    }

    const { id } = req.params;
    const { printState, errorMessage } = req.body as AgentUpdateStatusDto;

    const updatedJob = storage.updateJobPrintState(id, printState, errorMessage);
    if (!updatedJob) {
      return res.status(404).json({ error: 'Print job not found.' });
    }

    return res.json({ job: updatedJob });
  });

  return app;
}
