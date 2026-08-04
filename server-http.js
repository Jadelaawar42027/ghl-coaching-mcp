import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  throw new Error('Missing MCP_AUTH_TOKEN in .env - required to protect this endpoint before deploying it publicly.');
}

const app = express();
app.use(express.json());

// --- Auth: this endpoint will sit on the public internet in front of real
// lead, broker, and pipeline data, so every request must present the shared
// bearer token before touching any GHL data. ---
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Stateless mode: a fresh McpServer + transport per request. Simpler to run
// and deploy (no session affinity needed across restarts/instances), and
// fits this use case well since each WhatsApp message triggers one or a few
// tool calls, not a long-lived interactive session.
app.post('/mcp', requireAuth, async (req, res) => {
  const server = new McpServer({ name: 'ghl-coaching-mcp', version: '1.0.0' });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless - no session tracking needed
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// GET/DELETE on /mcp aren't used in stateless mode - return a clear error
// instead of a silent hang if something probes these.
app.get('/mcp', requireAuth, (req, res) => {
  res.status(405).json({ error: 'Method not allowed - this server runs in stateless mode (POST only).' });
});

app.get('/', (req, res) => {
  res.send('365 Yachts GHL coaching MCP server (HTTP) is running.');
});

const PORT = process.env.MCP_PORT || 4000;
app.listen(PORT, () => {
  console.log(`GHL MCP HTTP server listening on port ${PORT}`);
});
