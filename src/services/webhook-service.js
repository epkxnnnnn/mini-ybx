/**
 * Webhook Service — Per-user TradingView webhook token management
 * Token CRUD + TradingView payload normalization
 */
const crypto = require('crypto');

const KNOWN_SYMBOLS = new Set([
  'XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY',
  'EURJPY', 'AUDUSD', 'NZDUSD', 'USDCHF', 'BTCUSD', 'ETHUSD', 'XTIUSD',
]);

class WebhookService {
  constructor(options = {}) {
    // token → { platform, userId, createdAt }
    this.tokens = options.tokens || new Map();
    // "platform:userId" → token string
    this.userTokens = options.userTokens || new Map();
    // token → signal count
    this.signalCounts = new Map();
    this.repo = options.repo || null;
  }

  _key(platform, userId) {
    return `${platform}:${userId}`;
  }

  _persist(namespace, key, value) {
    if (!this.repo) return;
    this.repo.set(namespace, key, value).catch((err) => {
      console.error(`State persist failed [${namespace}:${key}]:`, err.message);
    });
  }

  _deletePersisted(namespace, key) {
    if (!this.repo) return;
    this.repo.delete(namespace, key).catch((err) => {
      console.error(`State delete failed [${namespace}:${key}]:`, err.message);
    });
  }

  /**
   * Generate a new webhook token for a user.
   * If user already has one, returns existing token.
   */
  generateToken(platform, userId) {
    const userKey = this._key(platform, userId);
    const existing = this.userTokens.get(userKey);
    if (existing && this.tokens.has(existing)) {
      return existing;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenData = { platform, userId: String(userId), createdAt: Date.now() };

    this.tokens.set(token, tokenData);
    this.userTokens.set(userKey, token);
    this.signalCounts.set(token, 0);

    this._persist('webhook:tokens', token, tokenData);
    this._persist('webhook:user-tokens', userKey, token);

    return token;
  }

  /**
   * Regenerate token — revokes old one, creates new one.
   */
  regenerateToken(platform, userId) {
    this.revokeToken(platform, userId);
    return this.generateToken(platform, userId);
  }

  /**
   * Revoke user's webhook token.
   */
  revokeToken(platform, userId) {
    const userKey = this._key(platform, userId);
    const token = this.userTokens.get(userKey);
    if (!token) return false;

    this.tokens.delete(token);
    this.userTokens.delete(userKey);
    this.signalCounts.delete(token);

    this._deletePersisted('webhook:tokens', token);
    this._deletePersisted('webhook:user-tokens', userKey);
    return true;
  }

  /**
   * Validate a webhook token.
   * Returns { platform, userId, createdAt } or null.
   */
  validateToken(token) {
    if (!token || typeof token !== 'string') return null;
    return this.tokens.get(token) || null;
  }

  /**
   * Get token info for a user.
   * Returns { token, createdAt, signalCount } or null.
   */
  getTokenInfo(platform, userId) {
    const userKey = this._key(platform, userId);
    const token = this.userTokens.get(userKey);
    if (!token || !this.tokens.has(token)) return null;

    const data = this.tokens.get(token);
    return {
      token,
      createdAt: data.createdAt,
      signalCount: this.signalCounts.get(token) || 0,
    };
  }

  /**
   * Increment the signal count for a token.
   */
  incrementSignalCount(token) {
    const current = this.signalCounts.get(token) || 0;
    this.signalCounts.set(token, current + 1);
  }

  /**
   * Parse and normalize a TradingView webhook payload.
   * Handles field name variants commonly used in TV alerts.
   * Returns normalized object or throws on validation failure.
   */
  static parseTradingViewPayload(body) {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid payload: expected JSON object');
    }

    // Symbol: ticker, symbol
    const rawSymbol = String(body.ticker || body.symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!rawSymbol || !KNOWN_SYMBOLS.has(rawSymbol)) {
      throw new Error(`Unknown or missing symbol: ${rawSymbol || '(empty)'}. Supported: ${[...KNOWN_SYMBOLS].join(', ')}`);
    }

    // Direction: action, side, direction
    const rawDirection = String(body.action || body.side || body.direction || '').toUpperCase();
    const direction = rawDirection === 'BUY' || rawDirection === 'LONG' ? 'BUY'
      : rawDirection === 'SELL' || rawDirection === 'SHORT' ? 'SELL'
      : null;
    if (!direction) {
      throw new Error(`Invalid direction: "${body.action || body.side || body.direction || ''}". Must be BUY/SELL/LONG/SHORT`);
    }

    // Entry: price, entry, close
    const rawEntry = Number(body.price || body.entry || body.close);
    if (!Number.isFinite(rawEntry) || rawEntry <= 0) {
      throw new Error('Invalid entry price: must be a positive number');
    }

    // SL (optional): sl, stop_loss, stoploss
    const rawSl = body.sl != null ? Number(body.sl)
      : body.stop_loss != null ? Number(body.stop_loss)
      : body.stoploss != null ? Number(body.stoploss)
      : null;
    const sl = rawSl != null && Number.isFinite(rawSl) && rawSl > 0 ? rawSl : null;

    // TP (optional): tp, take_profit, takeprofit
    const rawTp = body.tp != null ? Number(body.tp)
      : body.take_profit != null ? Number(body.take_profit)
      : body.takeprofit != null ? Number(body.takeprofit)
      : null;
    const tp = rawTp != null && Number.isFinite(rawTp) && rawTp > 0 ? rawTp : null;

    // Validate SL/TP structure if both present
    if (sl != null && tp != null) {
      if (direction === 'BUY' && !(sl < rawEntry && tp > rawEntry)) {
        throw new Error('BUY setup: SL must be below entry, TP must be above entry');
      }
      if (direction === 'SELL' && !(sl > rawEntry && tp < rawEntry)) {
        throw new Error('SELL setup: SL must be above entry, TP must be below entry');
      }
    }

    // Risk/Reward
    let riskReward = 'N/A';
    if (sl != null && tp != null) {
      const risk = Math.abs(rawEntry - sl);
      const reward = Math.abs(tp - rawEntry);
      if (risk > 0) {
        riskReward = `1:${(reward / risk).toFixed(1)}`;
      }
    }

    // Timeframe (optional)
    const timeframe = body.timeframe || body.interval || null;

    return {
      symbol: rawSymbol,
      direction,
      entry: rawEntry,
      sl,
      tp,
      riskReward,
      timeframe,
      source: 'tradingview',
    };
  }
}

module.exports = WebhookService;
