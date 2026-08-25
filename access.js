import { getContactById, getConversationById, getMessage } from './ghl-client.js';

export class AccessDeniedError extends Error {}

export function isLeadership(identity) {
  return identity?.role === 'leadership';
}

/**
 * Setters get the same broad READ visibility as leadership - they can VIEW
 * any contact/conversation/message/opportunity/task/note across the whole
 * team, which they need for qualification calls on leads that aren't
 * "theirs." They do NOT get leadership's WRITE privileges (creating/editing
 * tasks, notes, priority, stage, reassignment) - those stay gated by
 * isLeadership alone, via each function's default `bypass` below.
 */
export function canViewAll(identity) {
  return isLeadership(identity) || identity?.role === 'setter';
}

/**
 * Throws if the given contact is not assigned to this identity, unless
 * bypass(identity) is true. Fails CLOSED: if ownership can't be determined,
 * access is denied rather than allowed. Defaults to leadership-only bypass
 * (the correct behavior for WRITE tools); pass canViewAll for READ-only
 * tools that should also open up to setters.
 */
export async function assertContactAccess(contactId, identity, bypass = isLeadership) {
  if (bypass(identity)) return;

  let contact;
  try {
    contact = await getContactById(contactId);
  } catch (err) {
    throw new AccessDeniedError('Could not verify ownership of this contact, so access is denied. Ask leadership if you believe this is an error.');
  }

  if (!contact.assignedTo || contact.assignedTo !== identity.ghlUserId) {
    throw new AccessDeniedError('This contact is not assigned to you. Only leadership can view other brokers\' contacts.');
  }
}

export async function assertConversationAccess(conversationId, identity, bypass = isLeadership) {
  if (bypass(identity)) return;

  let convo;
  try {
    convo = await getConversationById(conversationId);
  } catch (err) {
    throw new AccessDeniedError('Could not verify ownership of this conversation, so access is denied.');
  }

  await assertContactAccess(convo.contactId, identity, bypass);
}

export async function assertMessageAccess(messageId, identity, bypass = isLeadership) {
  if (bypass(identity)) return;

  let message;
  try {
    message = await getMessage(messageId);
  } catch (err) {
    throw new AccessDeniedError('Could not verify ownership of this message, so access is denied.');
  }

  if (!message.conversationId) {
    throw new AccessDeniedError('Could not verify ownership of this message, so access is denied.');
  }

  await assertConversationAccess(message.conversationId, identity, bypass);
}

/**
 * Filters a list of items down to only those assigned to this identity,
 * unless bypass(identity) is true (defaults to leadership-only, same as
 * above - pass canViewAll for READ-only tools).
 * Used for list-style tools (opportunities, search results) rather than single-item lookups.
 */
export function filterByOwnership(items, identity, ownerField = 'assignedTo', bypass = isLeadership) {
  if (bypass(identity)) return items;
  return items.filter((item) => item[ownerField] && item[ownerField] === identity.ghlUserId);
}
