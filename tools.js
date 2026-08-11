import { z } from 'zod';
import {
  searchContacts,
  getConversationsForContact,
  getConversationMessages,
  getCallTranscript,
  listUsers,
  getBrokerLeadsOverview,
  listPipelines,
  getOpportunitiesByStage,
  createTask,
  createNote,
  getContactTasks,
  getContactNotes,
  updateLeadStatus,
  getLastOutboundMessageDate,
} from './ghl-client.js';
import {
  assertContactAccess,
  assertConversationAccess,
  assertMessageAccess,
  filterByOwnership,
  isLeadership,
  AccessDeniedError,
} from './access.js';

function denied(err) {
  return { content: [{ type: 'text', text: `Access denied: ${err.message}` }], isError: true };
}

/**
 * Registers all GHL coaching tools on a given McpServer instance, scoped to the
 * given identity. identity = { name, role: 'leadership' | 'broker', ghlUserId }.
 * Leadership sees everything. Brokers are restricted to contacts/deals assigned
 * to their own ghlUserId - enforced here, not just in the system prompt, so it
 * holds even if a broker tries to ask around it.
 */
export function registerTools(server, identity) {
  server.tool(
    'search_contacts',
    'Search GHL contacts by name, email, or phone. Returns contact IDs needed for other tools. Use this first when the user refers to a lead/customer by name. Non-leadership users only see contacts assigned to them.',
    { query: z.string().describe('Name, email, or phone number to search for') },
    async ({ query }) => {
      const results = await searchContacts(query);
      const scoped = filterByOwnership(results, identity);
      return { content: [{ type: 'text', text: JSON.stringify(scoped, null, 2) }] };
    }
  );

  server.tool(
    'get_conversations',
    'Get the list of conversations for a contact, given their contact ID. Returns conversation IDs needed to fetch the message timeline.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const results = await getConversationsForContact(contactId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_conversation_timeline',
    'Get the full message timeline for a conversation: SMS, email, and calls, in order, with timestamps and direction (inbound/outbound). Call messages will have no body text - use get_call_transcript separately for those.',
    { conversationId: z.string().describe('The GHL conversation ID') },
    async ({ conversationId }) => {
      try {
        await assertConversationAccess(conversationId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const results = await getConversationMessages(conversationId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_call_transcript',
    'Get the transcript for a call, including call direction and a note on speaker labeling. Speaker labels (Speaker 0/1) are based on audio channel, NOT verified identity - always cross-reference self-introductions in the dialogue and the stated call direction before attributing a line to the broker vs. the customer. If uncertain, say so rather than guessing confidently.',
    { messageId: z.string().describe('The message ID of the call, from the conversation timeline') },
    async ({ messageId }) => {
      try {
        await assertMessageAccess(messageId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const transcript = await getCallTranscript(messageId);
      return { content: [{ type: 'text', text: transcript }] };
    }
  );

  server.tool(
    'list_brokers',
    'List all team members/brokers on the account with their user IDs and names. Use this first to resolve a broker name to the user ID needed by get_broker_leads_overview or create_task. Available to everyone - names/IDs are not sensitive deal data.',
    {},
    async () => {
      const results = await listUsers();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_broker_leads_overview',
    'Get a compact summary of every lead assigned to a broker: touch count (most recent 100 messages per lead), call count, showing-booked outcome, Lead Priority status (Buy Now/Active/Nurture/Low Priority/On Hold/Closed - the primary prioritization signal), and Hot flag (a separate boolean marking especially urgent buying signals within any priority tier). Does NOT include message text or transcripts. Non-leadership users can only request their own overview (their own ghlUserId) - requesting another broker\'s overview is denied.',
    { brokerId: z.string().describe('The GHL user ID of the broker, from list_brokers') },
    async ({ brokerId }) => {
      if (!isLeadership(identity) && brokerId !== identity.ghlUserId) {
        return denied(new Error('You can only view your own lead overview. Cross-broker performance data is restricted to leadership.'));
      }
      const results = await getBrokerLeadsOverview(brokerId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'list_pipelines',
    'List all pipelines and their stages with IDs. Use this to resolve a pipeline/stage name to the IDs needed by get_opportunities_by_stage. Available to everyone - structural info, not deal data.',
    {},
    async () => {
      const results = await listPipelines();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_opportunities_by_stage',
    'Get all leads/opportunities currently sitting in a specific pipeline stage. Returns contact IDs which can then be used with get_conversations, get_conversation_timeline, and get_call_transcript to analyze those specific leads. Non-leadership users only see opportunities assigned to them.',
    {
      pipelineId: z.string().describe('The pipeline ID, from list_pipelines'),
      stageId: z.string().describe('The stage ID within that pipeline, from list_pipelines'),
    },
    async ({ pipelineId, stageId }) => {
      const results = await getOpportunitiesByStage(pipelineId, stageId);
      const scoped = filterByOwnership(results, identity);
      return { content: [{ type: 'text', text: JSON.stringify(scoped, null, 2) }] };
    }
  );

  server.tool(
    'create_task',
    'Create a follow-up task on a specific contact/lead in GHL, assigned to a broker. Use this when the user explicitly asks to assign or create a task/follow-up/reminder - never create tasks proactively without being asked. Requires the contact ID (from search_contacts or get_opportunities_by_stage) and the assignee\'s user ID (from list_brokers). Non-leadership users can only create tasks on their own contacts, assigned to themselves.',
    {
      contactId: z.string().describe('The GHL contact ID this task is about'),
      title: z.string().describe('Short task title'),
      body: z.string().optional().describe('Task description/details'),
      assignedTo: z.string().describe('The GHL user ID of the person this task is assigned to, from list_brokers'),
      dueDate: z.string().describe('Due date in ISO 8601 format, e.g. 2026-08-01T09:00:00-04:00'),
    },
    async ({ contactId, title, body, assignedTo, dueDate }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      if (!isLeadership(identity) && assignedTo !== identity.ghlUserId) {
        return denied(new Error('Non-leadership users can only assign tasks to themselves.'));
      }
      const result = await createTask(contactId, { title, body, assignedTo, dueDate });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'add_note',
    'Add a note to a contact/lead in GHL - use this for logging call summaries, context, or observations that aren\'t a task/follow-up (use create_task for those instead). Requires the contact ID (from search_contacts or get_opportunities_by_stage). Non-leadership users can only add notes to their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID to add the note to'),
      body: z.string().describe('The note text'),
    },
    async ({ contactId, body }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      // userId is optional on GHL's side - omit if this identity has no
      // resolved ghlUserId (e.g. leadership entries that were never given one).
      const result = await createNote(contactId, { body, userId: identity.ghlUserId || undefined });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_contact_tasks',
    'Get open and completed tasks for a contact/lead, including due dates. Use this to check whether a lead has a defined next action: if there are no open (incomplete) tasks, that lead has no next step, which is worth flagging - every active lead should have one. Also use this to find tasks due today. Non-leadership users can only check tasks on their own contacts.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const results = await getContactTasks(contactId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_contact_notes',
    'Get all notes logged on a contact/lead, most relevant for catching updates that happened outside the tracked conversation channels - e.g. a broker reporting they called on a personal cell, or that a showing/deal milestone happened, gets logged here even though it won\'t show up as an inbound/outbound message. ALWAYS check this alongside get_conversation_timeline and get_last_broker_contact_date before concluding a lead has been neglected or has no recent activity - a lead can look stale by message data alone while a recent note shows real progress. Non-leadership users can only check notes on their own contacts.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const results = await getContactNotes(contactId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'update_lead_status',
    'Set a lead\'s Priority status and/or Hot flag - these are separate, independent signals. ' +
    'PRIORITY (6 statuses, drives digest prioritization and expected cadence): "Buy Now" (0-30 days, budget verified, financing/proof of funds available, actively responding and ready to view/schedule - contact almost daily) | "Active" (30-90 days out, serious, still comparing, needs regular follow-up) | "Nurture" (3-12 months, still researching, wants education/recommendations) | "Low Priority" (very early stage, no defined budget, browsing, infrequent engagement) | "On Hold" (explicitly asked to pause - vacation, waiting to sell another boat, waiting on financing) | "Closed" (bought elsewhere, no longer interested, unqualified). Changing PRIORITY requires confirming with the broker first UNLESS they explicitly told you to change it - don\'t silently reassign priority based on your own inference alone. ' +
    'HOT (boolean, independent of priority - a lead can be "Active" AND Hot at the same time): set hot=true automatically, WITHOUT asking first, the moment you see strong buying-signal language in a conversation you\'re reading - phrases like wanting to buy this week, asking to make an offer, saying they\'re flying in soon, having proof of funds ready, or asking to schedule a viewing. This one you apply proactively since the whole point is catching urgency in real time; mention that you flagged it when you do. Non-leadership users can only update their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID'),
      priority: z.enum(['Buy Now', 'Active', 'Nurture', 'Low Priority', 'On Hold', 'Closed']).optional().describe('The new priority status - omit if only updating the Hot flag'),
      hot: z.boolean().optional().describe('Whether this lead should be flagged Hot - omit if only updating priority'),
    },
    async ({ contactId, priority, hot }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      if (priority === undefined && hot === undefined) {
        return { content: [{ type: 'text', text: 'Error: must provide at least one of priority or hot.' }], isError: true };
      }
      const result = await updateLeadStatus(contactId, { priority, hot });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_last_broker_contact_date',
    'Get the date of the most recent OUTBOUND message (broker -> lead) for a contact - the real, automatic signal for "when did the broker last actually reach out," derived from real message data rather than anything manually logged. Use this to check whether a lead is overdue for their priority tier\'s expected cadence (Buy Now: contact almost daily; Active: regular/weekly follow-up; Nurture: occasional). Returns null if there has never been an outbound message. Non-leadership users can only check their own contacts.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const lastDate = await getLastOutboundMessageDate(contactId);
      return { content: [{ type: 'text', text: JSON.stringify({ lastOutboundMessageDate: lastDate }, null, 2) }] };
    }
  );
}
