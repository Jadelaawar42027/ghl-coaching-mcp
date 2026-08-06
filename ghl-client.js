import 'dotenv/config';

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

const TOKEN = process.env.GHL_API_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const COMPANY_ID = process.env.GHL_COMPANY_ID;

if (!TOKEN || !LOCATION_ID) {
  throw new Error('Missing GHL_API_TOKEN or GHL_LOCATION_ID in .env');
}

const OUTCOME_FIELD_ID = 'aDklmSDnzDVvU8Dpy9yg';

// Lead Priority custom field - same field previously called "Lead
// Temperature" (field ID unchanged), now repurposed with 6 status values:
// Buy Now / Active / Nurture / Low Priority / On Hold / Closed.
const PRIORITY_FIELD_ID = process.env.GHL_LEAD_TEMPERATURE_FIELD_ID || null;

// Hot Lead flag - a SEPARATE field from priority. Orthogonal: a lead can be
// "Active" AND "Hot" at the same time. Auto-applied by the AI when it
// detects strong buying-signal language (see systemPrompt.js), not just on
// explicit broker request.
const HOT_FLAG_FIELD_ID = process.env.GHL_HOT_LEAD_FIELD_ID || null;

// Display labels: GHL stores plain text values (no emoji, cleaner for
// filtering/reporting); the emoji is applied here for anything shown to a
// person. Keep this map as the single source of truth for labels so the
// digest and chat always render identically.
export const PRIORITY_LABELS = {
  'Buy Now': '🔴 Buy Now',
  'Active': '🟠 Active',
  'Nurture': '🟡 Nurture',
  'Low Priority': '⚪ Low Priority',
  'On Hold': '⚫ On Hold',
  'Closed': '🚫 Closed',
};

// Note: no separate "Last Checked" field. Last-broker-contact date is
// derived from real conversation data (most recent OUTBOUND message) rather
// than a manually-maintained field - more accurate, and no extra step for
// brokers to remember. See getLastOutboundMessageDate below.

function extractCustomField(contact, fieldId) {
  if (!fieldId) return null;
  const field = (contact.customFields || []).find((f) => f.id === fieldId);
  return field ? field.value : null;
}

function extractHotFlag(contact) {
  if (!HOT_FLAG_FIELD_ID) return false;
  const raw = extractCustomField(contact, HOT_FLAG_FIELD_ID);
  // Checkbox fields in GHL typically come back as an array of selected
  // option labels (e.g. ["Hot"]) when checked, or empty/absent when not.
  if (Array.isArray(raw)) return raw.length > 0;
  return !!raw;
}

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Version: API_VERSION,
    Accept: 'application/json',
  };
}

async function ghlGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const res = await fetch(url, { headers: headers() });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

async function ghlPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GHL API error ${res.status} on ${path}: ${errBody}`);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function searchContacts(query, limit = 10) {
  const data = await ghlGet('/contacts/', { locationId: LOCATION_ID, query, limit });
  return (data.contacts || []).map((c) => ({
    id: c.id,
    name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    email: c.email,
    phone: c.phone,
    assignedTo: c.assignedTo || null,
    priority: extractCustomField(c, PRIORITY_FIELD_ID),
    hot: extractHotFlag(c),
  }));
}

export async function getContactById(contactId) {
  const data = await ghlGet(`/contacts/${contactId}`);
  const c = data.contact || data;
  return {
    id: c.id,
    name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    assignedTo: c.assignedTo || null,
    priority: extractCustomField(c, PRIORITY_FIELD_ID),
    hot: extractHotFlag(c),
  };
}

export async function getConversationById(conversationId) {
  const data = await ghlGet(`/conversations/${conversationId}`);
  const c = data.conversation || data;
  return { id: c.id, contactId: c.contactId };
}

export async function getConversationsForContact(contactId) {
  const data = await ghlGet('/conversations/search', { locationId: LOCATION_ID, contactId });
  return (data.conversations || []).map((c) => ({
    id: c.id,
    contactId: c.contactId,
    lastMessageDate: c.lastMessageDate,
    unreadCount: c.unreadCount,
  }));
}

export async function getConversationMessages(conversationId, limit = 50) {
  const data = await ghlGet(`/conversations/${conversationId}/messages`, { limit });
  const messages = (data.messages?.messages || data.messages || []);
  return messages.map((m) => ({
    id: m.id,
    type: m.messageType,
    direction: m.direction,
    dateAdded: m.dateAdded,
    body: m.body || null,
    status: m.status || null,
  }));
}

/**
 * Returns the date of the most recent OUTBOUND message (broker -> lead)
 * across a contact's conversations, or null if there's never been one.
 * This is the real, automatic signal for "when did the broker last actually
 * contact this lead" - no manual field to remember to update, and it
 * reflects real activity rather than something a broker forgot to log.
 */
export async function getLastOutboundMessageDate(contactId) {
  const conversations = await getConversationsForContact(contactId);
  if (conversations.length === 0) return null;

  let latest = null;
  for (const convo of conversations) {
    const messages = await getConversationMessages(convo.id, 100);
    const outbound = messages.filter((m) => m.direction === 'outbound');
    for (const m of outbound) {
      if (!latest || new Date(m.dateAdded) > new Date(latest)) {
        latest = m.dateAdded;
      }
    }
  }
  return latest;
}

export async function getMessage(messageId) {
  const data = await ghlGet(`/conversations/messages/${messageId}`);
  const m = data.message || data;
  return { id: m.id, type: m.messageType, direction: m.direction, dateAdded: m.dateAdded, conversationId: m.conversationId || null };
}

export async function getCallTranscript(messageId) {
  const [transcriptData, messageMeta] = await Promise.all([
    ghlGet(`/conversations/locations/${LOCATION_ID}/messages/${messageId}/transcription`),
    getMessage(messageId).catch(() => null),
  ]);

  const segments = Array.isArray(transcriptData) ? transcriptData : transcriptData.transcription;
  const transcriptText = !Array.isArray(segments)
    ? (transcriptData.text || JSON.stringify(transcriptData))
    : segments.map((seg) => `[Speaker ${seg.speaker}] ${seg.transcript}`).join('\n');

  const directionNote = messageMeta?.direction === 'outbound'
    ? 'Call direction: OUTBOUND - the broker (365 Yachts) initiated this call, so the broker is the one who typically speaks first and introduces themselves.'
    : messageMeta?.direction === 'inbound'
    ? 'Call direction: INBOUND - the customer initiated this call.'
    : 'Call direction: unknown.';

  return `${directionNote}\n\nNote: speaker labels below are based on audio channel, not identity - use self-introductions in the dialogue to confirm who is speaking rather than assuming a fixed mapping.\n\n${transcriptText}`;
}

export async function listUsers() {
  const data = await ghlGet('/users/search', { companyId: COMPANY_ID, locationId: LOCATION_ID });
  return (data.users || []).map((u) => ({
    id: u.id,
    name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    email: u.email,
  }));
}

export async function getContactsByOwner(ownerId, limit = 100) {
  const data = await ghlPost('/contacts/search', {
    locationId: LOCATION_ID,
    page: 1,
    pageLimit: limit,
    filters: [{ field: 'assignedTo', operator: 'eq', value: ownerId }],
  });

  const contacts = data.contacts || [];
  return contacts.map((c) => {
    const outcomeField = (c.customFields || []).find((f) => f.id === OUTCOME_FIELD_ID);
    return {
      id: c.id,
      name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      dateAdded: c.dateAdded,
      outcome: outcomeField ? outcomeField.value : null,
      priority: extractCustomField(c, PRIORITY_FIELD_ID),
      hot: extractHotFlag(c),
    };
  });
}

export async function getBrokerLeadsOverview(ownerId) {
  const contacts = await getContactsByOwner(ownerId);
  const overview = [];

  for (const contact of contacts) {
    try {
      const conversations = await getConversationsForContact(contact.id);
      if (conversations.length === 0) {
        overview.push({ ...contact, touches: 0, calls: 0 });
        await sleep(150);
        continue;
      }
      const messages = await getConversationMessages(conversations[0].id, 100);
      const calls = messages.filter((m) => m.type === 'TYPE_CALL');
      overview.push({ ...contact, touches: messages.length, calls: calls.length });
    } catch (err) {
      overview.push({ ...contact, error: err.message });
    }
    await sleep(150);
  }

  return overview;
}

export async function listPipelines() {
  const data = await ghlGet('/opportunities/pipelines', { locationId: LOCATION_ID });
  return (data.pipelines || []).map((p) => ({
    id: p.id,
    name: p.name,
    stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
  }));
}

export async function getOpportunitiesByStage(pipelineId, stageId, limit = 100) {
  const data = await ghlGet('/opportunities/search', {
    location_id: LOCATION_ID,
    pipeline_id: pipelineId,
    pipeline_stage_id: stageId,
    limit,
  });

  return (data.opportunities || []).map((o) => ({
    id: o.id,
    contactId: o.contactId,
    name: o.name,
    assignedTo: o.assignedTo,
    status: o.status,
    monetaryValue: o.monetaryValue,
    updatedAt: o.updatedAt,
  }));
}

export async function createTask(contactId, { title, body, assignedTo, dueDate }) {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/tasks`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, assignedTo, dueDate, completed: false }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GHL API error ${res.status} on create task: ${errBody}`);
  }

  return res.json();
}

export async function createNote(contactId, { body, userId }) {
  const res = await fetch(`${BASE_URL}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, userId }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GHL API error ${res.status} on create note: ${errBody}`);
  }

  return res.json();
}

export async function getContactTasks(contactId) {
  const data = await ghlGet(`/contacts/${contactId}/tasks`);
  return (data.tasks || data || []).map((t) => ({
    id: t.id,
    title: t.title,
    body: t.body,
    dueDate: t.dueDate,
    completed: !!t.completed,
    assignedTo: t.assignedTo,
  }));
}

/**
 * Updates a lead's priority and/or hot flag. Pass either or both -
 * whichever is provided gets written, the other is left untouched.
 * @param {string} contactId
 * @param {{priority?: string, hot?: boolean}} updates
 */
export async function updateLeadStatus(contactId, { priority, hot } = {}) {
  const customFields = [];

  if (priority !== undefined) {
    if (!PRIORITY_FIELD_ID) {
      throw new Error('GHL_LEAD_TEMPERATURE_FIELD_ID is not configured - the Lead Priority custom field ID must be set in .env before this can be used.');
    }
    customFields.push({ id: PRIORITY_FIELD_ID, value: priority });
  }

  if (hot !== undefined) {
    if (!HOT_FLAG_FIELD_ID) {
      throw new Error('GHL_HOT_LEAD_FIELD_ID is not configured - the Hot Lead custom field ID must be set in .env before this can be used.');
    }
    // This is a RADIO field with a single option "Hot Lead" - GHL's flag
    // pattern elsewhere in this account (see "Called Lead", "Self Generated
    // Deal"). RADIO fields store a plain string value, not an array like
    // checkboxes - set to the option label to flag, empty string to clear.
    customFields.push({ id: HOT_FLAG_FIELD_ID, value: hot ? 'Hot Lead' : '' });
  }

  if (customFields.length === 0) {
    throw new Error('updateLeadStatus called with neither priority nor hot - nothing to update.');
  }

  const res = await fetch(`${BASE_URL}/contacts/${contactId}`, {
    method: 'PUT',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GHL API error ${res.status} on update lead status: ${errBody}`);
  }

  return res.json();
}