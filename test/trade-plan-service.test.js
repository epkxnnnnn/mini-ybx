const test = require('node:test');
const assert = require('node:assert/strict');

const TradePlanService = require('../src/services/trade-plan-service');

test('detectTradeSetup extracts a valid BUY setup', () => {
  const service = new TradePlanService();
  const plan = service.detectTradeSetup(
    '📊 XAUUSD — BUY\nEntry: 3350.00\nSL: 3340.00\nTP1: 3370.00\nTP2: 3385.00\nR:R 1:2.0\nConfidence: 78%'
  );

  assert.deepEqual(plan, {
    symbol: 'XAUUSD',
    direction: 'BUY',
    entry: 3350,
    sl: 3340,
    tp: 3370,
    takeProfits: [3370, 3385],
    riskReward: '1:2.0',
    confidence: 78,
  });
});

test('detectTradeSetup rejects incomplete or structurally invalid setups', () => {
  const service = new TradePlanService();

  assert.equal(
    service.detectTradeSetup('Entry: 3350\nSL: 3340\nTP1: 3370'),
    null
  );

  assert.equal(
    service.detectTradeSetup('XAUUSD BUY\nEntry: 3350\nSL: 3360\nTP1: 3370'),
    null
  );

  assert.equal(
    service.detectTradeSetup('XAUUSD SELL\nEntry: 3350\nSL: 3340\nTP1: 3330'),
    null
  );

  assert.equal(
    service.detectTradeSetup('UNKNOWN BUY\nEntry: 3350\nSL: 3340\nTP1: 3370'),
    null
  );
});

test('detectTradeSetup extracts a valid SELL setup', () => {
  const service = new TradePlanService();
  const plan = service.detectTradeSetup(
    'EURUSD — SELL\nEntry: 1.0850\nSL: 1.0900\nTP1: 1.0750\nTP2: 1.0700\nR:R 1:2.0\nConfidence: 64%'
  );

  assert.deepEqual(plan, {
    symbol: 'EURUSD',
    direction: 'SELL',
    entry: 1.085,
    sl: 1.09,
    tp: 1.075,
    takeProfits: [1.075, 1.07],
    riskReward: '1:2.0',
    confidence: 64,
  });
});

test('resolveTradeSetup prefers a valid structured setup over reply parsing', () => {
  const service = new TradePlanService();
  const plan = service.resolveTradeSetup(
    'ข้อความทั่วๆ ไปที่ไม่มี setup ชัดเจน',
    {
      symbol: 'XAUUSD',
      direction: 'BUY',
      entry: 3350,
      sl: 3340,
      tp: 3370,
      takeProfits: [3370, 3380],
      confidence: 82,
      riskReward: '1:2.0',
    }
  );

  assert.deepEqual(plan, {
    symbol: 'XAUUSD',
    direction: 'BUY',
    entry: 3350,
    sl: 3340,
    tp: 3370,
    takeProfits: [3370, 3380],
    confidence: 82,
    riskReward: '1:2.0',
  });
});
