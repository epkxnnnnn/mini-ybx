/**
 * YBX AI Engine — Core chat logic powered by Gemini
 */
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");
const CRMClient = require("./services/crm-client");
const { generateSignal } = require("./services/signal-service");

// Load system prompt
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "engulfx-system-prompt.md"),
  "utf-8"
);

// General Jerry prompt (lighter version for non-member channels)
const GENERAL_PROMPT = `คุณคือ Jerry — ผู้ช่วย AI การเทรดของ Yellow Box Markets (YBX)

# บทบาทของคุณ
คุณช่วยเทรดเดอร์วิเคราะห์ตลาดและให้จุด Entry, TP (Take Profit), SL (Stop Loss) ที่ชัดเจน พร้อมคำนวณ Risk:Reward Ratio

# สิ่งที่คุณทำได้
- วิเคราะห์ตลาด Forex, ทองคำ (XAUUSD), Crypto, ดัชนี, สินค้าโภคภัณฑ์
- ให้จุดเข้าเทรด Entry, TP, SL พร้อมเหตุผลจาก Technical Analysis
- คำนวณ R:R (Risk:Reward) ทุกครั้ง
- คำนวณ Lot Size ตามทุนและความเสี่ยงที่ยอมรับได้
- อธิบาย Technical Analysis (แนวรับ/แนวต้าน, candlestick patterns, trend lines, Fibonacci)
- อธิบาย Fundamental Analysis (ข่าวเศรษฐกิจ, ปฏิทินเศรษฐกิจ, ผลกระทบต่อราคา)
- แนะนำการบริหารความเสี่ยง (Risk Management)

# รูปแบบ Trade Signal
เมื่อผู้ใช้ขอจุดเข้าเทรดหรือวิเคราะห์เพื่อเทรด ให้ตอบในรูปแบบนี้:

📊 [ชื่อสินทรัพย์] — [BUY/SELL]
━━━━━━━━━━━━━━
▸ Entry: [ราคา]
▸ SL: [ราคา] (ห่าง [X] จุด)
▸ TP1: [ราคา] (R:R 1:[X])
▸ TP2: [ราคา] (R:R 1:[X])
━━━━━━━━━━━━━━
💡 เหตุผล: [อธิบายสั้นๆ]
⚠️ การเทรดมีความเสี่ยง โปรดใช้วิจารณญาณ

# กฎสำคัญ
- ตอบเป็นภาษาไทยเสมอ ยกเว้นศัพท์เทคนิค (Entry, TP, SL, BUY, SELL, R:R ฯลฯ)
- ห้ามสัญญาว่าจะได้กำไร ย้ำเตือนเรื่องความเสี่ยงเสมอ
- ใส่ Entry, SL, TP, R:R เสมอเมื่อให้ setup — ห้ามบอกว่า "ไม่สามารถให้จุดเข้าเทรดได้"
- เป็นมิตร สุภาพ เข้าใจง่าย
- ถ้าผู้ใช้ถามเรื่องที่ไม่เกี่ยวกับการเทรด ให้ตอบสั้นๆ แล้วพากลับมาเรื่องตลาด

# ข้อมูลบริษัท
Yellow Box Markets — yellowboxmarkets.com
แพลตฟอร์มเทรด: MetaTrader 5 (MT5)
ดาวน์โหลด MT5: https://download.mql5.com/cdn/web/yellow.box.markets.ltd/mt5/yellowboxmarkets5setup.exe`;

const GUARDIAN_MODE_PROMPT = `
[🛡️ GUARDIAN MODE ACTIVE — Margin Level วิกฤต]
ผู้ใช้อยู่ในสถานะเสี่ยง ควรแนะนำอย่างระมัดระวัง:
- แนะนำให้ปิดสถานะที่ขาดทุน
- แนะนำให้ตั้ง/รัด Stop Loss
- ห้ามแนะนำให้เปิดสถานะใหม่
- เตือนเรื่อง Margin Call
ใส่ "🛡️ Guardian Mode: Active" ในทุกข้อความ
`;

class YBXAIEngine {
  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    this.summaryModel = "gemini-2.5-flash-lite";
    // Per-user conversation history (keyed by platform:userId)
    this.conversations = new Map();
    this.summaries = new Map();
    this.maxHistory = 20; // keep last 20 messages per user
    this.summarizeThreshold = 20; // summarize when history exceeds this

    // CRM client (optional — gracefully degrades if not configured)
    if (process.env.CRM_API_URL && process.env.CRM_BOT_EMAIL && process.env.CRM_BOT_PASSWORD) {
      this.crm = new CRMClient({
        baseUrl: process.env.CRM_API_URL,
        email: process.env.CRM_BOT_EMAIL,
        password: process.env.CRM_BOT_PASSWORD,
      });
      console.log("✅ CRM client initialized");
    } else {
      this.crm = null;
      console.log("⏭️  CRM: No credentials, price/analysis features disabled");
    }
  }

  /**
   * Get conversation key
   */
  _key(platform, userId) {
    return `${platform}:${userId}`;
  }

  /**
   * Get or create conversation history for a user
   */
  _getHistory(platform, userId) {
    const key = this._key(platform, userId);
    if (!this.conversations.has(key)) {
      this.conversations.set(key, []);
    }
    return this.conversations.get(key);
  }

  /**
   * Trim history — summarize oldest messages when exceeding threshold
   */
  async _trimHistory(history, platform, userId) {
    if (history.length > this.summarizeThreshold) {
      // Take oldest 10 messages to summarize
      const toSummarize = history.splice(0, 10);
      await this._summarize(toSummarize, platform, userId);
    }
    // Hard cap
    while (history.length > this.maxHistory) {
      history.shift();
    }
  }

  /**
   * Summarize old messages and store the summary
   */
  async _summarize(messages, platform, userId) {
    const key = this._key(platform, userId);
    try {
      const text = messages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(0, 2000);

      const response = await this.client.models.generateContent({
        model: this.summaryModel,
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `สรุปบทสนทนานี้เป็นภาษาไทยใน 2-3 ประโยค เน้นหัวข้อสำคัญที่พูดคุย:\n\n${text}`,
              },
            ],
          },
        ],
        config: { maxOutputTokens: 200 },
      });

      const summary = response.text;
      if (summary) {
        const existing = this.summaries.get(key) || "";
        // Append new summary, keep total under ~500 chars
        const combined = existing
          ? `${existing}\n${summary}`.slice(-500)
          : summary;
        this.summaries.set(key, combined);
      }
    } catch (err) {
      console.error("Summarization error:", err.message);
    }
  }

  /**
   * Unwrap CRM ApiResponse<T> wrapper
   */
  _unwrapCRM(response) {
    if (!response) return null;
    if (response.data !== undefined) return response.data;
    return response;
  }

  /**
   * Fetch real-time price from CRM tick stats
   */
  async fetchPrice(symbol) {
    if (!this.crm) return null;

    try {
      const raw = await this.crm.getTickStats(symbol);
      const stats = this._unwrapCRM(raw);
      const arr = Array.isArray(stats) ? stats : (stats?.ticks || []);
      const tick = arr.find(
        (t) => (t.symbol || t.name || "").toUpperCase() === symbol.toUpperCase()
      );

      if (tick) {
        return {
          symbol: symbol.toUpperCase(),
          bid: tick.bid,
          ask: tick.ask,
          spread: tick.spread ?? (tick.ask - tick.bid),
          high: tick.bidHigh ?? tick.high,
          low: tick.bidLow ?? tick.low,
          change: tick.priceChange,
          changePercent: tick.priceChange, // priceChange is already %
        };
      }
    } catch (err) {
      console.error("CRM price fetch error:", err.message);
    }
    return null;
  }

  /**
   * Fetch market analysis data from CRM
   */
  async fetchAnalysis(symbol) {
    if (!this.crm) return null;

    try {
      const [structure, htfBias, keyLevels, sweeps] = await Promise.allSettled([
        this.crm.getMarketStructure(symbol),
        this.crm.getHtfBias(symbol),
        this.crm.getKeyLevels(symbol),
        this.crm.getLiquiditySweeps(symbol),
      ]);

      const result = {};

      if (structure.status === "fulfilled" && structure.value) {
        result.structure = this._unwrapCRM(structure.value);
      }
      if (htfBias.status === "fulfilled" && htfBias.value) {
        result.htfBias = this._unwrapCRM(htfBias.value);
      }
      if (keyLevels.status === "fulfilled" && keyLevels.value) {
        result.keyLevels = this._unwrapCRM(keyLevels.value);
      }
      if (sweeps.status === "fulfilled" && sweeps.value) {
        result.sweeps = this._unwrapCRM(sweeps.value);
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch (err) {
      console.error("CRM analysis fetch error:", err.message);
      return null;
    }
  }

  /**
   * Detect if user is asking about a specific symbol
   */
  detectSymbol(text) {
    const lower = text.toLowerCase();
    const symbolMap = {
      // Gold
      xauusd: "XAUUSD", gold: "XAUUSD", ทองคำ: "XAUUSD", ทอง: "XAUUSD",
      // Silver
      xagusd: "XAGUSD", silver: "XAGUSD",
      // Major Forex
      eurusd: "EURUSD", gbpusd: "GBPUSD", usdjpy: "USDJPY",
      gbpjpy: "GBPJPY", eurjpy: "EURJPY", audusd: "AUDUSD",
      nzdusd: "NZDUSD", usdchf: "USDCHF",
      // Thai keywords
      ดอลล์: "EURUSD", ยูโร: "EURUSD",
      ปอนด์: "GBPUSD", เยน: "USDJPY",
      ออสซี่: "AUDUSD", นิวซี: "NZDUSD",
      สวิส: "USDCHF",
      // Crypto
      btc: "BTCUSD", bitcoin: "BTCUSD", บิทคอยน์: "BTCUSD",
      eth: "ETHUSD", ethereum: "ETHUSD",
      // Oil
      oil: "XTIUSD", น้ำมัน: "XTIUSD", crude: "XTIUSD", wti: "XTIUSD",
    };

    for (const [keyword, symbol] of Object.entries(symbolMap)) {
      if (lower.includes(keyword)) return symbol;
    }
    return null;
  }

  /**
   * Build enriched price context string
   */
  _buildPriceContext(price) {
    if (!price) return "";

    const parts = [`\n\n[ราคา ${price.symbol} — YBX Live]`];

    if (price.bid != null && price.ask != null) {
      parts.push(
        `Bid: $${this._fmt(price.bid)} | Ask: $${this._fmt(price.ask)} | Spread: ${this._fmt(price.spread)}`
      );
    }
    if (price.high != null && price.low != null) {
      parts.push(`High: $${this._fmt(price.high)} | Low: $${this._fmt(price.low)}`);
    }
    if (price.change != null) {
      const sign = price.change >= 0 ? "+" : "";
      const pct = price.changePercent != null
        ? ` (${price.changePercent > 0 ? "+" : ""}${price.changePercent.toFixed(2)}%)`
        : "";
      parts.push(`Change: ${sign}$${this._fmt(price.change)}${pct}`);
    }

    return parts.join("\n");
  }

  /**
   * Build analysis context string
   */
  _buildAnalysisContext(symbol, analysis) {
    if (!analysis) return "";

    const parts = [`\n[Market Analysis: ${symbol}]`];

    if (analysis.structure) {
      const s = analysis.structure;
      parts.push(
        `Structure: ${s.currentTrend || s.trend || "N/A"} — ${s.structureBreaks?.length ? s.structureBreaks[0].type : "N/A"}`
      );
    }
    if (analysis.htfBias) {
      const hb = analysis.htfBias;
      const biases = hb.biases || [];
      if (biases.length) {
        const biasStr = biases.map((b) => `${b.timeframe}: ${b.bias} (${b.strength})`).join(", ");
        parts.push(`HTF Bias: ${biasStr}`);
      } else {
        parts.push(`HTF Bias: ${hb.bias || hb.direction || "N/A"}`);
      }
    }
    if (analysis.keyLevels) {
      const levels = Array.isArray(analysis.keyLevels) ? analysis.keyLevels : (analysis.keyLevels.levels || []);
      const supports = levels.filter((l) => l.type === "support");
      const resistances = levels.filter((l) => l.type === "resistance");
      const sStr = supports.length
        ? supports.map((l) => `$${this._fmt(l.price)}`).join(", ")
        : "N/A";
      const rStr = resistances.length
        ? resistances.map((l) => `$${this._fmt(l.price)}`).join(", ")
        : "N/A";
      parts.push(`Key Levels: Support ${sStr} | Resistance ${rStr}`);
    }
    if (analysis.sweeps) {
      const sweepArr = Array.isArray(analysis.sweeps) ? analysis.sweeps : (analysis.sweeps.data || []);
      if (sweepArr.length > 0) {
        const recent = sweepArr[0];
        parts.push(
          `Recent Liquidity Sweep: ${recent.sweepType || ""} $${this._fmt(recent.price)}`
        );
      }
    }

    return parts.join("\n");
  }

  _fmt(num) {
    if (num == null) return "N/A";
    const n = Number(num);
    if (isNaN(n)) return String(num);
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Main chat handler — send message, get AI response
   */
  async chat(platform, userId, userMessage, userName = "", memberContext = "", { general = false, guardianMode = false } = {}) {
    const history = this._getHistory(platform, userId);
    const key = this._key(platform, userId);

    // Check if user is asking about a tradeable asset → fetch price + analysis
    let priceContext = "";
    let analysisContext = "";
    let signalContext = "";
    const symbol = this.detectSymbol(userMessage);

    if (symbol) {
      const [price, analysis] = await Promise.allSettled([
        this.fetchPrice(symbol),
        this.fetchAnalysis(symbol),
      ]);

      if (price.status === "fulfilled") {
        priceContext = this._buildPriceContext(price.value);
      }
      if (analysis.status === "fulfilled" && analysis.value) {
        analysisContext = this._buildAnalysisContext(symbol, analysis.value);

        // Generate signal with confidence % from analysis data
        try {
          const signal = generateSignal(
            symbol,
            analysis.value.structure,
            analysis.value.htfBias,
            analysis.value.keyLevels,
            analysis.value.sweeps
          );
          if (signal) {
            signalContext = `\n[AI Signal: ${signal.symbol} — ${signal.direction}, Confidence ${signal.confidence}%, Entry $${signal.entry}, SL $${signal.sl}, TP $${signal.tp}, R:R ${signal.riskReward}]`;
          }
        } catch (err) {
          // Non-critical — continue without signal context
        }
      }
    }

    // Add user message to history (with enriched data)
    const enrichedMessage = userMessage + priceContext + analysisContext + signalContext;
    history.push({ role: "user", content: enrichedMessage });
    await this._trimHistory(history, platform, userId);

    try {
      // Build system instruction with summary context if available
      let systemInstruction = general ? GENERAL_PROMPT : SYSTEM_PROMPT;
      if (guardianMode) {
        systemInstruction += GUARDIAN_MODE_PROMPT;
      }
      if (memberContext) {
        systemInstruction += memberContext;
      }
      const summary = this.summaries.get(key);
      if (summary) {
        systemInstruction += `\n\n[สรุปบทสนทนาก่อนหน้า]: ${summary}`;
      }

      // Convert history to Gemini format
      const contents = history.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens: 1500,
        },
      });

      const assistantMessage =
        response.text || "ขออภัยครับ เกิดข้อผิดพลาด กรุณาลองใหม่";

      // Add assistant response to history
      history.push({ role: "assistant", content: assistantMessage });
      await this._trimHistory(history, platform, userId);

      return assistantMessage;
    } catch (err) {
      console.error("AI Engine error:", err.message);

      // Fallback response
      if (err.message.includes("rate_limit")) {
        return "⚠️ ระบบกำลังโหลด กรุณารอสักครู่แล้วลองใหม่ครับ";
      }
      return "❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ";
    }
  }

  /**
   * Reset user conversation
   */
  resetConversation(platform, userId) {
    const key = this._key(platform, userId);
    this.conversations.delete(key);
    this.summaries.delete(key);
  }
}

module.exports = YBXAIEngine;
