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
  }));
}

export async function getContactById(contactId) {
  const data = await ghlGet(`/contacts/${contactId}`);
  const c = data.contact || data;
  return {
    id: c.id,
    name: c.contactName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    assignedTo: c.assignedTo || null,
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