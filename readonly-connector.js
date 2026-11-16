// Read-only connector for web Claude (claude.ai custom connector).
//
// claude.ai can't send the bot's signed identity token, so this is a separate endpoint at a long
// secret URL that needs no sign-in: POST /connector/<READONLY_CONNECTOR_SECRET>. Because anyone
// holding that URL gets in, it only ever exposes READ tools - an allowlist, so a tool added to
// tools.js later stays off this endpoint until someone deliberately adds it here.
//
// Rotate the secret by changing READONLY_CONNECTOR_SECRET on Railway (the old URL stops working
// on the next deploy). Leave it unset to turn the endpoint off entirely.

import crypto from 'node:crypto';

export const READ_ONLY_TOOLS = new Set([
  'search_contacts',
  'get_conversations',
  'get_conversation_timeline',
  'get_call_transcript',
  'list_brokers',
  'get_broker_leads_overview',
  'list_pipelines',
  'get_opportunities_by_stage',
  'get_opportunities_for_contact',
  'get_contact_notes',
  'get_contact_tasks',
  'get_last_broker_contact_date',
  'has_outbound_call_record',
]);

export const CONNECTOR_IDENTITY = Object.freeze({ name: 'Web Claude (read-only)', role: 'leadership', ghlUserId: null });

const MIN_SECRET_LENGTH = 32;

/** A stand-in for McpServer that only lets read-only tools through to registerTools. */
export function readOnlyRegistrar(server) {
  const registered = [];
  return {
    registered,
    tool(name, ...rest) {
      if (!READ_ONLY_TOOLS.has(name)) return undefined;
      registered.push(name);
      return server.tool(name, ...rest);
    },
  };
}

/** Constant-time check of the URL secret. False when the endpoint is off or the secret is too short. */
export function secretMatches(given, expected = process.env.READONLY_CONNECTOR_SECRET) {
  if (!expected || expected.length < MIN_SECRET_LENGTH || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
