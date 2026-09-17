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
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);

      // Device-scoped token first; the shared printer key remains accepted for
      // agents installed before pairing existed (PRD 7.2).
      const deviceToken =
        url.searchParams.get('deviceToken') || (req.headers['x-agent-device-token'] as string);
      const apiKey = url.searchParams.get('apiKey') || (req.headers['x-agent-api-key'] as string);

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
      } else {
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
  public notifyJobQueued(job: PrintJob): boolean {
    const ws = this.printerSockets.get(job.printerId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const eventPayload: JobQueuedEvent = {
        jobId: job.id,
        printerId: job.printerId,
        tokenNumber: job.tokenNumber,
        fileName: job.fileName,
        fileUrl: job.fileUrl,
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
