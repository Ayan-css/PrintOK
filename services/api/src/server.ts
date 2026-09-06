import http from 'http';
import { createApp } from './app';
import { MemoryStorage } from './storage';
import { AgentWebSocketServer } from './ws';

const PORT = process.env.PORT || 4000;
const storage = new MemoryStorage();
const app = createApp(storage);

const server = http.createServer(app);
const wsServer = new AgentWebSocketServer(server, storage);

// Inject wsServer into app for notification broadcasting
(app as any).wsServer = wsServer;

server.listen(PORT, () => {
  console.log(`[PrintOk Cloud API] Listening on http://localhost:${PORT} (WS: ws://localhost:${PORT}/ws/agent)`);
});

