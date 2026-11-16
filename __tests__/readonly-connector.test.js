import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { READ_ONLY_TOOLS, readOnlyRegistrar, secretMatches } from '../readonly-connector.js';

// tools.js imports ghl-client.js, which refuses to load without these. No GHL call is made here.
process.env.GHL_API_TOKEN ||= 'test';
process.env.GHL_LOCATION_ID ||= 'test';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { registerTools } = await import('../tools.js');

function allToolNames() {
  const names = [];
  registerTools({ tool: (name) => names.push(name) }, { name: 't', role: 'leadership' });
  return names;
}

const WRITE_WORDS = /^(create|send|add|remove|bulk|update|complete|reassign|reactivate|delete|set)_/;

describe('read-only web connector', () => {
  test('only read tools are registered, and every allowlisted tool exists', () => {
    const registered = [];
    const registrar = readOnlyRegistrar({ tool: (name) => registered.push(name) });
    registerTools(registrar, { name: 't', role: 'leadership' });
    assert.deepEqual([...registered].sort(), [...READ_ONLY_TOOLS].sort());
    for (const name of registered) assert.doesNotMatch(name, WRITE_WORDS, `${name} looks like a write tool`);
  });

  test('every tool that writes is left out', () => {
    const left = allToolNames().filter((n) => !READ_ONLY_TOOLS.has(n));
    for (const name of ['send_sms', 'add_note', 'update_lead_status', 'reassign_contact', 'create_task', 'update_opportunity_stage']) {
      assert.ok(left.includes(name), `${name} must not be on the connector`);
    }
    for (const name of left) assert.match(name, WRITE_WORDS, `${name} is excluded but doesn't look like a write - add it to READ_ONLY_TOOLS if it only reads`);
  });

  test('secret check: exact match only, off when unset or short', () => {
    const secret = 'a'.repeat(40);
    assert.equal(secretMatches(secret, secret), true);
    assert.equal(secretMatches(secret.slice(1), secret), false);
    assert.equal(secretMatches(`${secret}b`, secret), false);
    assert.equal(secretMatches('anything', undefined), false);
    assert.equal(secretMatches('short', 'short'), false);
  });
});
