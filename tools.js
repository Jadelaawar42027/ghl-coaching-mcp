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
} from './ghl-client.js';

/**
 * Registers all GHL coaching tools on a given McpServer instance.
 * Shared between the stdio transport (server.js, for local/Claude Desktop use)
 * and the HTTP transport (server-http.js, for the WhatsApp bot / remote access).
 */
export function registerTools(server) {
  server.tool(
    'search_contacts',
    'Search GHL contacts by name, email, or phone. Returns contact IDs needed for other tools. Use this first when the user refers to a lead/customer by name.',
    { query: z.string().describe('Name, email, or phone number to search for') },
    async ({ query }) => {
      const results = await searchContacts(query);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_conversations',
    'Get the list of conversations for a contact, given their contact ID. Returns conversation IDs needed to fetch the message timeline.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      const results = await getConversationsForContact(contactId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_conversation_timeline',
    'Get the full message timeline for a conversation: SMS, email, and calls, in order, with timestamps and direction (inbound/outbound). Call messages will have no body text - use get_call_transcript separately for those.',
    { conversationId: z.string().describe('The GHL conversation ID') },
    async ({ conversationId }) => {
      const results = await getConversationMessages(conversationId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_call_transcript',
    'Get the transcript for a call, including call direction and a note on speaker labeling. Speaker labels (Speaker 0/1) are based on audio channel, NOT verified identity - always cross-reference self-introductions in the dialogue and the stated call direction before attributing a line to the broker vs. the customer. If uncertain, say so rather than guessing confidently.',
    { messageId: z.string().describe('The message ID of the call, from the conversation timeline') },
    async ({ messageId }) => {
      const transcript = await getCallTranscript(messageId);
      return { content: [{ type: 'text', text: transcript }] };
    }
  );

  server.tool(
    'list_brokers',
    'List all team members/brokers on the account with their user IDs and names. Use this first to resolve a broker name to the user ID needed by get_broker_leads_overview or create_task.',
    {},
    async () => {
      const results = await listUsers();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_broker_leads_overview',
    'Get a compact summary of every lead assigned to a broker: touch count (most recent 100 messages per lead), call count, and showing-booked outcome. Does NOT include message text or transcripts. WORKFLOW: after reviewing this overview, identify 3-8 leads that look most likely to explain a pattern - then call get_conversation_timeline and get_call_transcript on specifically those leads to read the actual content before drawing conclusions. Comparing two brokers means calling this twice, once per broker ID.',
    { brokerId: z.string().describe('The GHL user ID of the broker, from list_brokers') },
    async ({ brokerId }) => {
      const results = await getBrokerLeadsOverview(brokerId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'list_pipelines',
    'List all pipelines and their stages with IDs. Use this to resolve a pipeline/stage name to the IDs needed by get_opportunities_by_stage.',
    {},
    async () => {
      const results = await listPipelines();
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'get_opportunities_by_stage',
    'Get all leads/opportunities currently sitting in a specific pipeline stage. Returns contact IDs which can then be used with get_conversations, get_conversation_timeline, and get_call_transcript to analyze those specific leads.',
    {
      pipelineId: z.string().describe('The pipeline ID, from list_pipelines'),
      stageId: z.string().describe('The stage ID within that pipeline, from list_pipelines'),
    },
    async ({ pipelineId, stageId }) => {
      const results = await getOpportunitiesByStage(pipelineId, stageId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'create_task',
    'Create a follow-up task on a specific contact/lead in GHL, assigned to a broker. Use this when the user explicitly asks to assign or create a task/follow-up/reminder - never create tasks proactively without being asked. Requires the contact ID (from search_contacts or get_opportunities_by_stage) and the assignee\'s user ID (from list_brokers).',
    {
      contactId: z.string().describe('The GHL contact ID this task is about'),
      title: z.string().describe('Short task title'),
      body: z.string().optional().describe('Task description/details'),
      assignedTo: z.string().describe('The GHL user ID of the person this task is assigned to, from list_brokers'),
      dueDate: z.string().describe('Due date in ISO 8601 format, e.g. 2026-08-01T09:00:00-04:00'),
    },
    async ({ contactId, title, body, assignedTo, dueDate }) => {
      const result = await createTask(contactId, { title, body, assignedTo, dueDate });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}
