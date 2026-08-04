import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import { resolveGhlUserId, UserResolutionError } from './brokerResolver.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in .env - this is the shared secret used to verify caller identity. Must match the WhatsApp bot\'s JWT_SECRET exactly.');
}

const app = express();
app.use(express.json());

// --- Auth: verifies a short-lived signed token proving WHO is calling
// (name + role), minted by the WhatsApp bot per message based on the
// sender's phone number. The GHL user ID is NOT carried in the token - it's
// resolved here, dynamically, from the name via GHL's own user list. This
// means the WhatsApp bot's roster never needs a GHL ID hardcoded in it, and
// stays correct automatically if IDs ever change on the GHL side. ---
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - missing token' });
  }

  let identity;
  try {
    identity = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized - invalid or expired token' });
  }

  if (identity.role !== 'leadership' && identity.role !== 'broker') {
    return res.status(401).json({ error: 'Unauthorized - malformed identity token' });
  }

  if (identity.role === 'broker') {
    try {
      identity.ghlUserId = await resolveGhlUserId(identity.name);
    } catch (err) {
      if (err instanceof UserResolutionError) {
        return res.status(403).json({ error: err.message });
      }
      console.error('Error resolving broker GHL user ID:', err);
      return res.status(500).json({ error: 'Internal error resolving identity' });
    }
  }

  req.identity = identity; // { name, role, ghlUserId? }
  next();
}

// Stateless mode: a fresh McpServer + transport per request, scoped to the
// caller's verified identity.
app.post('/mcp', requireAuth, async (req, res) => {
  const server = new McpServer({ name: 'ghl-coaching-mcp', version: '1.0.0' });
  registerTools(server, req.identity);

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

app.get('/mcp', requireAuth, (req, res) => {
  res.status(405).json({ error: 'Method not allowed - this server runs in stateless mode (POST only).' });
});

app.get('/', (req, res) => {
  res.send('365 Yachts GHL coaching MCP server (HTTP) is running.');
});

const PORT = process.env.PORT || process.env.MCP_PORT || 4000;
app.listen(PORT, () => {
  console.log(`GHL MCP HTTP server listening on port ${PORT}`);
});
