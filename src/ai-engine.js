/**
 * YBX AI Engine — Core chat logic powered by Gemini + ENGULF-X knowledge
 */
const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");
const path = require("path");

// Load system prompt
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "engulfx-system-prompt.md"),
  "utf-8"
);

class YBXAIEngine {
  constructor() {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    // Per-user conversation history (keyed by platform:userId)
    this.conversations = new Map();
    this.maxHistory = 20; // keep last 20 messages per user
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
   * Trim history to maxHistory messages
   */
  _trimHistory(history) {
    while (history.length > this.maxHistory) {
      history.shift();
    }
  }

  /**
   * Fetch real-time price from Finnhub (optional)
   */
  async fetchPrice(symbol) {
    if (!process.env.FINNHUB_API_KEY) return null;
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`
      );
      const data = await res.json();
      if (data && data.c) {
        return {
          price: data.c,
          change: data.d,
          changePercent: data.dp,
          high: data.h,
          low: data.l,
          open: data.o,
          prevClose: data.pc,
        };
      }
    } catch (err) {
      console.error("Finnhub error:", err.message);
    }
    return null;
  }

  /**
   * Detect if user is asking about a specific symbol
   */
  detectSymbol(text) {
    const lower = text.toLowerCase();
    const symbolMap = {
      "xauusd": "OANDA:XAU_USD",
      "gold": "OANDA:XAU_USD",
      "ทองคำ": "OANDA:XAU_USD",
      "ทอง": "OANDA:XAU_USD",
      "eurusd": "OANDA:EUR_USD",
      "gbpusd": "OANDA:GBP_USD",
      "usdjpy": "OANDA:USD_JPY",
      "btc": "BINANCE:BTCUSDT",
      "bitcoin": "BINANCE:BTCUSDT",
      "บิทคอยน์": "BINANCE:BTCUSDT",
      "eth": "BINANCE:ETHUSDT",
      "ethereum": "BINANCE:ETHUSDT",
    };

    for (const [keyword, symbol] of Object.entries(symbolMap)) {
      if (lower.includes(keyword)) return symbol;
    }
    return null;
  }

  /**
   * Main chat handler — send message, get AI response
   */
  async chat(platform, userId, userMessage, userName = "") {
    const history = this._getHistory(platform, userId);

    // Check if user is asking about a tradeable asset → fetch price
    let priceContext = "";
    const symbol = this.detectSymbol(userMessage);
    if (symbol) {
      const price = await this.fetchPrice(symbol);
      if (price) {
        priceContext = `\n\n[ข้อมูลราคาล่าสุด ${symbol}]\nราคาปัจจุบัน: $${price.price}\nเปลี่ยนแปลง: ${price.change} (${price.changePercent}%)\nHigh: $${price.high} | Low: $${price.low}\nOpen: $${price.open} | Prev Close: $${price.prevClose}`;
      }
    }

    // Add user message to history
    const enrichedMessage = userMessage + priceContext;
    history.push({ role: "user", content: enrichedMessage });
    this._trimHistory(history);

    try {
      // Convert history to Gemini format
      const contents = history.map((msg) => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

      const response = await this.client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 1500,
        },
      });

      const assistantMessage =
        response.text || "ขออภัยครับ เกิดข้อผิดพลาด กรุณาลองใหม่";

      // Add assistant response to history
      history.push({ role: "assistant", content: assistantMessage });
      this._trimHistory(history);

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
  }
}

module.exports = YBXAIEngine;
