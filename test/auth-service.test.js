const test = require('node:test');
const assert = require('node:assert/strict');

const AuthService = require('../src/services/auth-service');

test('session tokens round-trip through generate and validate', () => {
  const auth = new AuthService({});
  const token = auth.generateSessionToken('web', 'web_123');

  assert.deepEqual(auth.validateSessionToken(token), {
    platform: 'web',
    userId: 'web_123',
  });

  auth.destroy();
});

test('malformed session token signatures return null instead of throwing', () => {
  const auth = new AuthService({});
  const token = auth.generateSessionToken('web', 'web_456');
  const payload = token.split('.')[0];

  assert.equal(auth.validateSessionToken(`${payload}.abc`), null);
  assert.equal(auth.validateSessionToken(`${payload}.zz`), null);
  assert.equal(auth.validateSessionToken('not-a-token'), null);

  auth.destroy();
});
