import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

// Local/stdio entrypoint - used for Claude Desktop or direct local testing.
// Production (the WhatsApp bot) talks to server-http.js instead.

const server = new McpServer({ name: 'ghl-coaching-mcp', version: '1.0.0' });
// Local stdio use is Aj's own Claude Desktop session - always full access.
registerTools(server, { name: 'Local', role: 'leadership', ghlUserId: null });

const transport = new StdioServerTransport();
await server.connect(transport);
