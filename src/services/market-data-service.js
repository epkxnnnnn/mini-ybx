const DEFAULT_PRICE_MAX_AGE_MS = Number(process.env.YBX_PRICE_MAX_AGE_MS || 15000);

function toTimestamp(value) {
  if (value == null || value === '') return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return toTimestamp(Number(trimmed));
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractTickTimestamp(tick) {
  if (!tick || typeof tick !== 'object') return null;

  const candidates = [
    tick.timestamp,
    tick.time,
    tick.updatedAt,
    tick.updated_at,
    tick.lastUpdate,
    tick.lastUpdateAt,
    tick.lastUpdateTime,
    tick.serverTime,
    tick.quoteTime,
    tick.tickTime,
    tick.date,
  ];

  for (const candidate of candidates) {
    const ts = toTimestamp(candidate);
    if (ts) return ts;
  }

  return null;
}

function assessPriceFreshness(tick, now = Date.now(), maxAgeMs = DEFAULT_PRICE_MAX_AGE_MS) {
  const sourceTimestamp = extractTickTimestamp(tick);
  if (!sourceTimestamp) {
    return {
      status: 'unverified',
      label: 'Unverified',
      sourceTimestamp: null,
      ageMs: null,
      maxAgeMs,
    };
  }

  const ageMs = Math.max(0, now - sourceTimestamp);
  const status = ageMs <= maxAgeMs ? 'live' : 'delayed';

  return {
    status,
    label: status === 'live' ? 'Live' : 'Delayed',
    sourceTimestamp,
    ageMs,
    maxAgeMs,
  };
}

function normalizeTick(tick, fallbackSymbol, now = Date.now()) {
  if (!tick || typeof tick !== 'object') return null;

  const freshness = assessPriceFreshness(tick, now);

  return {
    symbol: String(tick.symbol || tick.name || fallbackSymbol || '').toUpperCase(),
    bid: tick.bid,
    ask: tick.ask,
    spread: tick.spread ?? ((tick.ask != null && tick.bid != null) ? (tick.ask - tick.bid) : null),
    high: tick.bidHigh ?? tick.high,
    low: tick.bidLow ?? tick.low,
    open: tick.priceOpen ?? tick.open ?? null,
    change: tick.priceChange ?? tick.change ?? null,
    changePercent: tick.priceChange ?? tick.changePercent ?? null,
    fetchedAt: now,
    sourceTimestamp: freshness.sourceTimestamp,
    priceStatus: freshness.status,
    priceStatusLabel: freshness.label,
    priceAgeMs: freshness.ageMs,
    priceMaxAgeMs: freshness.maxAgeMs,
    raw: tick,
  };
}

module.exports = {
  DEFAULT_PRICE_MAX_AGE_MS,
  toTimestamp,
  extractTickTimestamp,
  assessPriceFreshness,
  normalizeTick,
};
