const test = require('node:test');
const assert = require('node:assert/strict');

const { createRequestId, withTiming } = require('../src/services/logger');

test('createRequestId returns a non-empty hex identifier', () => {
  const id = createRequestId();
  assert.match(id, /^[a-f0-9]{12}$/);
});

test('withTiming returns the wrapped result', async () => {
  const result = await withTiming('unit_test_event', { scope: 'test' }, async () => 'ok');
  assert.equal(result, 'ok');
});

test('withTiming rethrows wrapped errors', async () => {
  await assert.rejects(
    withTiming('unit_test_error', { scope: 'test' }, async () => {
      throw new Error('boom');
    }),
    /boom/
  );
});
