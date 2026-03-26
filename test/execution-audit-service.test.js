const test = require('node:test');
const assert = require('node:assert/strict');

const ExecutionAuditService = require('../src/services/execution-audit-service');

test('execution audit service stores memory events and filters by platform/user', async () => {
  const service = new ExecutionAuditService();
  await service.record({
    platform: 'telegram',
    userId: '1',
    category: 'order',
    action: 'confirm_order',
    status: 'success',
    payload: { dealId: '123' },
  });
  await service.record({
    platform: 'line',
    userId: '2',
    category: 'position',
    action: 'move_sl_be',
    status: 'success',
    payload: {},
  });

  const events = await service.list('telegram', '1');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.dealId, '123');
});
