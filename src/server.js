/**
 * YBX Chatbot Server — Yellow Box Markets
 * Runs Telegram, Discord, LINE bots + API endpoint
 */
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const YBXAIEngine = require("./ai-engine");
const CRMClient = require("./services/crm-client");
const CommandRouter = require("./services/command-router");
const AuthService = require("./services/auth-service");
const GuardianService = require("./services/guardian-service");
const TradePlanService = require("./services/trade-plan-service");
const { generateSignal, generateSignalForSymbol, AI_SIGNAL_SYMBOLS } = require("./services/signal-service");
const { calculatePortfolio } = require("./services/portfolio-service");
const { startMarginMonitor } = require("./jobs/margin-monitor");
const setupTelegram = require("./bots/telegram");
const setupDiscord = require("./bots/discord");
const setupLINE = require("./bots/line");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// No-cache for webapp HTML to prevent Telegram WebApp caching stale versions
app.use("/webapp", (req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path === "") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

app.use(express.static(path.join(__dirname, "../public")));

// Initialize AI Engine
const aiEngine = new YBXAIEngine();

// Initialize CRM Client + Command Router
const crmClient =
  process.env.CRM_API_URL && process.env.CRM_BOT_EMAIL && process.env.CRM_BOT_PASSWORD
    ? new CRMClient({
        baseUrl: process.env.CRM_API_URL,
        email: process.env.CRM_BOT_EMAIL,
        password: process.env.CRM_BOT_PASSWORD,
      })
    : null;
const authService = crmClient ? new AuthService(crmClient) : null;
const commandRouter = crmClient
  ? new CommandRouter(crmClient, aiEngine, authService)
  : null;

// Initialize Guardian + Trade Plan services
const guardianService = new GuardianService();
const tradePlanService = new TradePlanService();

// ========== REST API (for web chat widget) ==========

app.post("/api/chat", async (req, res) => {
  const { message, userId, userName } = req.body;

  if (!message || !userId) {
    return res.status(400).json({ error: "message and userId required" });
  }

  // Auth gate — require login if authService is available
  if (authService && !authService.isAuthenticated("web", userId)) {
    return res.status(401).json({ requiresLogin: true, error: "Please login first" });
  }

  try {
    // Build member context
    let memberContext = "";
    if (authService) {
      const session = await authService.getSession("web", userId);
      if (session) {
        memberContext = authService.buildMemberContext(session);
      }
    }

    // Try command router first
    if (commandRouter && message.trim().startsWith("/")) {
      const result = await commandRouter.execute(message, "web", userId, userName || "");
      if (result) {
        return res.json({ reply: result.text, timestamp: new Date().toISOString() });
      }
    }

    const reply = await aiEngine.chat("web", userId, message, userName || "", memberContext);
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

// ========== Auth Endpoints ==========

app.post("/api/auth/login", async (req, res) => {
  if (!authService) {
    return res.status(503).json({ error: "Auth not configured" });
  }

  const { email, password, userId } = req.body;
  if (!email || !password || !userId) {
    return res.status(400).json({ error: "email, password, and userId required" });
  }

  try {
    const session = await authService.login("web", userId, email, password);
    res.json({
      success: true,
      member: session.memberData,
    });
  } catch (err) {
    console.error("Web login error:", err.message);
    res.status(401).json({ error: err.message || "Login failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  const { userId } = req.body;
  if (userId) {
    if (authService) authService.logout("web", userId);
    aiEngine.resetConversation("web", userId);
  }
  res.json({ success: true });
});

app.get("/api/auth/session", async (req, res) => {
  if (!authService) {
    return res.json({ authenticated: false });
  }

  const userId = req.query.userId;
  if (!userId) {
    return res.json({ authenticated: false });
  }

  const session = await authService.getSession("web", userId);
  if (session) {
    res.json({ authenticated: true, member: session.memberData });
  } else {
    res.json({ authenticated: false });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "YBX Chatbot",
    version: "2.0.0",
    crm: !!crmClient,
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

// ========== Telegram Mini App (WebApp) API ==========

/**
 * Validate Telegram WebApp initData via HMAC-SHA256
 */
function validateTelegramWebApp(req, res, next) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(503).json({ error: "Telegram bot not configured" });
  }

  const initData = req.headers["x-telegram-init-data"];
  if (!initData) {
    return res.status(401).json({ error: "Missing Telegram init data" });
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return res.status(401).json({ error: "Missing hash in init data" });
    }

    // Build data-check-string: sorted key=value pairs (excluding hash)
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // secret = HMAC-SHA256("WebAppData", bot_token)
    const secret = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    // computed hash = HMAC-SHA256(secret, data_check_string)
    const computed = crypto
      .createHmac("sha256", secret)
      .update(dataCheckString)
      .digest("hex");

    if (computed !== hash) {
      return res.status(401).json({ error: "Invalid Telegram auth" });
    }

    // Attach user info from initData
    const userStr = params.get("user");
    if (userStr) {
      try { req.telegramUser = JSON.parse(userStr); } catch {}
    }

    next();
  } catch (err) {
    console.error("WebApp auth error:", err.message);
    return res.status(401).json({ error: "Auth validation failed" });
  }
}

// Apply auth middleware to all webapp routes
app.use("/api/webapp", validateTelegramWebApp);

// Prices — all tick stats
app.get("/api/webapp/prices", async (req, res) => {
  if (!crmClient) {
    return res.status(503).json({ error: "CRM not configured" });
  }
  try {
    const data = await crmClient.getTickStats();
    res.json(data);
  } catch (err) {
    console.error("WebApp prices error:", err.message);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

// ENGULF-X Analysis — parallel fetch for a symbol
app.get("/api/webapp/analysis/:symbol", async (req, res) => {
  if (!crmClient) {
    return res.status(503).json({ error: "CRM not configured" });
  }
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [structure, htfBias, keyLevels, sweeps] = await Promise.all([
      crmClient.getMarketStructure(symbol).catch(() => null),
      crmClient.getHtfBias(symbol).catch(() => null),
      crmClient.getKeyLevels(symbol).catch(() => null),
      crmClient.getLiquiditySweeps(symbol).catch(() => null),
    ]);
    res.json({ symbol, structure, htfBias, keyLevels, sweeps });
  } catch (err) {
    console.error("WebApp analysis error:", err.message);
    res.status(500).json({ error: "Failed to fetch analysis" });
  }
});

// Economic Calendar
app.get("/api/webapp/calendar", async (req, res) => {
  if (!crmClient) {
    return res.status(503).json({ error: "CRM not configured" });
  }
  try {
    const data = await crmClient.getEconomicCalendar(req.query.currency);
    res.json(data);
  } catch (err) {
    console.error("WebApp calendar error:", err.message);
    res.status(500).json({ error: "Failed to fetch calendar" });
  }
});

// Exchange Rate
app.get("/api/webapp/rate", async (req, res) => {
  if (!crmClient) {
    return res.status(503).json({ error: "CRM not configured" });
  }
  try {
    const data = await crmClient.getExchangeRate();
    res.json(data);
  } catch (err) {
    console.error("WebApp rate error:", err.message);
    res.status(500).json({ error: "Failed to fetch rate" });
  }
});

// Mini App — Member profile check
app.get("/api/webapp/profile", async (req, res) => {
  if (!authService || !req.telegramUser) {
    return res.json({ authenticated: false });
  }

  const tgUserId = req.telegramUser.id;
  const session = await authService.getSession("telegram", tgUserId);
  if (session) {
    // Include account data for ENGULF-X access check (shareholder or $100k+)
    const accts = session.accountData;
    const accounts = Array.isArray(accts) ? accts : (accts?.accounts || (accts ? [accts] : []));
    const totalBalance = accounts.reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);
    res.json({
      authenticated: true,
      member: session.memberData,
      totalBalance,
      engulfxAccess: (session.memberData.tier || '').toLowerCase().includes('shareholder') || totalBalance >= 100000,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Mini App — Login directly from webapp
app.post("/api/webapp/login", async (req, res) => {
  if (!authService || !crmClient) {
    return res.status(503).json({ error: "Auth not available" });
  }
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "กรุณากรอกอีเมลและรหัสผ่าน" });
  }

  // Use telegram user ID if available, otherwise generate one
  const userId = req.telegramUser ? req.telegramUser.id : `webapp-${Date.now()}`;
  const platform = req.telegramUser ? "telegram" : "web";

  try {
    await authService.login(platform, userId, email, password);
    const session = await authService.getSession(platform, userId);
    const accts = session.accountData;
    const accounts = Array.isArray(accts) ? accts : (accts?.accounts || (accts ? [accts] : []));
    const totalBalance = accounts.reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);
    res.json({
      success: true,
      member: session.memberData,
      totalBalance,
      engulfxAccess: (session.memberData.tier || '').toLowerCase().includes('shareholder') || totalBalance >= 100000,
    });
  } catch (err) {
    console.error("WebApp login error:", err.message);
    res.status(401).json({ error: err.message || "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
});

// Mini App — Logout
app.post("/api/webapp/logout", async (req, res) => {
  if (!authService) return res.json({ success: true });
  const userId = req.telegramUser ? req.telegramUser.id : null;
  const platform = req.telegramUser ? "telegram" : "web";
  if (userId) {
    authService.logout(platform, userId);
    aiEngine.resetConversation(platform + "-webapp", `tg-webapp-${userId}`);
  }
  res.json({ success: true });
});

// ========== Member Account & Financial Endpoints ==========

// Helper: get member session from Telegram webapp
function getMemberSession(req) {
  if (!authService || !req.telegramUser) return null;
  return authService.getSession("telegram", req.telegramUser.id);
}

// Member trading accounts
app.get("/api/webapp/accounts", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberAccounts(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp accounts error:", err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// Transaction history
app.get("/api/webapp/transactions", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberTransactions(session.accessToken, req.query.page, req.query.pageSize);
    res.json(data);
  } catch (err) {
    console.error("WebApp transactions error:", err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// Transaction summary
app.get("/api/webapp/transactions/summary", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberTransactionSummary(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp summary error:", err.message);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// Deposit
app.post("/api/webapp/deposit", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  const { amount, paymentMethod } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!paymentMethod) return res.status(400).json({ error: "Payment method required" });
  try {
    const data = await crmClient.memberDeposit(session.accessToken, amount, paymentMethod);
    res.json(data);
  } catch (err) {
    console.error("WebApp deposit error:", err.message);
    res.status(err.status || 500).json({ error: err.message, errorCode: err.errorCode });
  }
});

// Withdraw
app.post("/api/webapp/withdraw", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  const { amount, paymentMethod } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!paymentMethod) return res.status(400).json({ error: "Payment method required" });
  try {
    const data = await crmClient.memberWithdraw(session.accessToken, amount, paymentMethod);
    res.json(data);
  } catch (err) {
    console.error("WebApp withdraw error:", err.message);
    res.status(err.status || 500).json({ error: err.message, errorCode: err.errorCode });
  }
});

// Transfer
app.post("/api/webapp/transfer", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  const { amount, transferType, sourceWalletId } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!transferType) return res.status(400).json({ error: "Transfer type required" });
  try {
    const data = await crmClient.memberTransfer(session.accessToken, amount, transferType, sourceWalletId);
    res.json(data);
  } catch (err) {
    console.error("WebApp transfer error:", err.message);
    res.status(err.status || 500).json({ error: err.message, errorCode: err.errorCode });
  }
});

// Copy Trading Providers
app.get("/api/webapp/copy-trading", async (req, res) => {
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });
  try {
    const data = await crmClient.getCopyTradingProviders();
    res.json(data);
  } catch (err) {
    console.error("WebApp copy-trading error:", err.message);
    res.status(500).json({ error: "Failed to fetch providers" });
  }
});

// ========== AI Signals (uses shared signal-service) ==========

app.get("/api/webapp/ai-signals", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const results = await Promise.all(
      AI_SIGNAL_SYMBOLS.map((symbol) => generateSignalForSymbol(crmClient, symbol))
    );
    res.json({ signals: results.filter(Boolean) });
  } catch (err) {
    console.error("AI signals error:", err.message);
    res.status(500).json({ error: "Failed to generate signals" });
  }
});

// ========== Portfolio Advisor ==========

app.get("/api/webapp/portfolio", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const portfolio = await calculatePortfolio(crmClient, session.accessToken);
    res.json(portfolio);
  } catch (err) {
    console.error("Portfolio error:", err.message);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

// ========== Trading Journal ==========

app.get("/api/webapp/journal", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const data = await crmClient.getMemberJournal(session.accessToken, req.query.page, req.query.pageSize);
    res.json(data);
  } catch (err) {
    console.error("Journal fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch journal" });
  }
});

app.post("/api/webapp/journal", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const data = await crmClient.createJournalEntry(session.accessToken, req.body);
    res.json(data);
  } catch (err) {
    console.error("Journal create error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Delete journal entry
app.delete("/api/webapp/journal/:id", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });
  try {
    const data = await crmClient.deleteJournalEntry(session.accessToken, req.params.id);
    res.json(data);
  } catch (err) {
    console.error("Journal delete error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Notifications
app.get("/api/webapp/notifications", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberNotifications(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp notifications error:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

// Support Tickets
app.get("/api/webapp/support", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberSupportTickets(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp support error:", err.message);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

app.post("/api/webapp/support", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  const { subject, description } = req.body;
  if (!subject || !description) return res.status(400).json({ error: "Subject and description required" });
  try {
    const data = await crmClient.createSupportTicket(session.accessToken, subject, description);
    res.json(data);
  } catch (err) {
    console.error("WebApp support create error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Jerry AI Chat (for Mini App)
app.post("/api/webapp/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  // Use telegram user ID or generate one
  const userId = req.telegramUser ? `tg-webapp-${req.telegramUser.id}` : `webapp-${Date.now()}`;
  const userName = req.telegramUser ? (req.telegramUser.first_name || "") : "";

  // Get member context if authenticated
  let memberContext = "";
  if (authService && req.telegramUser) {
    const session = await authService.getSession("telegram", req.telegramUser.id);
    if (session) {
      memberContext = authService.buildMemberContext(session);
    }
  }

  try {
    const reply = await aiEngine.chat("telegram-webapp", userId, message, userName, memberContext, { general: true });
    res.json({ reply });
  } catch (err) {
    console.error("WebApp chat error:", err.message);
    res.status(500).json({ error: "AI error" });
  }
});

// ========== Guardian Status API ==========

app.get("/api/guardian-status/:userId", (req, res) => {
  const userId = req.params.userId;
  // Check across platforms
  const platforms = ["telegram", "line", "web"];
  for (const platform of platforms) {
    const status = guardianService.getStatus(platform, userId);
    if (status.active) {
      return res.json({ platform, userId, ...status });
    }
  }
  res.json({ userId, active: false, activatedAt: null });
});

// ========== Trade Plans API ==========

app.get("/api/trade-plans/:userId", (req, res) => {
  const userId = req.params.userId;
  const platform = req.query.platform || "web";
  const plans = tradePlanService.getPlans(platform, userId);
  res.json({ plans });
});

// ========== Start Bots ==========

console.log("\n\uD83D\uDFE1 Yellow Box Markets — YBX Chatbot v2.0.0\n");

// Start platform bots (each one checks for its own token)
const telegramBot = setupTelegram(aiEngine, commandRouter, authService);
setupDiscord(aiEngine, commandRouter, authService);
const lineClient = setupLINE(app, aiEngine, commandRouter, authService);

// Wire additional dependencies into bots
setupTelegram.setDependencies({ guardianService, tradePlanService });
setupLINE.setDependencies({ guardianService, tradePlanService, crmClient });

// Start margin monitor (requires auth + CRM + bot instances)
startMarginMonitor({
  authService,
  crmClient,
  guardianService,
  telegramBot,
  lineClient,
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`\n\uD83C\uDF10 Web chat: http://localhost:${PORT}`);
  console.log(`\uD83D\uDCE1 API endpoint: http://localhost:${PORT}/api/chat`);
  console.log(`\uD83D\uDC9A Health check: http://localhost:${PORT}/api/health\n`);
});
