const test = require('node:test');
const assert = require('node:assert/strict');

const YBXAIEngine = require('../src/ai-engine');

test('shouldCaptureTradeSetup distinguishes trade-oriented prompts from simple price checks', () => {
  const engine = new YBXAIEngine();

  assert.equal(engine.shouldCaptureTradeSetup('วิเคราะห์ XAUUSD ให้หน่อย'), true);
  assert.equal(engine.shouldCaptureTradeSetup('Give me entry sl tp for gold'), true);
  assert.equal(engine.shouldCaptureTradeSetup('ราคา XAUUSD ตอนนี้เท่าไหร่'), false);
  assert.equal(engine.shouldCaptureTradeSetup('hello'), false);
});

test('resetConversation clears cached structured trade setup', () => {
  const engine = new YBXAIEngine();
  engine.lastTradeSetups.set('telegram:123', {
    symbol: 'XAUUSD',
    direction: 'BUY',
    entry: 3350,
    sl: 3340,
    tp: 3370,
  });

  assert.equal(engine.getLastTradeSetup('telegram', '123').symbol, 'XAUUSD');
  engine.resetConversation('telegram', '123');
  assert.equal(engine.getLastTradeSetup('telegram', '123'), null);
});
