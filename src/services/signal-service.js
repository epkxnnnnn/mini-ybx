/**
 * Signal Service — Shared signal generation + confidence
 * Extracted from server.js for use across AI engine, bots, and API
 */

const { normalizeTick } = require('./market-data-service');

const AI_SIGNAL_SYMBOLS = ['XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'];

function toNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDirection(struct) {
  const rawDirection = String(struct?.trend || struct?.direction || struct?.bias || '').toLowerCase();
  if (rawDirection.includes('bull') || rawDirection.includes('buy') || rawDirection.includes('up')) {
    return 'BUY';
  }
  if (rawDirection.includes('bear') || rawDirection.includes('sell') || rawDirection.includes('down')) {
    return 'SELL';
  }
  return null;
}

function symbolDecimals(symbol) {
  if (symbol === 'XAUUSD') return 2;
  if (symbol === 'XAGUSD') return 4;
  if (symbol.includes('JPY')) return 3;
  if (symbol.startsWith('BTC') || symbol.startsWith('ETH')) return 2;
  // Forex major/minor pairs default to 5 decimals
  return 5;
}

/**
 * Generate trading signal from CRM analysis data
 */
function generateSignal(symbol, structure, htfBias, keyLevels, sweeps, livePrice = null) {
  const struct = structure?.data || structure;
  const biases = htfBias?.data || htfBias;
  const levels = keyLevels?.data || keyLevels;

  if (!struct) return null;

  const direction = normalizeDirection(struct);
  if (!direction) return null;
  const dirKey = direction === 'BUY' ? 'bull' : 'bear';

  // Confidence from HTF bias alignment
  const tfArr = Array.isArray(biases) ? biases : (biases?.biases || biases?.timeframes || []);
  const aligned = tfArr.filter((b) => {
    const bias = String(b.bias || b.direction || '').toLowerCase();
    return bias.includes(dirKey);
  }).length;
  const confidence = tfArr.length
    ? Math.max(35, Math.min(95, Math.round((aligned / tfArr.length) * 100)))
    : 50;

  // Key levels for entry/SL/TP
  const levelArr = Array.isArray(levels) ? levels : (levels?.levels || []);
  const tick = livePrice ? normalizeTick(livePrice.raw || livePrice, symbol) : null;
  const currentPrice = toNumber((tick && tick.priceStatus === 'live' && tick.bid) || struct.price || struct.currentPrice || struct.entryPrice);
  if (!currentPrice || currentPrice <= 0) return null;
  if (livePrice && (!tick || tick.priceStatus !== 'live')) return null;

  const normalizedLevels = levelArr
    .map((level) => ({
      ...level,
      price: toNumber(level.price),
      strength: toNumber(level.strength) || 0,
    }))
    .filter((level) => level.price && level.price > 0);

  const supports = normalizedLevels
    .filter((l) => String(l.type || '').toLowerCase() === 'support' && l.price < currentPrice)
    .sort((a, b) => (b.strength - a.strength) || (b.price - a.price));
  const resistances = normalizedLevels
    .filter((l) => String(l.type || '').toLowerCase() === 'resistance' && l.price > currentPrice)
    .sort((a, b) => (b.strength - a.strength) || (a.price - b.price));

  let entry, sl, tp;
  if (direction === 'BUY') {
    entry = currentPrice;
    sl = supports[0] ? supports[0].price : currentPrice * 0.99;
    tp = resistances[0] ? resistances[0].price : currentPrice * 1.02;
  } else {
    entry = currentPrice;
    sl = resistances[0] ? resistances[0].price : currentPrice * 1.01;
    tp = supports[0] ? supports[0].price : currentPrice * 0.98;
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0 || reward <= 0) return null;
  const rr = risk > 0 ? (reward / risk).toFixed(1) : '0.0';
  const decimals = symbolDecimals(symbol);

  return {
    symbol,
    direction,
    confidence,
    entry: parseFloat(entry.toFixed(decimals)),
    sl: parseFloat(sl.toFixed(decimals)),
    tp: parseFloat(tp.toFixed(decimals)),
    riskReward: `1:${rr}`,
    analysis: struct.summary || struct.description || `${struct.trend || struct.direction || 'N/A'} structure detected`,
    timeframe: struct.timeframe || 'H4',
    priceStatus: tick ? tick.priceStatus : null,
    sourceTimestamp: tick ? tick.sourceTimestamp : null,
  };
}

/**
 * Generate signal for a symbol by fetching all data from CRM
 */
async function generateSignalForSymbol(crmClient, symbol) {
  const [structure, htfBias, keyLevels, sweeps, livePrices] = await Promise.all([
    crmClient.getMarketStructure(symbol).catch(() => null),
    crmClient.getHtfBias(symbol).catch(() => null),
    crmClient.getKeyLevels(symbol).catch(() => null),
    crmClient.getLiquiditySweeps(symbol).catch(() => null),
    crmClient.getPrices(symbol).catch(() => null),
  ]);
  const liveData = livePrices?.data || livePrices || {};
  const liveTick = liveData[String(symbol || '').toUpperCase()] || liveData[String(symbol || '')] || null;
  const normalizedLiveTick = liveTick
    ? { ...liveTick, timestamp: liveTick.timestamp || liveTick.time || livePrices?.timestamp || livePrices?.fetchedAt || null }
    : null;
  return generateSignal(symbol, structure, htfBias, keyLevels, sweeps, normalizedLiveTick);
}

module.exports = {
  generateSignal,
  generateSignalForSymbol,
  AI_SIGNAL_SYMBOLS,
  normalizeDirection,
  toNumber,
};
