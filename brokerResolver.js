import { listUsers } from './ghl-client.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes - broker roster on the GHL side rarely changes

let cachedUsers = null;
let cachedAt = 0;

async function getUsersCached() {
  const now = Date.now();
  if (cachedUsers && now - cachedAt < CACHE_TTL_MS) return cachedUsers;

  cachedUsers = await listUsers();
  cachedAt = now;
  return cachedUsers;
}

export class UserResolutionError extends Error {}

/**
 * Resolves a GHL user ID from a name (case-insensitive, trimmed exact match).
 * Fails closed: throws if no match or more than one match is found, rather
 * than guessing - an ambiguous match granting the wrong person's data would
 * be a much worse outcome than a broker getting a clear "couldn't verify
 * you" error and pinging Aj.
 */
export async function resolveGhlUserId(name) {
  const users = await getUsersCached();
  const normalized = name.trim().toLowerCase();

  const matches = users.filter((u) => u.name.trim().toLowerCase() === normalized);

  if (matches.length === 0) {
    throw new UserResolutionError(
      `No GHL user found matching name "${name}". Ask Aj to check the name in brokerRoster.js matches your name in GHL exactly.`
    );
  }
  if (matches.length > 1) {
    throw new UserResolutionError(
      `Multiple GHL users found matching name "${name}" - can't safely determine which one you are. Ask Aj to resolve the naming conflict in GHL.`
    );
  }

  return matches[0].id;
}
