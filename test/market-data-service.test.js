const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toTimestamp,
  assessPriceFreshness,
  normalizeTick,
} = require('../src/services/market-data-service');

test('toTimestamp handles seconds, milliseconds, and ISO strings', () => {
  assert.equal(toTimestamp(1710000000), 1710000000 * 1000);
  assert.equal(toTimestamp(1710000000000), 1710000000000);
  assert.equal(toTimestamp('2026-03-25T10:00:00.000Z'), Date.parse('2026-03-25T10:00:00.000Z'));
});

test('assessPriceFreshness classifies live and delayed ticks', () => {
  const now = Date.parse('2026-03-25T10:00:20.000Z');

  const live = assessPriceFreshness({ timestamp: '2026-03-25T10:00:10.000Z' }, now, 15000);
  const delayed = assessPriceFreshness({ timestamp: '2026-03-25T09:59:30.000Z' }, now, 15000);
  const unverified = assessPriceFreshness({}, now, 15000);

  assert.equal(live.status, 'live');
  assert.equal(delayed.status, 'delayed');
  assert.equal(unverified.status, 'unverified');
});

test('normalizeTick returns freshness metadata', () => {
  const now = Date.parse('2026-03-25T10:00:20.000Z');
  const tick = normalizeTick({
    symbol: 'XAUUSD',
    bid: 3050.12,
    ask: 3050.45,
    bidHigh: 3055.01,
    bidLow: 3044.33,
    timestamp: '2026-03-25T10:00:15.000Z',
  }, 'XAUUSD', now);

  assert.equal(tick.symbol, 'XAUUSD');
  assert.equal(tick.priceStatus, 'live');
  assert.equal(tick.priceStatusLabel, 'Live');
  assert.equal(tick.sourceTimestamp, Date.parse('2026-03-25T10:00:15.000Z'));
});
