# GHL Coaching MCP Server

Wraps the GoHighLevel CRM API as MCP tools: contacts, conversations, call
transcripts, broker lead overviews, pipelines/opportunities, task creation.

Two entrypoints, same tool logic (shared via `tools.js`):

| File | Transport | Use case |
|---|---|---|
| `server.js` | stdio | Local use — Claude Desktop, direct CLI testing |
| `server-http.js` | Streamable HTTP | Remote use — the 365 Yachts WhatsApp bot calls this over the internet |

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `GHL_API_TOKEN`, `GHL_LOCATION_ID`, `GHL_COMPANY_ID` — from your GHL account
- `JWT_SECRET` — only needed for `server-http.js`. Generate a strong random value:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  This must match the WhatsApp bot's `JWT_SECRET` exactly — it's what lets this server verify the
  signed identity token (name, role, ghlUserId) the bot mints per caller, so per-broker access
  restrictions in `access.js` hold even against a malicious/confused caller.

## Running locally

**Stdio (Claude Desktop / CLI):**
```bash
npm run start:stdio
```

**HTTP (what the WhatsApp bot actually talks to):**
```bash
npm run start:http
```
Boots on `http://localhost:4000` (or `$PORT`/`$MCP_PORT`). The tool endpoint is `POST /mcp`,
and requires `Authorization: Bearer <signed JWT>` on every request — missing, invalid, expired,
or malformed-identity tokens get a 401.

### Testing the HTTP server is reachable
```bash
curl http://localhost:4000/
# -> "365 Yachts GHL coaching MCP server (HTTP) is running."
```

### Exposing it locally (for testing the WhatsApp bot against this before deploying)
```bash
npx ngrok http 4000
```
Use the resulting URL + `/mcp` as `GHL_MCP_URL` in the WhatsApp bot's `.env`.
Note: this needs its **own** ngrok tunnel, separate from the WhatsApp bot's tunnel —
they're two different local servers on two different ports.

## Deploying (production)

Deploy `server-http.js` the same way as the WhatsApp bot — Railway or Render both work:
1. Push this repo to GitHub
2. Connect it in Railway/Render as its own service (separate from the WhatsApp bot service)
3. Set the same env vars from `.env` in their dashboard
4. Start command is `npm run start:http` (already configured via `railway.json` for Railway)
5. Once deployed, take the resulting URL + `/mcp` and put it in the **WhatsApp bot's**
   `.env` as `GHL_MCP_URL`, with the bot's `JWT_SECRET` matching this service's `JWT_SECRET`

## Available tools

- `search_contacts` — find a lead/customer by name, email, or phone
- `get_conversations` — list conversations for a contact
- `get_conversation_timeline` — full message timeline (SMS/email/calls) for a conversation
- `get_call_transcript` — transcript + direction for a specific call
- `list_brokers` — team members and their GHL user IDs
- `get_broker_leads_overview` — touch/call counts per lead for a broker
- `list_pipelines` — pipelines and stages with IDs
- `get_opportunities_by_stage` — leads sitting in a specific pipeline stage
- `create_task` — create a follow-up task (only when explicitly asked)

## Security note

`server-http.js` sits on the public internet in front of real lead, broker, and pipeline
data once deployed. The JWT verification in `requireAuth`, plus the per-broker ownership
checks in `access.js`, are the only things standing between that data and anyone who finds
the URL — don't skip setting `JWT_SECRET`, don't reuse a weak/guessable value, and don't
commit `.env` (already covered by `.gitignore`).
