const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateFollowUpActions,
  normalizePosition,
  getSuggestionMessage,
} = require('../src/jobs/position-monitor');

test('normalizePosition extracts monitorable position fields', () => {
  const position = normalizePosition({
    accountId: 1001,
    ticket: 77,
    symbol: 'XAUUSD',
    type: 'BUY',
    volume: 0.5,
    profit: 55,
    openPrice: 3350,
    stopLoss: null,
    takeProfit: 3370,
  });

  assert.deepEqual(position, {
    accountId: '1001',
    ticket: '77',
    symbol: 'XAUUSD',
    direction: 'BUY',
    volume: 0.5,
    pnl: 55,
    openPrice: 3350,
    stopLoss: null,
    takeProfit: 3370,
  });
});

test('evaluateFollowUpActions suggests protection for profitable unprotected positions', () => {
  const actions = evaluateFollowUpActions({
    pnl: 60,
    stopLoss: null,
  });

  assert.deepEqual(actions, ['move_sl_be', 'secure_profit']);
});

test('getSuggestionMessage reflects the action intent', () => {
  const position = {
    symbol: 'XAUUSD',
    direction: 'BUY',
    pnl: 80,
  };

  assert.match(getSuggestionMessage(position, 'move_sl_be'), /Break-even/);
  assert.match(getSuggestionMessage(position, 'secure_profit'), /ปิด 50%/);
  assert.match(getSuggestionMessage({ ...position, pnl: -60 }, 'close_half'), /ลดความเสี่ยง/);
});
