import { z } from 'zod';
import {
  searchContacts,
  getContactById,
  getConversationsForContact,
  getConversationMessages,
  getCallTranscript,
  listUsers,
  getBrokerLeadsOverview,
  listPipelines,
  getOpportunitiesByStage,
  createTask,
  updateTask,
  completeTask,
  createNote,
  getContactTasks,
  getContactNotes,
  updateLeadStatus,
  getLastOutboundMessageDate,
  getOpportunitiesForContact,
  updateOpportunityStage,
  updateOpportunityValue,
  reassignContact,
  createContact,
  createOpportunity,
} from './ghl-client.js';
import {
  assertContactAccess,
  assertConversationAccess,
  assertMessageAccess,
  filterByOwnership,
  isLeadership,
  canViewAll,
  AccessDeniedError,
} from './access.js';
import { resolveGhlUserId, UserResolutionError } from './brokerResolver.js';

function denied(err) {
  return { content: [{ type: 'text', text: `Access denied: ${err.message}` }], isError: true };
}

/**
 * Registers all GHL coaching tools on a given McpServer instance, scoped to the
 * given identity. identity = { name, role: 'leadership' | 'broker' | 'setter', ghlUserId }.
 * Leadership sees and edits everything. Setters get the same broad READ access as
 * leadership (any contact/conversation/notes/tasks/opportunities) but are restricted
 * like brokers on WRITE tools (create/edit tasks, notes, priority, stage, reassignment) -
 * see the `canViewAll` vs default (leadership-only) bypass passed to each access check
 * below. Brokers are restricted to contacts/deals assigned to their own ghlUserId on
 * both reads and writes - enforced here, not just in the system prompt, so it holds
 * even if someone tries to ask around it.
 */
export function registerTools(server, identity) {
  server.tool(
    'search_contacts',
    'Search GHL contacts by name, email, or phone. Returns contact IDs needed for other tools. Use this first when the user refers to a lead/customer by name. Non-leadership brokers only see contacts assigned to them; setters can search and view all contacts (read-only).',
    { query: z.string().describe('Name, email, or phone number to search for') },
    async ({ query }) => {
      const results = await searchContacts(query);
      const scoped = filterByOwnership(results, identity, 'assignedTo', canViewAll);
      return { content: [{ type: 'text', text: JSON.stringify(scoped, null, 2) }] };
    }
  );

  server.tool(
    'create_contact',
    'Create a brand new contact/lead in GHL. Use this any time the user expresses an intent to add someone to the CRM in natural language - not one fixed phrase, e.g. "create a contact for John, his number is 555-123-4567", "add a new lead, Sarah Miller, sarah@email.com", "I just met someone named Mike, make a contact, here\'s his number", "can you make an account for this guy". Extract whatever name and phone/email the user gives you - you need at least a first name and one of phone or email; if both are missing, ask rather than guessing. New contacts are assigned to the caller by default: brokers and setters always get themselves. Leadership also defaults to themselves, but since leadership monitors brokers rather than working leads directly, if leadership says who this contact is actually for (e.g. "create this contact and put it under Charlie"), pass assignedToBrokerName instead - non-leadership callers cannot use assignedToBrokerName, a contact they create always goes to them. This tool ONLY creates the contact record - it does NOT add them to a pipeline/stage as an opportunity, even if the user mentions a pipeline/stage/source in the same message; use create_opportunity separately for that (with this tool\'s returned contact ID), only if the user actually asks for it. If GHL already has a contact with this phone or email (this account blocks duplicate contacts), the result comes back as alreadyExists:true with the EXISTING contact\'s ID instead of a new one - tell the user plainly that this person is already in the CRM rather than claiming you created a new contact.',
    {
      firstName: z.string().describe('Contact\'s first name'),
      lastName: z.string().optional().describe('Contact\'s last name, if given'),
      phone: z.string().optional().describe('Phone number, in whatever format the user gave it - pass it through as-is'),
      email: z.string().optional().describe('Email address, if given'),
      source: z.string().optional().describe('Where this lead came from (GHL\'s built-in contact source field, free text) - e.g. "Referral", "Instagram DM", "Walk-in". Only set this if the user actually says where the lead came from - defaults to "AI Assistant" if omitted.'),
      assignedToBrokerName: z.string().optional().describe('Leadership only: assign this new contact to a specific broker by name (resolved via list_brokers) instead of to yourself'),
    },
    async ({ firstName, lastName, phone, email, source, assignedToBrokerName }) => {
      if (!phone && !email) {
        return { content: [{ type: 'text', text: 'Error: need at least a phone number or an email to create a contact.' }], isError: true };
      }
      if (assignedToBrokerName && !isLeadership(identity)) {
        return denied(new Error('Only leadership can assign a new contact to someone else - a contact you create always goes to you.'));
      }

      let assignedTo = identity.ghlUserId || undefined;
      if (assignedToBrokerName) {
        try {
          assignedTo = await resolveGhlUserId(assignedToBrokerName);
        } catch (err) {
          if (err instanceof UserResolutionError) return denied(err);
          throw err;
        }
      } else if (!assignedTo && isLeadership(identity)) {
        // Leadership caller with no GHL user account of their own (e.g. no
        // corresponding user in list_brokers) - fall back to unassigned
        // rather than failing the whole request.
        try {
          assignedTo = await resolveGhlUserId(identity.name);
        } catch (err) {
          assignedTo = undefined;
        }
      }

      try {
        const result = await createContact({ firstName, lastName, phone, email, source, assignedTo });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err.existingContactId) {
          return { content: [{ type: 'text', text: JSON.stringify({ alreadyExists: true, existingContactId: err.existingContactId, message: err.message }, null, 2) }] };
        }
        throw err;
      }
    }
  );

  server.tool(
    'create_opportunity',
    'Create a new opportunity (deal) in a specific pipeline/stage for an existing contact - use this when the user explicitly asks to add someone to a pipeline, e.g. "add John to the Buyer pipeline, Qualifying stage" or "put Sarah\'s deal in at $500k, source Instagram DM". Never call this automatically just because create_contact mentioned a pipeline/stage/source in the same message - only when the user actually asks to create the opportunity/deal itself, as a separate action. Use list_pipelines first to resolve pipelineId/pipelineStageId by name, and search_contacts or create_contact to get the contactId. Non-leadership users can only create opportunities for their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID this opportunity is for, from search_contacts or create_contact'),
      pipelineId: z.string().describe('The pipeline ID, from list_pipelines'),
      pipelineStageId: z.string().describe('The stage ID within that pipeline, from list_pipelines'),
      name: z.string().optional().describe('Opportunity name - defaults to the contact\'s name if omitted'),
      monetaryValue: z.number().optional().describe('Deal value/budget, if known'),
      source: z.string().optional().describe('Where this lead/deal came from (GHL\'s built-in opportunity source field, free text) - e.g. "Referral", "Instagram DM", "Walk-in". Only set this if the user actually says it.'),
    },
    async ({ contactId, pipelineId, pipelineStageId, name, monetaryValue, source }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      let opportunityName = name;
      if (!opportunityName) {
        const contact = await getContactById(contactId);
        opportunityName = contact.name || 'New Opportunity';
      }

      const assignedTo = identity.ghlUserId || undefined;
      const result = await createOpportunity({
        contactId,
        pipelineId,
        pipelineStageId,
        name: opportunityName,
        monetaryValue,
        source,
        assignedTo,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_conversations',
    'Get the list of conversations for a contact, given their contact ID. Returns conversation IDs needed to fetch the message timeline.',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity, canViewAll);
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
        await assertConversationAccess(conversationId, identity, canViewAll);
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
        await assertMessageAccess(messageId, identity, canViewAll);
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
    'Get a compact summary of every lead assigned to a broker: touch count (most recent 100 messages per lead), call count, lastOutboundMessageDate (the date of the broker\'s most recent outbound message in this contact\'s primary conversation thread - use this directly for cadence/overdue checks instead of calling get_last_broker_contact_date per lead; only fall back to that separate tool if you need to check EVERY conversation thread for a contact, not just the primary one), lastTouchDate (the date of the most recent message in EITHER direction, not just outbound - use this, not lastOutboundMessageDate, when checking whether a lead has had ANY recent activity at all, since a lead can show recent engagement via an inbound reply or an untracked-channel follow-up with no logged outbound message), "outcome" (the GHL "Broker Outcomes" custom field - one of "Call Performed", "Call No Show", "Scheduled Showing", "Performed Showing", "Sale Closed", "Ghosted / Abandoned", "Lost", or null if never set by the broker), Lead Priority status (Buy Now/Active/Nurture/Low Priority/On Hold/Closed - the primary prioritization signal), and Hot flag (a separate boolean marking especially urgent buying signals within any priority tier). A lead with outcome "Sale Closed" or "Lost" is done - the broker has explicitly marked it, and this is a stronger/more current signal than the priority tier field, which can be stale. Does NOT include message text or transcripts. Non-leadership brokers can only request their own overview (their own ghlUserId) - requesting another broker\'s overview is denied. Setters can request any broker\'s overview (read-only).',
    { brokerId: z.string().describe('The GHL user ID of the broker, from list_brokers') },
    async ({ brokerId }) => {
      if (!canViewAll(identity) && brokerId !== identity.ghlUserId) {
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
    'Get all leads/opportunities currently sitting in a specific pipeline stage. Returns contact IDs which can then be used with get_conversations, get_conversation_timeline, and get_call_transcript to analyze those specific leads. Non-leadership brokers only see opportunities assigned to them; setters see all opportunities (read-only).',
    {
      pipelineId: z.string().describe('The pipeline ID, from list_pipelines'),
      stageId: z.string().describe('The stage ID within that pipeline, from list_pipelines'),
    },
    async ({ pipelineId, stageId }) => {
      const results = await getOpportunitiesByStage(pipelineId, stageId);
      const scoped = filterByOwnership(results, identity, 'assignedTo', canViewAll);
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
    'update_task',
    'Edit an existing follow-up task on a contact/lead - title, description, and/or due date. Use get_contact_tasks first to find the right task ID. Only include the fields the user actually wants changed; anything omitted is left untouched. Use this when explicitly asked to update/reschedule/edit a task - never edit tasks proactively without being asked, same principle as create_task. Non-leadership users can only update tasks on their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID this task belongs to'),
      taskId: z.string().describe('The GHL task ID, from get_contact_tasks'),
      title: z.string().optional().describe('New task title - omit to leave unchanged'),
      body: z.string().optional().describe('New task description/details - omit to leave unchanged'),
      dueDate: z.string().optional().describe('New due date in ISO 8601 format, e.g. 2026-08-01T09:00:00-04:00 - omit to leave unchanged'),
    },
    async ({ contactId, taskId, title, body, dueDate }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      if (title === undefined && body === undefined && dueDate === undefined) {
        return { content: [{ type: 'text', text: 'Error: must provide at least one of title, body, or dueDate.' }], isError: true };
      }
      const result = await updateTask(contactId, taskId, { title, body, dueDate });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'complete_task',
    'Mark a follow-up task on a contact/lead as completed. Use get_contact_tasks first to find the right task ID if the user doesn\'t already know it. Only use this when a broker explicitly says a task is done - e.g. "mark that as done," "I called Barry, complete that task" - never mark something complete on inference alone. Non-leadership users can only complete tasks on their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID this task belongs to'),
      taskId: z.string().describe('The GHL task ID, from get_contact_tasks'),
    },
    async ({ contactId, taskId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const result = await completeTask(contactId, taskId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_contact_tasks',
    'Get open and completed tasks for a contact/lead, including due dates. Use this to check whether a lead has a defined next action: if there are no open (incomplete) tasks, that lead has no next step, which is worth flagging - every active lead should have one. Also use this to find tasks due today. Non-leadership brokers can only check tasks on their own contacts; setters can check tasks on any contact (read-only).',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity, canViewAll);
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
    'Get all notes logged on a contact/lead, most relevant for catching updates that happened outside the tracked conversation channels - e.g. a broker reporting they called on a personal cell, or that a showing/deal milestone happened, gets logged here even though it won\'t show up as an inbound/outbound message. ALWAYS check this alongside get_conversation_timeline and get_last_broker_contact_date before concluding a lead has been neglected or has no recent activity - a lead can look stale by message data alone while a recent note shows real progress. Non-leadership brokers can only check notes on their own contacts; setters can check notes on any contact (read-only).',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity, canViewAll);
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
    'Get the date of the most recent OUTBOUND message (broker -> lead) for a contact, checking ALL of that contact\'s conversation threads - the real, automatic signal for "when did the broker last actually reach out," derived from real message data rather than anything manually logged. Use this to check whether a lead is overdue for their priority tier\'s expected cadence (Buy Now: contact almost daily; Active: regular/weekly follow-up; Nurture: occasional). NOTE: get_broker_leads_overview already returns a lastOutboundMessageDate per lead (from each contact\'s primary conversation thread) - use that directly when scanning a broker\'s whole lead list, and only call this tool for a specific contact when you need to check every thread, not just the primary one (rare - most contacts only have one). Returns null if there has never been an outbound message. Non-leadership brokers can only check their own contacts; setters can check any contact (read-only).',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity, canViewAll);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const lastDate = await getLastOutboundMessageDate(contactId);
      return { content: [{ type: 'text', text: JSON.stringify({ lastOutboundMessageDate: lastDate }, null, 2) }] };
    }
  );

  server.tool(
    'get_opportunities_for_contact',
    'Get all opportunities (deals) for a specific contact, including which pipeline/stage each is currently in and its monetary value (budget). Use this before update_opportunity_stage or update_opportunity_value to find the right opportunity ID and confirm its current stage/value. Non-leadership brokers can only check their own contacts; setters can check any contact (read-only).',
    { contactId: z.string().describe('The GHL contact ID') },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity, canViewAll);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const results = await getOpportunitiesForContact(contactId);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    'update_opportunity_stage',
    'Move an opportunity (deal) to a different pipeline stage. Use list_pipelines first to resolve the target stage ID by name, and get_opportunities_for_contact to find the right opportunity ID. Only use this when explicitly asked to move a lead\'s stage (e.g. a broker choosing to send a no-show lead to reactivation) - never move a stage based on your own inference alone. Non-leadership users can only move opportunities belonging to their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID this opportunity belongs to, used to verify ownership'),
      opportunityId: z.string().describe('The opportunity ID, from get_opportunities_for_contact'),
      stageId: z.string().describe('The target pipeline stage ID, from list_pipelines'),
    },
    async ({ contactId, opportunityId, stageId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const result = await updateOpportunityStage(opportunityId, stageId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'update_opportunity_value',
    'Update an opportunity\'s (deal\'s) monetary value - this is the lead\'s budget/deal value field in GHL. Use get_opportunities_for_contact first to find the right opportunity ID and confirm the current value. Only use this when explicitly asked to update a lead\'s budget/deal value (e.g. a broker relaying a new number the client gave them) - never change it based on your own inference from conversation alone. Non-leadership users can only update opportunities belonging to their own contacts.',
    {
      contactId: z.string().describe('The GHL contact ID this opportunity belongs to, used to verify ownership'),
      opportunityId: z.string().describe('The opportunity ID, from get_opportunities_for_contact'),
      monetaryValue: z.number().describe('The new monetary value (budget/deal value) for this opportunity'),
    },
    async ({ contactId, opportunityId, monetaryValue }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const result = await updateOpportunityValue(opportunityId, monetaryValue);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'reassign_contact',
    'Reassign a contact/lead to a different broker (changes who owns and is responsible for them). Use list_brokers first to resolve the new owner\'s user ID by name. Only use this when explicitly asked to reassign a lead (e.g. a broker choosing to send a no-show lead to reactivation, which gets reassigned to a specific team member) - never reassign based on your own inference alone, this is a significant action. Non-leadership users can only reassign their own contacts (giving them up), not reassign contacts belonging to other brokers.',
    {
      contactId: z.string().describe('The GHL contact ID to reassign'),
      newAssignedToUserId: z.string().describe('The GHL user ID of the new owner, from list_brokers'),
    },
    async ({ contactId, newAssignedToUserId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }
      const result = await reassignContact(contactId, newAssignedToUserId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // Buyer Pipeline's "Reactivation Leads" stage - see list_pipelines. Hardcoded rather than
  // resolved by name on every call, same convention as the Buyer Pipeline ID hardcoded in the
  // WhatsApp bot's budgetBackfill.js - this pipeline's structure only changes when someone
  // edits it in the GHL pipeline builder, not per-request.
  const BUYER_PIPELINE_ID = 'yp2TxpYmvRutPkNuoP69';
  const REACTIVATION_STAGE_ID = '38e75d33-3228-46e0-b789-a8d7e85c20e3';

  server.tool(
    'reactivate_lead',
    'Send a lead to reactivation: moves its Buyer Pipeline opportunity to the "Reactivation Leads" stage AND reassigns the contact to Karim Timani (the setter, who owns follow-up on reactivation leads) - one combined action for both steps. Use this when a broker says something like "reactivate this lead," "send [name] to reactivation," or "sign [name] up for reactivation" - resolve the contact with search_contacts first (the boat/yacht they mentioned is just context to help you pick the right contact/opportunity if the client has more than one, not something to record). Non-leadership users can only reactivate their OWN contacts - this is effectively giving the lead up to Karim, same restriction as reassign_contact. Fails with a clear error if the contact has no opportunity in the Buyer Pipeline (nothing to move) - never guess which opportunity to move if there is more than one Buyer Pipeline match.',
    {
      contactId: z.string().describe('The GHL contact ID, from search_contacts'),
    },
    async ({ contactId }) => {
      try {
        await assertContactAccess(contactId, identity);
      } catch (err) {
        if (err instanceof AccessDeniedError) return denied(err);
        throw err;
      }

      const opportunities = await getOpportunitiesForContact(contactId);
      const buyerOpps = opportunities.filter((o) => o.pipelineId === BUYER_PIPELINE_ID);
      if (buyerOpps.length === 0) {
        return { content: [{ type: 'text', text: 'Error: this contact has no opportunity in the Buyer Pipeline - nothing to move to Reactivation Leads.' }], isError: true };
      }
      if (buyerOpps.length > 1) {
        return { content: [{ type: 'text', text: `Error: this contact has ${buyerOpps.length} opportunities in the Buyer Pipeline - ask which one before reactivating rather than guessing.` }], isError: true };
      }

      let karimUserId;
      try {
        karimUserId = await resolveGhlUserId('Karim Timani');
      } catch (err) {
        if (err instanceof UserResolutionError) return denied(err);
        throw err;
      }

      // Move the stage BEFORE reassigning - assertContactAccess above only holds while the
      // broker still owns the contact; moving the stage after handing it to Karim would fail
      // that same check for a non-leadership caller.
      await updateOpportunityStage(buyerOpps[0].id, REACTIVATION_STAGE_ID);
      const reassignResult = await reassignContact(contactId, karimUserId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            opportunityId: buyerOpps[0].id,
            movedToStage: 'Reactivation Leads',
            reassignedTo: 'Karim Timani',
            contact: reassignResult,
          }, null, 2),
        }],
      };
    }
  );
}
