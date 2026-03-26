const test = require('node:test');
const assert = require('node:assert/strict');

const StateRepository = require('../src/services/state-repository');
const GuardianService = require('../src/services/guardian-service');
const TradePlanService = require('../src/services/trade-plan-service');

test('state repository falls back cleanly when DATABASE_URL is absent', async () => {
  const repo = new StateRepository('');

  await repo.init();
  await repo.set('ns', 'key', { ok: true });

  assert.equal(repo.enabled, false);
  assert.deepEqual(await repo.list('ns'), []);
});

test('guardian service persists state mutations through repository hook', async () => {
  const writes = [];
  const repo = {
    set: async (namespace, key, value) => writes.push({ namespace, key, value }),
  };

  const guardian = new GuardianService({ repo });
  guardian.activate('telegram', '123');
  guardian.deactivate('telegram', '123');

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes.length, 2);
  assert.equal(writes[0].namespace, 'guardian:states');
  assert.equal(writes[0].key, 'telegram:123');
  assert.equal(writes[0].value.active, true);
  assert.equal(writes[1].value.active, false);
});

test('trade plan service persists pending and saved plan transitions', async () => {
  const writes = [];
  const deletes = [];
  const repo = {
    set: async (namespace, key, value) => writes.push({ namespace, key, value }),
    delete: async (namespace, key) => deletes.push({ namespace, key }),
  };

  const service = new TradePlanService({ repo });
  const pending = service.createPending('telegram', '123', {
    symbol: 'XAUUSD',
    direction: 'BUY',
    entry: 3350,
    sl: 3340,
    tp: 3370,
  });
  service.savePlan(pending.id);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(writes[0].namespace, 'trade-plans:pending');
  assert.equal(writes[1].namespace, 'trade-plans:plans');
  assert.deepEqual(deletes[0], { namespace: 'trade-plans:pending', key: pending.id });
});
