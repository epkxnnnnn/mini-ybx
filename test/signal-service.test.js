const test = require('node:test');
const assert = require('node:assert/strict');

const { generateSignal, normalizeDirection } = require('../src/services/signal-service');

test('normalizeDirection recognizes bullish and bearish variants', () => {
  assert.equal(normalizeDirection({ trend: 'bullish' }), 'BUY');
  assert.equal(normalizeDirection({ direction: 'bearish' }), 'SELL');
  assert.equal(normalizeDirection({ bias: 'uptrend' }), 'BUY');
  assert.equal(normalizeDirection({ trend: 'sideways' }), null);
});

test('generateSignal prefers valid market structure and strongest levels', () => {
  const signal = generateSignal(
    'XAUUSD',
    { trend: 'bullish', currentPrice: 3350, timeframe: 'H1' },
    { biases: [{ bias: 'bullish' }, { bias: 'bullish' }, { bias: 'bearish' }] },
    {
      levels: [
        { type: 'support', price: 3340, strength: 2 },
        { type: 'support', price: 3345, strength: 5 },
        { type: 'resistance', price: 3370, strength: 1 },
        { type: 'resistance', price: 3365, strength: 4 },
      ],
    }
  );

  assert.deepEqual(signal, {
    symbol: 'XAUUSD',
    direction: 'BUY',
    confidence: 67,
    entry: 3350,
    sl: 3345,
    tp: 3365,
    riskReward: '1:3.0',
    analysis: 'bullish structure detected',
    timeframe: 'H1',
  });
});

test('generateSignal returns null for ambiguous or invalid setups', () => {
  assert.equal(generateSignal('XAUUSD', { trend: 'sideways', currentPrice: 3350 }), null);
  assert.equal(generateSignal('XAUUSD', { trend: 'bullish', currentPrice: 0 }), null);
});

test('generateSignal falls back to percentage-based SL/TP when levels are unavailable', () => {
  const signal = generateSignal(
    'BTCUSD',
    { direction: 'bearish', currentPrice: 60000 },
    null,
    { levels: [] }
  );

  assert.deepEqual(signal, {
    symbol: 'BTCUSD',
    direction: 'SELL',
    confidence: 50,
    entry: 60000,
    sl: 60600,
    tp: 58800,
    riskReward: '1:2.0',
    analysis: 'bearish structure detected',
    timeframe: 'H4',
  });
});

test('generateSignal clamps low confidence when HTF alignment is weak', () => {
  const signal = generateSignal(
    'XAUUSD',
    { trend: 'bullish', currentPrice: 3350 },
    { biases: [{ bias: 'bearish' }, { bias: 'bearish' }, { bias: 'bearish' }] },
    { levels: [{ type: 'support', price: 3340 }, { type: 'resistance', price: 3370 }] }
  );

  assert.equal(signal.confidence, 35);
});
