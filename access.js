import { getContactById, getConversationById, getMessage } from './ghl-client.js';

export class AccessDeniedError extends Error {}

export function isLeadership(identity) {
  return identity?.role === 'leadership';
}

/**
 * Throws if the given contact is not assigned to this identity (unless leadership).
 * Fails CLOSED: if ownership can't be determined, access is denied rather than allowed.
 */
export async function assertContactAccess(contactId, identity) {
  if (isLeadership(identity)) return;

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

export async function assertConversationAccess(conversationId, identity) {
  if (isLeadership(identity)) return;

  let convo;
  try {
    convo = await getConversationById(conversationId);
  } catch (err) {
    throw new AccessDeniedError('Could not verify ownership of this conversation, so access is denied.');
  }

  await assertContactAccess(convo.contactId, identity);
}

export async function assertMessageAccess(messageId, identity) {
  if (isLeadership(identity)) return;

  let message;
  try {
    message = await getMessage(messageId);
  } catch (err) {
    throw new AccessDeniedError('Could not verify ownership of this message, so access is denied.');
  }

  if (!message.conversationId) {
    throw new AccessDeniedError('Could not verify ownership of this message, so access is denied.');
  }

  await assertConversationAccess(message.conversationId, identity);
}

/**
 * Filters a list of items down to only those assigned to this identity (unless leadership).
 * Used for list-style tools (opportunities, search results) rather than single-item lookups.
 */
export function filterByOwnership(items, identity, ownerField = 'assignedTo') {
  if (isLeadership(identity)) return items;
  return items.filter((item) => item[ownerField] && item[ownerField] === identity.ghlUserId);
}
