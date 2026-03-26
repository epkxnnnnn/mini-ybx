/**
 * Trade Plan Service — Save/cancel trade plans from AI responses
 * NOTE: This is NOT broker execution. Plans are informational only.
 */
const crypto = require('crypto');
const KNOWN_SYMBOLS = new Set([
  'XAUUSD', 'XAGUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY',
  'EURJPY', 'AUDUSD', 'NZDUSD', 'USDCHF', 'BTCUSD', 'ETHUSD', 'XTIUSD',
]);

class TradePlanService {
  constructor(options = {}) {
    // Map keyed by "platform:userId" → TradePlan[]
    this.plans = options.plans || new Map();
    // Temporary store for pending confirmations: planId → { platform, userId, plan }
    this.pending = options.pending || new Map();
    // Order execution flow state: "platform:userId" → order state object
    this.orderStates = options.orderStates || new Map();
    // Financial transaction flow state: "platform:userId" → txn state object
    this.txnStates = options.txnStates || new Map();
    // Position management flow state: "platform:userId" → position state object
    this.positionStates = options.positionStates || new Map();
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
   * Create a pending trade plan (awaiting user confirmation)
   * Returns the plan with generated ID
   */
  createPending(platform, userId, planData) {
    const plan = {
      id: crypto.randomUUID(),
      symbol: planData.symbol || 'Unknown',
      direction: planData.direction || 'N/A',
      entry: planData.entry || null,
      sl: planData.sl || null,
      tp: planData.tp || null,
      riskReward: planData.riskReward || 'N/A',
      confidence: planData.confidence || null,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.pending.set(plan.id, { platform, userId, plan });
    this._persist('trade-plans:pending', plan.id, { platform, userId, plan });
    return plan;
  }

  /**
   * Save a pending plan (user confirmed)
   */
  savePlan(planId) {
    const entry = this.pending.get(planId);
    if (!entry) return null;

    const { platform, userId, plan } = entry;
    plan.status = 'saved';
    const key = this._key(platform, userId);
    if (!this.plans.has(key)) this.plans.set(key, []);
    this.plans.get(key).push(plan);
    this.pending.delete(planId);
    this._persist('trade-plans:plans', key, this.plans.get(key));
    this._deletePersisted('trade-plans:pending', planId);
    return plan;
  }

  /**
   * Cancel a pending plan (user rejected)
   */
  cancelPlan(planId) {
    const entry = this.pending.get(planId);
    if (!entry) return null;
    entry.plan.status = 'cancelled';
    this.pending.delete(planId);
    this._deletePersisted('trade-plans:pending', planId);
    return entry.plan;
  }

  /**
   * Get all saved plans for a user
   */
  getPlans(platform, userId) {
    return this.plans.get(this._key(platform, userId)) || [];
  }

  // ========== Order Execution State Machine ==========

  /**
   * Get a pending plan by ID (for order execution flow)
   */
  getPendingPlan(planId) {
    return this.pending.get(planId) || null;
  }

  /**
   * Get order flow state for a user
   */
  getOrderState(platform, userId) {
    return this.orderStates.get(this._key(platform, userId)) || null;
  }

  /**
   * Set order flow state for a user
   */
  setOrderState(platform, userId, state) {
    const key = this._key(platform, userId);
    this.orderStates.set(key, state);
    this._persist('trade-plans:order-states', key, state);
  }

  /**
   * Clear order flow state for a user
   */
  clearOrderState(platform, userId) {
    const key = this._key(platform, userId);
    this.orderStates.delete(key);
    this._deletePersisted('trade-plans:order-states', key);
  }

  // ========== Financial Transaction State Machine ==========

  getTxnState(platform, userId) {
    return this.txnStates.get(this._key(platform, userId)) || null;
  }

  setTxnState(platform, userId, state) {
    const key = this._key(platform, userId);
    this.txnStates.set(key, state);
    this._persist('trade-plans:txn-states', key, state);
  }

  clearTxnState(platform, userId) {
    const key = this._key(platform, userId);
    this.txnStates.delete(key);
    this._deletePersisted('trade-plans:txn-states', key);
  }

  // ========== Position Management State Machine ==========

  getPositionState(platform, userId) {
    return this.positionStates.get(this._key(platform, userId)) || null;
  }

  setPositionState(platform, userId, state) {
    const key = this._key(platform, userId);
    this.positionStates.set(key, state);
    this._persist('trade-plans:position-states', key, state);
  }

  clearPositionState(platform, userId) {
    const key = this._key(platform, userId);
    this.positionStates.delete(key);
    this._deletePersisted('trade-plans:position-states', key);
  }

  normalizeTradeSetup(planData) {
    if (!planData || typeof planData !== 'object') return null;

    const symbol = planData.symbol ? String(planData.symbol).toUpperCase() : null;
    const direction = planData.direction ? String(planData.direction).toUpperCase() : null;
    const entry = Number(planData.entry);
    const sl = Number(planData.sl);
    const takeProfits = Array.isArray(planData.takeProfits)
      ? planData.takeProfits.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : [];
    const tp = Number(planData.tp ?? takeProfits[0]);
    const confidence = planData.confidence == null ? null : Number(planData.confidence);

    if (!symbol || !KNOWN_SYMBOLS.has(symbol) || !direction || !['BUY', 'SELL'].includes(direction)) {
      return null;
    }
    if (![entry, sl, tp].every((value) => Number.isFinite(value) && value > 0)) {
      return null;
    }

    const isValidStructure = direction === 'BUY'
      ? sl < entry && tp > entry
      : sl > entry && tp < entry;
    if (!isValidStructure) return null;

    return {
      symbol,
      direction,
      entry,
      sl,
      tp,
      takeProfits: takeProfits.length ? takeProfits : [tp],
      riskReward: planData.riskReward || 'N/A',
      confidence: Number.isFinite(confidence) ? confidence : null,
    };
  }

  /**
   * Detect trade setup in AI response text
   * Returns parsed setup or null
   */
  detectTradeSetup(text) {
    if (!text || typeof text !== 'string') return null;

    // Look for Entry/SL/TP pattern in response
    const entryMatch = text.match(/Entry[:\s]+\$?([\d,]+\.?\d*)/i);
    const slMatch = text.match(/SL[:\s]+\$?([\d,]+\.?\d*)/i);
    const tpMatches = [...text.matchAll(/TP\d?[:\s]+\$?([\d,]+\.?\d*)/gi)];

    if (!entryMatch || !slMatch || tpMatches.length === 0) return null;

    const entry = parseFloat(entryMatch[1].replace(/,/g, ''));
    const sl = parseFloat(slMatch[1].replace(/,/g, ''));
    const takeProfits = tpMatches
      .map((match) => parseFloat(match[1].replace(/,/g, '')))
      .filter((value) => Number.isFinite(value) && value > 0);
    const tp = takeProfits[0];

    // Detect direction
    const directionMatch = text.match(/\b(BUY|SELL)\b/i);
    const direction = directionMatch ? directionMatch[1].toUpperCase() : null;

    // Detect symbol
    const symbolMatch = text.match(/(XAUUSD|XAGUSD|EURUSD|GBPUSD|USDJPY|GBPJPY|EURJPY|AUDUSD|NZDUSD|USDCHF|BTCUSD|ETHUSD|XTIUSD)/i);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : null;

    // R:R
    const rrMatch = text.match(/R:R\s*(?:1:)?([\d.]+)/i);
    const riskReward = rrMatch ? `1:${rrMatch[1]}` : 'N/A';

    // Confidence
    const confMatch = text.match(/Confidence[:\s]+([\d]+)%?/i);
    const confidence = confMatch ? parseInt(confMatch[1], 10) : null;

    return this.normalizeTradeSetup({
      symbol,
      direction,
      entry,
      sl,
      tp,
      takeProfits,
      riskReward,
      confidence,
    });
  }

  resolveTradeSetup(text, structuredSetup = null) {
    const normalizedStructured = this.normalizeTradeSetup(structuredSetup);
    if (normalizedStructured) return normalizedStructured;
    return this.detectTradeSetup(text);
  }
}

module.exports = TradePlanService;
