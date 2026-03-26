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
const StateRepository = require("./services/state-repository");
const ExecutionAuditService = require("./services/execution-audit-service");
const { createRequestId, log } = require("./services/logger");
const { generateSignal, generateSignalForSymbol, AI_SIGNAL_SYMBOLS } = require("./services/signal-service");
const { normalizeTick } = require("./services/market-data-service");
const { startMarginMonitor } = require("./jobs/margin-monitor");
const { startPositionMonitor, normalizePosition } = require("./jobs/position-monitor");
const setupTelegram = require("./bots/telegram");
const setupDiscord = require("./bots/discord");
const setupLINE = require("./bots/line");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  req.requestId = req.headers["x-request-id"] || createRequestId();
  res.setHeader("X-Request-Id", req.requestId);

  const startedAt = Date.now();
  res.on("finish", () => {
    log("info", "http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  next();
});

// No-cache for webapp HTML to prevent Telegram WebApp caching stale versions
app.use("/webapp", (req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path === "") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

app.use("/lineapp", (req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path === "") {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

app.use(express.static(path.join(__dirname, "../public")));

let aiEngine = null;
let crmClient = null;
let authService = null;
let commandRouter = null;
let guardianService = null;
let tradePlanService = null;
let stateRepository = null;
let executionAuditService = null;
let marginMonitorHandle = null;
let positionMonitorHandle = null;

function toMap(entries) {
  return new Map(entries.map((entry) => [entry.key, entry.value]));
}

async function loadPersistedMaps(repo) {
  if (!repo || !repo.enabled) {
    return {
      sessions: new Map(),
      loginStates: new Map(),
      guardianStates: new Map(),
      plans: new Map(),
      pendingPlans: new Map(),
      orderStates: new Map(),
      txnStates: new Map(),
      positionStates: new Map(),
      conversations: new Map(),
      summaries: new Map(),
      lastTradeSetups: new Map(),
    };
  }

  const [
    sessions,
    loginStates,
    guardianStates,
    plans,
    pendingPlans,
    orderStates,
    txnStates,
    positionStates,
    conversations,
    summaries,
    lastTradeSetups,
  ] = await Promise.all([
    repo.list('auth:sessions'),
    repo.list('auth:login-states'),
    repo.list('guardian:states'),
    repo.list('trade-plans:plans'),
    repo.list('trade-plans:pending'),
    repo.list('trade-plans:order-states'),
    repo.list('trade-plans:txn-states'),
    repo.list('trade-plans:position-states'),
    repo.list('ai:conversations'),
    repo.list('ai:summaries'),
    repo.list('ai:last-trade-setups'),
  ]);

  return {
    sessions: toMap(sessions),
    loginStates: toMap(loginStates),
    guardianStates: toMap(guardianStates),
    plans: toMap(plans),
    pendingPlans: toMap(pendingPlans),
    orderStates: toMap(orderStates),
    txnStates: toMap(txnStates),
    positionStates: toMap(positionStates),
    conversations: toMap(conversations),
    summaries: toMap(summaries),
    lastTradeSetups: toMap(lastTradeSetups),
  };
}

// ========== Web Session Helper ==========

/**
 * Resolve web session from Authorization header (Bearer token).
 * Returns { platform, userId } or null.
 */
async function resolveWebSession(req) {
  if (!authService) return null;
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const identity = authService.validateSessionToken(token);
  if (!identity) return null;

  // Verify the session is still active
  if (!authService.isAuthenticated(identity.platform, identity.userId)) return null;
  return identity;
}

async function buildAIContext(platform, userId, guardianPlatform = platform, guardianUserId = userId) {
  let memberContext = "";
  if (authService) {
    const session = await authService.getSession(platform, userId);
    if (session) {
      memberContext = authService.buildMemberContext(session);
    }
  }

  const guardianMode = guardianService
    ? guardianService.isActive(guardianPlatform, guardianUserId)
    : false;

  return { memberContext, guardianMode };
}

async function resolveAuthenticatedSession(req) {
  const identity = await resolveWebSession(req);
  if (!identity) return null;
  const session = await authService.getSession(identity.platform, identity.userId);
  if (!session) return null;
  return { identity, session };
}

async function getBearerMemberSession(req) {
  const resolved = await resolveAuthenticatedSession(req);
  if (!resolved) {
    return null;
  }

  return resolved;
}

// ========== REST API (for web chat widget) ==========

app.post("/api/chat", async (req, res) => {
  const { message, userName } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  // Resolve identity from signed session token (not client-supplied userId)
  const identity = await resolveWebSession(req);
  if (!identity) {
    return res.status(401).json({ requiresLogin: true, error: "Please login first" });
  }
  const { platform, userId } = identity;

  try {
    const { memberContext, guardianMode } = await buildAIContext(platform, userId);

    // Try command router first
    if (commandRouter && message.trim().startsWith("/")) {
      const result = await commandRouter.execute(message, platform, userId, userName || "");
      if (result) {
        return res.json({ reply: result.text, timestamp: new Date().toISOString() });
      }
    }

    const reply = await aiEngine.chat(platform, userId, message, userName || "", memberContext, { guardianMode });
    res.json({ reply, timestamp: new Date().toISOString() });
  } catch (err) {
    log("error", "api_chat_error", {
      requestId: req.requestId,
      platform,
      userId,
      error: err.message,
    });
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/reset", async (req, res) => {
  const identity = await resolveWebSession(req);
  if (identity) {
    aiEngine.resetConversation(identity.platform, identity.userId);
  }
  res.json({ success: true });
});

// ========== Auth Endpoints ==========

app.post("/api/auth/login", async (req, res) => {
  if (!authService) {
    return res.status(503).json({ error: "Auth not configured" });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password required" });
  }

  // Generate a server-side userId (not client-controlled)
  const userId = `web_${crypto.randomBytes(8).toString('hex')}`;

  try {
    const session = await authService.login("web", userId, email, password);
    const sessionToken = authService.generateSessionToken("web", userId);
    res.json({
      success: true,
      member: session.memberData,
      sessionToken,
    });
  } catch (err) {
    console.error("Web login error:", err.message);
    res.status(401).json({ error: err.message || "Login failed" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const identity = await resolveWebSession(req);
  if (identity) {
    authService.logout(identity.platform, identity.userId);
    aiEngine.resetConversation(identity.platform, identity.userId);
  }
  res.json({ success: true });
});

app.get("/api/auth/session", async (req, res) => {
  if (!authService) {
    return res.json({ authenticated: false });
  }

  const identity = await resolveWebSession(req);
  if (!identity) {
    return res.json({ authenticated: false });
  }

  const session = await authService.getSession(identity.platform, identity.userId);
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
    persistence: !!stateRepository?.enabled,
    repository: stateRepository?.getHealth?.() || { enabled: false, connected: false, lastError: null },
    jobs: {
      marginMonitor: marginMonitorHandle?.status || null,
      positionMonitor: positionMonitorHandle?.status || null,
    },
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
    const symbols = 'XAUUSD,XAGUSD,BTCUSD,ETHUSD,EURUSD,GBPUSD,USDJPY,GBPJPY,EURJPY,AUDUSD,NZDUSD,USDCHF,XTIUSD';
    const [pricesResponse, statsResponse] = await Promise.all([
      crmClient.getPrices(symbols),
      crmClient.getTickStats(symbols),
    ]);

    const livePrices = pricesResponse?.data || pricesResponse || {};
    const rawStats = statsResponse?.data || statsResponse;
    const statsTicks = Array.isArray(rawStats) ? rawStats : (rawStats?.ticks || []);
    const statsBySymbol = new Map(
      statsTicks.map((tick) => [String(tick.symbol || tick.name || '').toUpperCase(), tick])
    );

    const normalized = Object.entries(livePrices).map(([symbol, liveTick]) => {
      const statTick = statsBySymbol.get(String(symbol).toUpperCase()) || {};
      return normalizeTick({
        ...statTick,
        ...liveTick,
        symbol,
        timestamp: liveTick?.timestamp || liveTick?.time || pricesResponse?.timestamp || pricesResponse?.fetchedAt || null,
      }, symbol);
    }).filter(Boolean);
    res.json({
      data: normalized,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("WebApp prices error:", err.message);
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

// Market Analysis — parallel fetch for a symbol
app.get("/api/webapp/analysis/:symbol", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  const symbol = req.params.symbol.toUpperCase();
  try {
    const payload = await crmClient.getMemberMarketAnalysis(
      session.accessToken,
      String(req.query.locale || "th")
    );
    const analyses = unwrapApiData(payload);
    const list = Array.isArray(analyses)
      ? analyses
      : Array.isArray(analyses?.items)
        ? analyses.items
        : [];
    const analysis = list.find((item) => String(item.symbol || "").toUpperCase() === symbol);
    if (!analysis) {
      return res.status(404).json({ error: "Analysis not found for symbol" });
    }
    res.json(analysis);
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
    try {
      const [profilePayload, accountsPayload] = await Promise.all([
        crmClient ? crmClient.getMemberProfile(session.accessToken).catch(() => null) : null,
        crmClient ? crmClient.getMemberAccounts(session.accessToken).catch(() => null) : null,
      ]);
      const member = unwrapApiData(profilePayload) || session.memberData;
      const accountsData = unwrapApiData(accountsPayload);
      const accounts = Array.isArray(accountsData)
        ? accountsData
        : Array.isArray(accountsData?.items)
          ? accountsData.items
          : Array.isArray(accountsData?.accounts)
            ? accountsData.accounts
            : [];
      const totalBalance = accounts.reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);
      return res.json({
        authenticated: true,
        member,
        totalBalance,
        premiumAccess: String(member?.tier || '').toLowerCase().includes('shareholder') || totalBalance >= 100000,
      });
    } catch (err) {
      console.error("WebApp profile error:", err.message);
      return res.json({
        authenticated: true,
        member: session.memberData,
        totalBalance: 0,
        premiumAccess: String(session.memberData?.tier || '').toLowerCase().includes('shareholder'),
      });
    }
  }
  res.json({ authenticated: false });
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
      premiumAccess: (session.memberData.tier || '').toLowerCase().includes('shareholder') || totalBalance >= 100000,
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
  if (userId) {
    authService.logout("telegram", userId);
    aiEngine.resetConversation("telegram", userId);
  }
  res.json({ success: true });
});

// ========== Member Account & Financial Endpoints ==========

// Helper: get member session from Telegram webapp
function getMemberSession(req) {
  if (!authService || !req.telegramUser) return null;
  return authService.getSession("telegram", req.telegramUser.id);
}

function unwrapApiData(payload) {
  if (payload && typeof payload === "object" && "data" in payload && payload.data !== undefined) {
    return payload.data;
  }
  return payload;
}

function toMiniSignalDetailPayload(signal) {
  if (!signal || typeof signal !== "object") return null;

  const symbol = String(signal.symbol || "").toUpperCase();
  if (!symbol) return null;

  const direction = String(signal.direction || signal.side || "").toUpperCase();
  const normalizedDirection = direction === "SELL" ? "Sell" : direction === "BUY" ? "Buy" : "Hold";
  const confidence = Number(signal.confidence || 0);
  const timeframe = signal.timeframe || "H4";
  const entryPrice = Number(signal.entryPrice ?? signal.entry ?? 0);
  const stopLoss = Number(signal.stopLoss ?? signal.sl ?? 0);
  const takeProfit1 = Number(signal.takeProfit1 ?? signal.tp ?? 0);
  const riskRewardRaw = String(signal.riskRewardRatio ?? signal.riskReward ?? "").replace(/^1:/, "");
  const riskRewardRatio = Number(riskRewardRaw || 0);

  return {
    id: signal.id || `${symbol}-${normalizedDirection}-${timeframe}`,
    symbol,
    direction: normalizedDirection,
    confidence,
    entryPrice,
    stopLoss,
    takeProfit1,
    takeProfit2: signal.takeProfit2 != null ? Number(signal.takeProfit2) : null,
    takeProfit3: signal.takeProfit3 != null ? Number(signal.takeProfit3) : null,
    riskRewardRatio,
    timeframe,
    analysis: signal.analysis || "",
    technicalFactors: Array.isArray(signal.technicalFactors) ? signal.technicalFactors : [],
    fundamentalFactors: Array.isArray(signal.fundamentalFactors) ? signal.fundamentalFactors : [],
    validUntil: signal.validUntil || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: signal.status || "Active",
    result: signal.result || null,
    createdAt: signal.createdAt || new Date().toISOString(),
    updatedAt: signal.updatedAt || new Date().toISOString(),
  };
}

function getAccountOpenPositionCount(account) {
  if (!account || typeof account !== "object") return 0;
  const direct = Array.isArray(account.openPositions) ? account.openPositions.length : 0;
  if (direct > 0) return direct;
  const nested = Array.isArray(account.positions) ? account.positions.length : 0;
  if (nested > 0) return nested;
  return Number(account.openPositionsCount || account.positionCount || account.positionsCount || 0);
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

app.get("/api/webapp/positions", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const positionsRes = await crmClient.getMemberPositions(session.accessToken);
    const rawPositions = positionsRes?.data
      ? (Array.isArray(positionsRes.data) ? positionsRes.data : (positionsRes.data.positions || []))
      : (Array.isArray(positionsRes) ? positionsRes : []);
    const positions = rawPositions.map(normalizePosition).filter(Boolean);
    res.json({ positions, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("WebApp positions error:", err.message);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});

app.get("/api/webapp/wallets", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberWallets(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp wallets error:", err.message);
    res.status(500).json({ error: "Failed to fetch wallets" });
  }
});

app.get("/api/webapp/bank-accounts", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberBankAccounts(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp bank accounts error:", err.message);
    res.status(500).json({ error: "Failed to fetch bank accounts" });
  }
});

app.get("/api/webapp/payment-provider", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getActivePaymentProvider(session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("WebApp payment provider error:", err.message);
    res.status(500).json({ error: "Failed to fetch payment provider" });
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
  const payload = req.body || {};
  const amount = Number(payload.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!payload.paymentMethod) return res.status(400).json({ error: "Payment method required" });
  try {
    const data = await crmClient.memberDeposit(session.accessToken, { ...payload, amount });
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
  const payload = req.body || {};
  const amount = Number(payload.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!payload.mt5AccountId) return res.status(400).json({ error: "Trading account required" });
  if (!payload.bankAccountId) return res.status(400).json({ error: "Bank account required" });
  try {
    const providerConfig = await crmClient.getActivePaymentProvider(session.accessToken).catch(() => null);
    const provider = providerConfig?.data?.provider || providerConfig?.provider || 'Overpay';
    const data = await crmClient.memberWithdraw(session.accessToken, { ...payload, amount }, provider);
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
  const payload = req.body || {};
  const amount = Number(payload.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (!payload.transferType) return res.status(400).json({ error: "Transfer type required" });
  try {
    let data;
    if (payload.transferType === 'wallet-to-mt5') {
      if (!payload.walletId || !payload.mt5AccountId) {
        return res.status(400).json({ error: "Wallet and trading account are required" });
      }
      data = await crmClient.memberTransferWalletToMt5(session.accessToken, {
        walletId: payload.walletId,
        mt5AccountId: payload.mt5AccountId,
        amount,
        notes: payload.notes || '',
      });
    } else if (payload.transferType === 'mt5-to-wallet') {
      if (!payload.walletId || !payload.mt5AccountId) {
        return res.status(400).json({ error: "Wallet and trading account are required" });
      }
      data = await crmClient.memberTransferMt5ToWallet(session.accessToken, {
        walletId: payload.walletId,
        mt5AccountId: payload.mt5AccountId,
        amount,
        notes: payload.notes || '',
      });
    } else {
      return res.status(400).json({ error: "Unsupported transfer type" });
    }
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
    const payload = await crmClient.getMemberAiSignals(session.accessToken, {
      status: String(req.query.status || "Active"),
      locale: String(req.query.locale || "th"),
    });
    const signals = unwrapApiData(payload);
    res.json({
      signals: Array.isArray(signals)
        ? signals
        : Array.isArray(signals?.items)
          ? signals.items
          : [],
    });
  } catch (err) {
    console.error("AI signals error:", err.message);
    res.status(500).json({ error: "Failed to fetch AI signals" });
  }
});

// ========== Portfolio Advisor ==========

app.get("/api/webapp/portfolio", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const accountsPayload = await crmClient.getMemberAccounts(session.accessToken);
    const accounts = unwrapApiData(accountsPayload);
    const accountList = Array.isArray(accounts)
      ? accounts
      : Array.isArray(accounts?.items)
        ? accounts.items
        : Array.isArray(accounts?.accounts)
          ? accounts.accounts
          : [];

    if (!accountList.length) {
      return res.json({
        accounts: [],
        selectedAccountId: null,
        riskPanel: null,
        advice: null,
      });
    }

    const requestedId = String(req.query.accountId || "");
    const accountWithPositions = accountList.find((account) => getAccountOpenPositionCount(account) > 0);
    const selectedAccount = accountList.find((account) => String(account.id) === requestedId)
      || accountWithPositions
      || accountList[0];
    const selectedAccountId = String(selectedAccount.id);
    const locale = String(req.query.locale || "th");

    const [riskPanelPayload, advicePayload, positionsPayload] = await Promise.all([
      crmClient.getMemberRiskPanel(session.accessToken, selectedAccountId),
      crmClient.generateMemberPortfolioAdvice(session.accessToken, selectedAccountId, locale),
      crmClient.getAccountPositions(session.accessToken, selectedAccountId).catch(() => null),
    ]);

    const riskPanel = unwrapApiData(riskPanelPayload);
    const advice = unwrapApiData(advicePayload);
    const positionsData = unwrapApiData(positionsPayload);
    const positions = Array.isArray(positionsData)
      ? positionsData
      : Array.isArray(positionsData?.items)
        ? positionsData.items
        : Array.isArray(positionsData?.positions)
          ? positionsData.positions
          : Array.isArray(selectedAccount.openPositions)
            ? selectedAccount.openPositions
            : Array.isArray(selectedAccount.positions)
              ? selectedAccount.positions
              : [];

    res.json({
      accounts: accountList,
      selectedAccountId,
      riskPanel,
      advice,
      totalBalance: Number(riskPanel?.balance || selectedAccount.balance || 0),
      totalEquity: Number(riskPanel?.equity || selectedAccount.equity || selectedAccount.balance || 0),
      freeMargin: Number(riskPanel?.freeMargin || selectedAccount.freeMargin || 0),
      healthScore: Number(advice?.overallScore || 0),
      positions,
      recommendations: Array.isArray(advice?.recommendations)
        ? advice.recommendations.map((rec) => rec.title || rec.description).filter(Boolean)
        : [],
    });
  } catch (err) {
    console.error("Portfolio error:", err.message);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

app.post("/api/webapp/signal-detail", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const signal = toMiniSignalDetailPayload(req.body && req.body.signal);
    if (!signal) {
      return res.status(400).json({ error: "signal required" });
    }

    const detail = await crmClient.generateMemberSignalDetail(
      session.accessToken,
      signal,
      String(req.query.locale || "th")
    );
    res.json(unwrapApiData(detail));
  } catch (err) {
    console.error("Signal detail error:", err.message);
    res.status(500).json({ error: "Failed to fetch signal detail" });
  }
});

// ========== Trading Journal ==========

app.get("/api/webapp/journal", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const data = await crmClient.getMemberJournal(session.accessToken, req.query);
    res.json(data);
  } catch (err) {
    console.error("Journal fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch journal" });
  }
});

app.get("/api/webapp/journal/stats", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const data = await crmClient.getMemberJournalStats(session.accessToken, req.query);
    res.json(data);
  } catch (err) {
    console.error("Journal stats error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.put("/api/webapp/journal/:id/notes", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });
  try {
    const data = await crmClient.updateJournalNotes(session.accessToken, req.params.id, req.body || {});
    res.json(data);
  } catch (err) {
    console.error("Journal update error:", err.message);
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

app.get("/api/webapp/safeguards", async (req, res) => {
  const session = await getMemberSession(req);
  if (!session) return res.status(401).json({ error: "Please login first" });

  try {
    const platform = "telegram";
    const userId = req.telegramUser.id;
    const guardian = guardianService
      ? guardianService.getStatus(platform, userId)
      : { active: false, activatedAt: null };
    const events = executionAuditService
      ? await executionAuditService.list(platform, userId, 20)
      : [];
    const safeguardEvents = events.filter((event) => (
      event.category === "guardian" ||
      event.category === "margin_monitor" ||
      event.category === "position_monitor"
    ));

    res.json({
      guardian,
      events: safeguardEvents,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("WebApp safeguards error:", err.message);
    res.status(500).json({ error: "Failed to fetch safeguards" });
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

// ========== LINE Companion App API (Bearer-auth) ==========

app.get("/api/lineapp/session", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) {
    return res.json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    identity: resolved.identity,
    member: resolved.session.memberData,
  });
});

app.get("/api/lineapp/config", (req, res) => {
  const telegramUrl = process.env.TELEGRAM_BOT_URL
    || (process.env.TELEGRAM_BOT_USERNAME ? `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}` : null);

  res.json({
    telegramUrl,
    telegramUsername: process.env.TELEGRAM_BOT_USERNAME || null,
    lineLiffId: process.env.LINE_LIFF_ID || null,
  });
});

app.post("/api/lineapp/events", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) {
    return res.status(401).json({ error: "Please login first" });
  }

  const { eventName, screen, payload } = req.body || {};
  if (!eventName) {
    return res.status(400).json({ error: "eventName required" });
  }

  const eventPayload = payload && typeof payload === "object" ? payload : {};

  log("info", "lineapp_event", {
    requestId: req.requestId,
    platform: resolved.identity.platform,
    userId: resolved.identity.userId,
    eventName,
    screen: screen || null,
    payload: eventPayload,
  });

  if (stateRepository?.enabled && stateRepository.appendLineAppEvent) {
    try {
      await stateRepository.appendLineAppEvent({
        platform: resolved.identity.platform,
        userId: resolved.identity.userId,
        eventName,
        screen,
        payload: eventPayload,
      });
    } catch (err) {
      log("error", "lineapp_event_persist_error", {
        requestId: req.requestId,
        platform: resolved.identity.platform,
        userId: resolved.identity.userId,
        eventName,
        error: err.message,
      });
    }
  }

  res.json({ success: true });
});

app.get("/api/lineapp/profile", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) {
    return res.status(401).json({ error: "Please login first" });
  }

  const accts = resolved.session.accountData;
  const accounts = Array.isArray(accts) ? accts : (accts?.accounts || (accts ? [accts] : []));
  const totalBalance = accounts.reduce((sum, a) => sum + (parseFloat(a.balance) || 0), 0);

  res.json({
    authenticated: true,
    member: resolved.session.memberData,
    totalBalance,
    premiumAccess: (resolved.session.memberData.tier || "").toLowerCase().includes("shareholder") || totalBalance >= 100000,
  });
});

app.get("/api/lineapp/accounts", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberAccounts(resolved.session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("LineApp accounts error:", err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

app.get("/api/lineapp/transactions/summary", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberTransactionSummary(resolved.session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("LineApp summary error:", err.message);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

app.get("/api/lineapp/notifications", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberNotifications(resolved.session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("LineApp notifications error:", err.message);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.get("/api/lineapp/support", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  try {
    const data = await crmClient.getMemberSupportTickets(resolved.session.accessToken);
    res.json(data);
  } catch (err) {
    console.error("LineApp support error:", err.message);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

app.post("/api/lineapp/support", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });

  const { subject, description } = req.body;
  if (!subject || !description) {
    return res.status(400).json({ error: "Subject and description required" });
  }

  try {
    const data = await crmClient.createSupportTicket(resolved.session.accessToken, subject, description);
    res.json(data);
  } catch (err) {
    console.error("LineApp support create error:", err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/lineapp/ai-signals", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const results = await Promise.all(
      AI_SIGNAL_SYMBOLS.map((symbol) => generateSignalForSymbol(crmClient, symbol))
    );
    res.json({ signals: results.filter(Boolean) });
  } catch (err) {
    console.error("LineApp AI signals error:", err.message);
    res.status(500).json({ error: "Failed to generate signals" });
  }
});

app.get("/api/lineapp/portfolio", async (req, res) => {
  const resolved = await getBearerMemberSession(req);
  if (!resolved) return res.status(401).json({ error: "Please login first" });
  if (!crmClient) return res.status(503).json({ error: "CRM not configured" });

  try {
    const portfolio = await calculatePortfolio(crmClient, resolved.session.accessToken);
    res.json(portfolio);
  } catch (err) {
    console.error("LineApp portfolio error:", err.message);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});

app.post("/api/lineapp/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  const resolved = await getBearerMemberSession(req);
  if (!resolved) {
    return res.status(401).json({ error: "Please login first" });
  }

  const { identity, session } = resolved;
  const { memberContext, guardianMode } = await buildAIContext(identity.platform, identity.userId);

  try {
    const reply = await aiEngine.chat(
      identity.platform,
      identity.userId,
      message,
      session.memberData?.name || "",
      memberContext,
      { guardianMode }
    );
    res.json({ reply });
  } catch (err) {
    log("error", "lineapp_chat_error", {
      requestId: req.requestId,
      platform: identity.platform,
      userId: identity.userId,
      error: err.message,
    });
    res.status(500).json({ error: "AI error" });
  }
});

// Jerry AI Chat (for Mini App)
app.post("/api/webapp/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  // Reuse the Telegram identity when available so chat memory and policies stay consistent.
  const chatPlatform = req.telegramUser ? "telegram" : "telegram-webapp";
  const userId = req.telegramUser ? req.telegramUser.id : `webapp-${Date.now()}`;
  const userName = req.telegramUser ? (req.telegramUser.first_name || "") : "";

  const context = req.telegramUser
    ? await buildAIContext("telegram", req.telegramUser.id)
    : { memberContext: "", guardianMode: false };
  const general = !req.telegramUser;

  try {
    const reply = await aiEngine.chat(chatPlatform, userId, message, userName, context.memberContext, {
      general,
      guardianMode: context.guardianMode,
    });
    res.json({ reply });
  } catch (err) {
    log("error", "webapp_chat_error", {
      requestId: req.requestId,
      chatPlatform,
      userId,
      error: err.message,
    });
    res.status(500).json({ error: "AI error" });
  }
});

// ========== Guardian Status API (auth-protected) ==========

app.get("/api/guardian-status", async (req, res) => {
  if (!authService) return res.status(503).json({ error: "Auth not configured" });

  const session = await resolveWebSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { platform, userId } = session;
  const status = guardianService.getStatus(platform, userId);
  res.json({ platform, userId, ...status });
});

// ========== Trade Plans API (auth-protected) ==========

app.get("/api/trade-plans", async (req, res) => {
  if (!authService) return res.status(503).json({ error: "Auth not configured" });

  const session = await resolveWebSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { platform, userId } = session;
  const plans = tradePlanService.getPlans(platform, userId);
  res.json({ plans });
});

app.get("/api/execution-events", async (req, res) => {
  if (!authService) return res.status(503).json({ error: "Auth not configured" });

  const session = await resolveWebSession(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const events = await executionAuditService.list(session.platform, session.userId, 100);
  res.json({ events });
});

app.get("/api/positions", async (req, res) => {
  if (!authService || !crmClient) return res.status(503).json({ error: "Trading not configured" });

  const auth = await resolveAuthenticatedSession(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  try {
    const positionsRes = await crmClient.getMemberPositions(auth.session.accessToken);
    const rawPositions = positionsRes?.data
      ? (Array.isArray(positionsRes.data) ? positionsRes.data : (positionsRes.data.positions || []))
      : (Array.isArray(positionsRes) ? positionsRes : []);
    const positions = rawPositions.map(normalizePosition).filter(Boolean);
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch positions" });
  }
});

app.post("/api/positions/:ticket/close", async (req, res) => {
  if (!authService || !crmClient) return res.status(503).json({ error: "Trading not configured" });

  const auth = await resolveAuthenticatedSession(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  const { accountId, volume } = req.body || {};
  if (!accountId || !volume || Number(volume) <= 0) {
    return res.status(400).json({ error: "accountId and positive volume required" });
  }

  try {
    const result = await crmClient.closePosition(auth.session.accessToken, accountId, req.params.ticket, Number(volume));
    await executionAuditService.record({
      platform: auth.identity.platform,
      userId: auth.identity.userId,
      category: "position",
      action: "web_close_position",
      status: "success",
      correlationId: req.params.ticket,
      payload: { accountId, volume: Number(volume) },
    });
    res.json(result);
  } catch (err) {
    await executionAuditService.record({
      platform: auth.identity.platform,
      userId: auth.identity.userId,
      category: "position",
      action: "web_close_position",
      status: "error",
      correlationId: req.params.ticket,
      payload: { accountId, volume: Number(volume), error: err.message },
    });
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/positions/:ticket/modify", async (req, res) => {
  if (!authService || !crmClient) return res.status(503).json({ error: "Trading not configured" });

  const auth = await resolveAuthenticatedSession(req);
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  const { accountId, stopLoss, takeProfit } = req.body || {};
  if (!accountId || (stopLoss == null && takeProfit == null)) {
    return res.status(400).json({ error: "accountId and stopLoss or takeProfit required" });
  }

  try {
    const result = await crmClient.modifyPosition(auth.session.accessToken, accountId, req.params.ticket, {
      stopLoss,
      takeProfit,
    });
    await executionAuditService.record({
      platform: auth.identity.platform,
      userId: auth.identity.userId,
      category: "position",
      action: "web_modify_position",
      status: "success",
      correlationId: req.params.ticket,
      payload: { accountId, stopLoss, takeProfit },
    });
    res.json(result);
  } catch (err) {
    await executionAuditService.record({
      platform: auth.identity.platform,
      userId: auth.identity.userId,
      category: "position",
      action: "web_modify_position",
      status: "error",
      correlationId: req.params.ticket,
      payload: { accountId, stopLoss, takeProfit, error: err.message },
    });
    res.status(err.status || 500).json({ error: err.message });
  }
});

async function bootstrap() {
  stateRepository = new StateRepository();
  await stateRepository.init();
  const persisted = await loadPersistedMaps(stateRepository);

  aiEngine = new YBXAIEngine({
    repo: stateRepository.enabled ? stateRepository : null,
    conversations: persisted.conversations,
    summaries: persisted.summaries,
    lastTradeSetups: persisted.lastTradeSetups,
  });

  crmClient =
    process.env.CRM_API_URL && process.env.CRM_BOT_EMAIL && process.env.CRM_BOT_PASSWORD
      ? new CRMClient({
          baseUrl: process.env.CRM_API_URL,
          email: process.env.CRM_BOT_EMAIL,
          password: process.env.CRM_BOT_PASSWORD,
        })
      : null;

  authService = crmClient
    ? new AuthService(crmClient, {
        repo: stateRepository.enabled ? stateRepository : null,
        sessions: persisted.sessions,
        loginStates: persisted.loginStates,
      })
    : null;

  commandRouter = crmClient
    ? new CommandRouter(crmClient, aiEngine, authService)
    : null;

  guardianService = new GuardianService({
    repo: stateRepository.enabled ? stateRepository : null,
    states: persisted.guardianStates,
  });

  tradePlanService = new TradePlanService({
    repo: stateRepository.enabled ? stateRepository : null,
    plans: persisted.plans,
    pending: persisted.pendingPlans,
    orderStates: persisted.orderStates,
    txnStates: persisted.txnStates,
    positionStates: persisted.positionStates,
  });
  executionAuditService = new ExecutionAuditService({
    repo: stateRepository.enabled ? stateRepository : null,
  });

  if (authService && !process.env.SESSION_TOKEN_SECRET) {
    console.warn("⚠️ SESSION_TOKEN_SECRET is not set. Web sessions will be invalid after restart and will not work across replicas.");
  }
  if (stateRepository.enabled) {
    console.log("✅ Persistent state enabled via DATABASE_URL");
  } else {
    console.log("⏭️ Persistent state disabled; using in-memory fallback");
  }

  console.log("\n\uD83D\uDFE1 Yellow Box Markets — YBX Chatbot v2.0.0\n");

  const telegramBot = setupTelegram(aiEngine, commandRouter, authService);
  setupDiscord(aiEngine, commandRouter, authService);
  const lineClient = setupLINE(app, aiEngine, commandRouter, authService);

  commandRouter?.setGuardianService(guardianService);
  setupTelegram.setDependencies({ guardianService, tradePlanService, crmClient, authService, executionAuditService });
  setupLINE.setDependencies({ guardianService, tradePlanService, crmClient });

  marginMonitorHandle = startMarginMonitor({
    authService,
    crmClient,
    guardianService,
    telegramBot,
    lineClient,
    auditService: executionAuditService,
  });

  positionMonitorHandle = startPositionMonitor({
    authService,
    crmClient,
    tradePlanService,
    telegramBot,
    lineClient,
    auditService: executionAuditService,
    stateRepository,
  });

  app.listen(PORT, () => {
    console.log(`\n\uD83C\uDF10 Web chat: http://localhost:${PORT}`);
    console.log(`\uD83D\uDCE1 API endpoint: http://localhost:${PORT}/api/chat`);
    console.log(`\uD83D\uDC9A Health check: http://localhost:${PORT}/api/health\n`);
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error("Failed to bootstrap Jerry AI:", err);
    process.exit(1);
  });
}

module.exports = { app, bootstrap };
