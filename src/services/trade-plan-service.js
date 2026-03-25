/**
 * Trade Plan Service — Save/cancel trade plans from AI responses
 * NOTE: This is NOT broker execution. Plans are informational only.
 */
const crypto = require('crypto');

class TradePlanService {
  constructor() {
    // Map keyed by "platform:userId" → TradePlan[]
    this.plans = new Map();
    // Temporary store for pending confirmations: planId → { platform, userId, plan }
    this.pending = new Map();
  }

  _key(platform, userId) {
    return `${platform}:${userId}`;
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
    return entry.plan;
  }

  /**
   * Get all saved plans for a user
   */
  getPlans(platform, userId) {
    return this.plans.get(this._key(platform, userId)) || [];
  }

  /**
   * Detect trade setup in AI response text
   * Returns parsed setup or null
   */
  detectTradeSetup(text) {
    // Look for Entry/SL/TP pattern in response
    const entryMatch = text.match(/Entry[:\s]+\$?([\d,]+\.?\d*)/i);
    const slMatch = text.match(/SL[:\s]+\$?([\d,]+\.?\d*)/i);
    const tpMatch = text.match(/TP\d?[:\s]+\$?([\d,]+\.?\d*)/i);

    if (!entryMatch || !slMatch || !tpMatch) return null;

    const entry = parseFloat(entryMatch[1].replace(/,/g, ''));
    const sl = parseFloat(slMatch[1].replace(/,/g, ''));
    const tp = parseFloat(tpMatch[1].replace(/,/g, ''));

    // Detect direction
    const isBuy = text.match(/BUY/i);
    const direction = isBuy ? 'BUY' : 'SELL';

    // Detect symbol
    const symbolMatch = text.match(/(XAUUSD|XAGUSD|EURUSD|GBPUSD|USDJPY|GBPJPY|EURJPY|AUDUSD|BTCUSD|ETHUSD|XTIUSD)/i);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : 'Unknown';

    // R:R
    const rrMatch = text.match(/R:R\s*(?:1:)?([\d.]+)/i);
    const riskReward = rrMatch ? `1:${rrMatch[1]}` : 'N/A';

    // Confidence
    const confMatch = text.match(/Confidence[:\s]+([\d]+)%?/i);
    const confidence = confMatch ? parseInt(confMatch[1], 10) : null;

    return { symbol, direction, entry, sl, tp, riskReward, confidence };
  }
}

module.exports = TradePlanService;
