/**
 * Signal Service — Shared signal generation + confidence
 * Extracted from server.js for use across AI engine, bots, and API
 */

const AI_SIGNAL_SYMBOLS = ['XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'];

/**
 * Generate trading signal from CRM analysis data
 */
function generateSignal(symbol, structure, htfBias, keyLevels, sweeps) {
  const struct = structure?.data || structure;
  const biases = htfBias?.data || htfBias;
  const levels = keyLevels?.data || keyLevels;

  if (!struct) return null;

  const direction = (struct.trend || struct.direction || '').toLowerCase().includes('bull') ? 'BUY' : 'SELL';
  const dirKey = direction === 'BUY' ? 'bull' : 'bear';

  // Confidence from HTF bias alignment
  const tfArr = Array.isArray(biases) ? biases : (biases?.biases || biases?.timeframes || []);
  const aligned = tfArr.filter(b => (b.bias || b.direction || '').toLowerCase().includes(dirKey)).length;
  const confidence = tfArr.length ? Math.round((aligned / tfArr.length) * 100) : 50;

  // Key levels for entry/SL/TP
  const levelArr = Array.isArray(levels) ? levels : (levels?.levels || []);
  const currentPrice = parseFloat(struct.price || struct.currentPrice || 0);

  const supports = levelArr.filter(l => parseFloat(l.price) < currentPrice).sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
  const resistances = levelArr.filter(l => parseFloat(l.price) > currentPrice).sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

  let entry, sl, tp;
  if (direction === 'BUY') {
    entry = currentPrice;
    sl = supports[0] ? parseFloat(supports[0].price) : currentPrice * 0.99;
    tp = resistances[0] ? parseFloat(resistances[0].price) : currentPrice * 1.02;
  } else {
    entry = currentPrice;
    sl = resistances[0] ? parseFloat(resistances[0].price) : currentPrice * 1.01;
    tp = supports[0] ? parseFloat(supports[0].price) : currentPrice * 0.98;
  }

  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? (reward / risk).toFixed(1) : '0.0';

  return {
    symbol,
    direction,
    confidence,
    entry: parseFloat(entry.toFixed(symbol.includes('JPY') ? 3 : 2)),
    sl: parseFloat(sl.toFixed(symbol.includes('JPY') ? 3 : 2)),
    tp: parseFloat(tp.toFixed(symbol.includes('JPY') ? 3 : 2)),
    riskReward: `1:${rr}`,
    analysis: struct.summary || struct.description || `${struct.trend || struct.direction || 'N/A'} structure detected`,
    timeframe: struct.timeframe || 'H4',
  };
}

/**
 * Generate signal for a symbol by fetching all data from CRM
 */
async function generateSignalForSymbol(crmClient, symbol) {
  const [structure, htfBias, keyLevels, sweeps] = await Promise.all([
    crmClient.getMarketStructure(symbol).catch(() => null),
    crmClient.getHtfBias(symbol).catch(() => null),
    crmClient.getKeyLevels(symbol).catch(() => null),
    crmClient.getLiquiditySweeps(symbol).catch(() => null),
  ]);
  return generateSignal(symbol, structure, htfBias, keyLevels, sweeps);
}

module.exports = { generateSignal, generateSignalForSymbol, AI_SIGNAL_SYMBOLS };
