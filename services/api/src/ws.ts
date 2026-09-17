import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IStorageProvider } from './storage';
import { AgentWsMessage, JobQueuedEvent, PrintJob } from '@printok/shared-types';
import { hashDeviceToken } from './agentAuth';

export class AgentWebSocketServer {
  private wss: WebSocketServer;
  private printerSockets = new Map<string, WebSocket>();
  private storage: IStorageProvider;

  constructor(server: Server, storage: IStorageProvider) {
    this.storage = storage;
    this.wss = new WebSocketServer({ server, path: '/ws/agent' });

    this.wss.on('connection', async (ws: WebSocket, req) => {
      // Headers only. The query string was also accepted, and a URL is the
      // worst place to carry a bearer credential: it lands in access logs, in
      // proxy logs and in any error report that echoes the request line, where
      // a device token grants an authenticated agent session for that printer.
      //
      // The project's own client was fixed to stop sending it long ago —
      // AgentSettings.BuildWebSocketUri adds no query string and
      // WebSocketAuthHeaders sends x-agent-device-token or x-agent-api-key — so
      // the server was keeping a channel open that nothing used.
      //
      // Device-scoped token first; the shared printer key remains accepted for
      // agents installed before pairing existed (PRD 7.2).
      const deviceToken = req.headers['x-agent-device-token'] as string | undefined;
      const apiKey = req.headers['x-agent-api-key'] as string | undefined;

      if (!deviceToken && !apiKey) {
        const errPayload: AgentWsMessage = { type: 'AUTH_ERROR', payload: 'Missing credentials' };
        ws.send(JSON.stringify(errPayload));
        ws.close(4001, 'Unauthorized: Missing Credentials');
        return;
      }

      let printer;
      if (deviceToken) {
        const device = await this.storage.getActiveDeviceByTokenHash(hashDeviceToken(deviceToken));
        printer = device ? await this.storage.getPrinter(device.printerId) : undefined;
      } else if (apiKey) {
        printer = await this.storage.getPrinterByApiKey(apiKey);
      }

      if (!printer) {
        const errPayload: AgentWsMessage = { type: 'AUTH_ERROR', payload: 'Invalid credentials' };
        ws.send(JSON.stringify(errPayload));
        ws.close(4001, 'Unauthorized: Invalid Credentials');
        return;
      }

      // Register connection
      this.printerSockets.set(printer.id, ws);

      const successPayload: AgentWsMessage = {
        type: 'AUTH_SUCCESS',
        payload: { printerId: printer.id, printerName: printer.printerName },
      };
      ws.send(JSON.stringify(successPayload));

      ws.on('message', (data: string) => {
        try {
          const message: AgentWsMessage = JSON.parse(data.toString());
          if (message.type === 'PING') {
            const pong: AgentWsMessage = { type: 'PONG' };
            ws.send(JSON.stringify(pong));
          }
        } catch (err) {
          // Ignore malformed ping
        }
      });

      ws.on('close', () => {
        if (this.printerSockets.get(printer.id) === ws) {
          this.printerSockets.delete(printer.id);
        }
      });

      ws.on('error', () => {
        if (this.printerSockets.get(printer.id) === ws) {
          this.printerSockets.delete(printer.id);
        }
      });
    });
  }

  /**
   * Broadcast real-time job push notification to connected agent socket
   */
  /**
   * Broadcast a queued job to the shop's connected agent.
   *
   * Async because the document link is minted per push now rather than read off
   * the job row. Callers deliberately do not await it — a push is a nicety on
   * top of polling — so nothing is allowed to escape as a rejection.
   */
  public async notifyJobQueued(job: PrintJob): Promise<boolean> {
    try {
      return await this.pushJobQueued(job);
    } catch (err) {
      console.warn(`[WS] Could not push job ${job.id} to its agent:`, err);
      return false;
    }
  }

  private async pushJobQueued(job: PrintJob): Promise<boolean> {
    const ws = this.printerSockets.get(job.printerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Minted for this push and good for minutes, not stored on the job for an
      // hour where anyone holding the job id could use it.
      const fileUrl = (await this.storage.createJobDownloadUrl(job.id)) || '';

      const eventPayload: JobQueuedEvent = {
        jobId: job.id,
        printerId: job.printerId,
        tokenNumber: job.tokenNumber,
        fileName: job.fileName,
        fileUrl,
        fileChecksum: job.fileChecksum,
        pageCount: job.pageCount,
        copies: job.copies,
        isColor: job.isColor,
        isDuplex: job.isDuplex,
        paperSize: job.paperSize,
        orientation: job.orientation,
      };

      const msg: AgentWsMessage = {
        type: 'JOB_QUEUED',
        payload: eventPayload,
      };

      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

}
