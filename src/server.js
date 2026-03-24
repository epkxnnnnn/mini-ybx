/**
 * YBX Chatbot Server — Yellow Box Markets
 * Runs Telegram, Discord, LINE bots + API endpoint
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const YBXAIEngine = require("./ai-engine");
const setupTelegram = require("./bots/telegram");
const setupDiscord = require("./bots/discord");
const setupLINE = require("./bots/line");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Initialize AI Engine
const aiEngine = new YBXAIEngine();

// ========== REST API (for web chat widget) ==========

app.post("/api/chat", async (req, res) => {
  const { message, userId, userName } = req.body;

  if (!message || !userId) {
    return res.status(400).json({ error: "message and userId required" });
  }

  try {
    const reply = await aiEngine.chat("web", userId, message, userName || "");
    res.json({ reply, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("API chat error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/reset", (req, res) => {
  const { userId } = req.body;
  if (userId) {
    aiEngine.resetConversation("web", userId);
  }
  res.json({ success: true });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "YBX Chatbot",
    version: "1.0.0",
    bots: {
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      discord: !!process.env.DISCORD_BOT_TOKEN,
      line: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
    },
  });
});

// TradingView webhook receiver (from your existing setup)
app.post("/webhook/tradingview", (req, res) => {
  const signal = req.body;
  console.log("📨 TradingView Signal:", JSON.stringify(signal));
  // TODO: broadcast to subscribed users
  res.json({ success: true });
});

// ========== Start Bots ==========

console.log("\n🟡 Yellow Box Markets — YBX Chatbot v1.0.0\n");

// Start platform bots (each one checks for its own token)
setupTelegram(aiEngine);
setupDiscord(aiEngine);
setupLINE(app, aiEngine);

// Start HTTP server
app.listen(PORT, () => {
  console.log(`\n🌐 Web chat: http://localhost:${PORT}`);
  console.log(`📡 API endpoint: http://localhost:${PORT}/api/chat`);
  console.log(`💚 Health check: http://localhost:${PORT}/api/health\n`);
});
