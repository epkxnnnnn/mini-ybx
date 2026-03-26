/**
 * LINE Bot — Yellow Box Markets
 * Full parity with Telegram: login flow, auth gate, portfolio, trade confirm
 */
const line = require("@line/bot-sdk");
const { calculatePortfolio } = require("../services/portfolio-service");

// Injected dependencies (set via setDependencies)
let guardianService = null;
let tradePlanService = null;
let crmClient = null;
let webhookServiceRef = null;

function getTelegramHandoffUrl() {
  if (process.env.TELEGRAM_BOT_URL) return process.env.TELEGRAM_BOT_URL;
  if (process.env.TELEGRAM_BOT_USERNAME) return `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}`;
  return null;
}

function buildTelegramHandoffText(reason = "advanced_execution") {
  const url = getTelegramHandoffUrl();
  const reasonText = reason === "positions"
    ? "การจัดการสถานะเปิด เช่น ปิดบางส่วน, ปิดทั้งหมด, หรือเลื่อน Stop Loss"
    : "การส่งคำสั่งและจัดการความเสี่ยงขั้นสูง";

  return (
    `📲 ฟีเจอร์นี้ทำได้ดีที่สุดบน Telegram\n\n` +
    `Jerry บน Telegram รองรับ ${reasonText}\n` +
    `รวมถึง lot guidance, preflight check, และ position protection\n` +
    (url ? `\nเปิดใช้งานต่อที่นี่:\n${url}` : `\nตั้งค่า TELEGRAM_BOT_USERNAME หรือ TELEGRAM_BOT_URL เพื่อแสดงลิงก์ต่อไปยัง Telegram`)
  );
}

function buildLineTradeSetupHandoff(planId, reply) {
  const url = getTelegramHandoffUrl();
  const text = url
    ? `${reply}\n\n📲 ต้องการส่งคำสั่งหรือจัดการสถานะต่อ? ใช้ Telegram:\n${url}`
    : reply;

  return {
    type: "text",
    text,
    quickReply: {
      items: [
        {
          type: "action",
          action: { type: "message", label: "\u2705 บันทึกแผน", text: `บันทึกแผน:${planId}` },
        },
        {
          type: "action",
          action: { type: "message", label: "📲 ไป Telegram", text: "ไป telegram" },
        },
        {
          type: "action",
          action: { type: "message", label: "\u274C ยกเลิก", text: `ยกเลิกแผน:${planId}` },
        },
      ],
    },
  };
}

function setupLINE(app, aiEngine, commandRouter, authService) {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelAccessToken || !channelSecret) {
    console.log("\u23ED\uFE0F  LINE: No credentials, skipping");
    return null;
  }

  const config = { channelAccessToken, channelSecret };
  const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken,
  });

  // LINE webhook endpoint
  app.post("/webhook/line", line.middleware(config), async (req, res) => {
    res.status(200).end(); // Always respond 200 to LINE

    const events = req.body.events || [];

    for (const event of events) {
      try {
        await handleEvent(event, client, aiEngine, commandRouter, authService);
      } catch (err) {
        console.error("LINE event error:", err.message);
      }
    }
  });

  console.log("\u2705 LINE bot webhook registered at /webhook/line");
  return client;
}

/**
 * Set additional dependencies after initialization
 */
setupLINE.setDependencies = function (deps) {
  if (deps.guardianService) guardianService = deps.guardianService;
  if (deps.tradePlanService) tradePlanService = deps.tradePlanService;
  if (deps.crmClient) crmClient = deps.crmClient;
  if (deps.webhookService) webhookServiceRef = deps.webhookService;
};
setupLINE.getTelegramHandoffUrl = getTelegramHandoffUrl;
setupLINE.buildTelegramHandoffText = buildTelegramHandoffText;
setupLINE.buildLineTradeSetupHandoff = buildLineTradeSetupHandoff;

// Thai keyword → command mapping
const THAI_COMMANDS = {
  ราคา: "/price xauusd",
  ราคาทอง: "/price xauusd",
  ข่าว: "/news",
  ข่าวเศรษฐกิจ: "/news",
  แนวรับแนวต้าน: "/levels xauusd",
  อัตราแลกเปลี่ยน: "/rate",
  เช็คลิสต์: "/checklist",
  เริ่มใหม่: "/reset",
  เริ่มต้น: "/start",
};

// Public commands that don't require authentication
const PUBLIC_COMMANDS = ["เริ่มต้น", "/start", "เช็คลิสต์", "/checklist", "/zones", "เข้าสู่ระบบ", "/login", "ออกจากระบบ", "/logout", "/cancel"];

async function handleEvent(event, client, aiEngine, commandRouter, authService) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const userId = event.source.userId;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // ========== Trade Plan Actions ==========
  if (tradePlanService) {
    if (text.startsWith("บันทึกแผน:")) {
      const planId = text.slice("บันทึกแผน:".length).trim();
      const plan = tradePlanService.savePlan(planId);
      if (plan) {
        return replyLine(client, replyToken, `\u2705 บันทึกแผนเทรดแล้ว\n${plan.symbol} ${plan.direction}\nEntry: $${plan.entry} | SL: $${plan.sl} | TP: $${plan.tp}`);
      }
      return replyLine(client, replyToken, "\u274C ไม่พบแผนเทรดนี้ (อาจหมดอายุ)");
    }
    if (text.startsWith("ยกเลิกแผน:")) {
      const planId = text.slice("ยกเลิกแผน:".length).trim();
      const plan = tradePlanService.cancelPlan(planId);
      if (plan) {
        return replyLine(client, replyToken, "\u274C ยกเลิกแผนเทรดแล้ว");
      }
      return replyLine(client, replyToken, "\u274C ไม่พบแผนเทรดนี้ (อาจหมดอายุ)");
    }
  }

  // ========== Login Flow State Machine ==========
  if (authService) {
    const loginState = authService.getLoginState("line", userId);

    // Cancel login flow
    if ((text === "/cancel" || text === "ยกเลิก") && loginState) {
      authService.clearLoginState("line", userId);
      return replyLine(client, replyToken, "\u274C ยกเลิกการเข้าสู่ระบบแล้ว");
    }

    // Step: waiting for email
    if (loginState && loginState.step === "email") {
      const email = text.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return replyLine(client, replyToken, "\u26A0\uFE0F กรุณาส่งอีเมลที่ถูกต้อง หรือพิมพ์ \"ยกเลิก\" เพื่อยกเลิก");
      }
      authService.setLoginState("line", userId, { step: "password", email });
      return replyLine(client, replyToken,
        `\uD83D\uDCE7 อีเมล: ${email}\n\n` +
        `\u26A0\uFE0F ข้อควรระวัง: รหัสผ่านที่ส่งในแชทจะมองเห็นได้ในประวัติสนทนา หากมีตัวเลือก Web Login แนะนำให้ใช้ช่องทางนั้นแทน\n\n` +
        `\uD83D\uDD11 กรุณาส่งรหัสผ่านของคุณ`
      );
    }

    // Step: waiting for password
    if (loginState && loginState.step === "password") {
      const password = text.trim();
      const email = loginState.email;

      try {
        const session = await authService.login("line", userId, email, password);
        const m = session.memberData;

        let welcomeText = `\u2705 เข้าสู่ระบบสำเร็จ!\n\n` +
          `\uD83D\uDC64 สวัสดีครับ ${m.name}\n` +
          `\uD83C\uDFC6 Tier: ${m.tier}\n` +
          `\uD83D\uDCE7 ${m.email}\n`;

        const accts = session.accountData;
        const arr = Array.isArray(accts) ? accts : (accts?.accounts || []);
        if (arr.length > 0) {
          welcomeText += `\n\uD83D\uDCBC บัญชีเทรด:\n`;
          for (const a of arr) {
            const login = a.login || a.accountId || a.id || 'N/A';
            const balance = a.balance != null ? `$${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
            welcomeText += `  Account ${login}: ${balance}\n`;
          }
        }

        welcomeText += `\nพร้อมช่วยเหลือแล้วครับ! \uD83D\uDCAC\nพิมพ์ "พอร์ต" เพื่อดูสถานะพอร์ต`;
        return replyLine(client, replyToken, welcomeText);
      } catch (err) {
        authService.clearLoginState("line", userId);
        return replyLine(client, replyToken, `\u274C เข้าสู่ระบบไม่สำเร็จ: ${err.message}\n\nพิมพ์ "เข้าสู่ระบบ" เพื่อลองใหม่`);
      }
    }

    // Login command
    if (text === "เข้าสู่ระบบ" || text === "/login") {
      if (authService.isAuthenticated("line", userId)) {
        return replyLine(client, replyToken, "\u2705 คุณเข้าสู่ระบบอยู่แล้ว\nพิมพ์ \"ออกจากระบบ\" เพื่อออกจากระบบ");
      }
      authService.setLoginState("line", userId, { step: "email" });
      return replyLine(client, replyToken,
        "\uD83D\uDD10 เข้าสู่ระบบ YBX Member\n\n" +
        "กรุณาส่งอีเมลที่ลงทะเบียนกับ Yellow Box Markets\n" +
        "(พิมพ์ \"ยกเลิก\" เพื่อยกเลิก)"
      );
    }

    // Logout command
    if (text === "ออกจากระบบ" || text === "/logout") {
      authService.logout("line", userId);
      aiEngine.resetConversation("line", userId);
      return replyLine(client, replyToken, "\uD83D\uDC4B ออกจากระบบเรียบร้อยแล้ว\nพิมพ์ \"เข้าสู่ระบบ\" เพื่อเข้าสู่ระบบอีกครั้ง");
    }

    // Auth gate — block unauthenticated users (except public commands)
    const isPublic = PUBLIC_COMMANDS.some(cmd => text === cmd || text.startsWith(cmd + " "));
    if (!isPublic && !authService.isAuthenticated("line", userId)) {
      return replyLine(client, replyToken,
        "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อนใช้งาน\n" +
        "พิมพ์ \"เข้าสู่ระบบ\" เพื่อเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน YBX ของคุณ"
      );
    }
  }

  // ========== /language command ==========
  if (text === "/language" || text.startsWith("/language ")) {
    const arg = text.slice("/language".length).trim().toLowerCase();
    if (!arg) {
      const current = aiEngine.getLanguage("line", userId);
      const label = current === "en" ? "English" : current === "zh" ? "\u4E2D\u6587" : "\u0E44\u0E17\u0E22";
      return replyLine(client, replyToken,
        `\uD83C\uDF10 Language: ${label}\n\n` +
        `/language th \u2014 \u0E44\u0E17\u0E22\n` +
        `/language en \u2014 English\n` +
        `/language zh \u2014 \u4E2D\u6587`
      );
    }
    const langMap = { th: "th", thai: "th", en: "en", english: "en", zh: "zh", chinese: "zh", cn: "zh" };
    const lang = langMap[arg];
    if (!lang) {
      return replyLine(client, replyToken, "\u274C Unknown language. Use: /language th, /language en, /language zh");
    }
    aiEngine.setLanguage("line", userId, lang);
    const labels = { th: "\uD83C\uDDF9\uD83C\uDDED \u0E44\u0E17\u0E22", en: "\uD83C\uDDEC\uD83C\uDDE7 English", zh: "\uD83C\uDDE8\uD83C\uDDF3 \u4E2D\u6587" };
    return replyLine(client, replyToken, `\u2705 Language: ${labels[lang]}`);
  }

  // ========== /webhook command — TradingView webhook management ==========
  if (text === "/webhook" || text === "/webhook reset" || text === "/webhook off") {
    if (!webhookServiceRef) {
      return replyLine(client, replyToken, "\u274C Webhook service not available");
    }

    const baseUrl = process.env.WEBHOOK_BASE_URL || '';

    if (text === "/webhook off") {
      const revoked = webhookServiceRef.revokeToken("line", userId);
      if (revoked) {
        return replyLine(client, replyToken, "\u274C Webhook revoked\nURL \u0E40\u0E14\u0E34\u0E21\u0E44\u0E21\u0E48\u0E2A\u0E32\u0E21\u0E32\u0E23\u0E16\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E44\u0E14\u0E49\u0E2D\u0E35\u0E01\n\u0E1E\u0E34\u0E21\u0E1E\u0E4C /webhook \u0E40\u0E1E\u0E37\u0E48\u0E2D\u0E2A\u0E23\u0E49\u0E32\u0E07 URL \u0E43\u0E2B\u0E21\u0E48");
      }
      return replyLine(client, replyToken, "\u274C \u0E44\u0E21\u0E48\u0E1E\u0E1A Webhook \u0E17\u0E35\u0E48\u0E40\u0E1B\u0E34\u0E14\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19\u0E2D\u0E22\u0E39\u0E48");
    }

    if (text === "/webhook reset") {
      const token = webhookServiceRef.regenerateToken("line", userId);
      const url = baseUrl ? `${baseUrl}/webhook/signal/${token}` : `/webhook/signal/${token}`;
      return replyLine(client, replyToken,
        `\uD83D\uDD04 Webhook URL \u0E43\u0E2B\u0E21\u0E48:\n${url}\n\n\u26A0\uFE0F URL \u0E40\u0E14\u0E34\u0E21\u0E16\u0E39\u0E01\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01\u0E41\u0E25\u0E49\u0E27 \u0E01\u0E23\u0E38\u0E13\u0E32\u0E2D\u0E31\u0E1E\u0E40\u0E14\u0E17\u0E43\u0E19 TradingView`
      );
    }

    // /webhook — show or generate
    const existing = webhookServiceRef.getTokenInfo("line", userId);
    if (existing) {
      const url = baseUrl ? `${baseUrl}/webhook/signal/${existing.token}` : `/webhook/signal/${existing.token}`;
      return replyLine(client, replyToken,
        `\uD83D\uDCE1 TradingView Webhook\n\nURL:\n${url}\n\nSignals: ${existing.signalCount}\n\n` +
        `/webhook reset \u2014 \u0E2A\u0E23\u0E49\u0E32\u0E07 URL \u0E43\u0E2B\u0E21\u0E48\n` +
        `/webhook off \u2014 \u0E1B\u0E34\u0E14 Webhook`
      );
    }

    const token = webhookServiceRef.generateToken("line", userId);
    const url = baseUrl ? `${baseUrl}/webhook/signal/${token}` : `/webhook/signal/${token}`;
    return replyLine(client, replyToken,
      `\uD83D\uDCE1 TradingView Webhook \u0E1E\u0E23\u0E49\u0E2D\u0E21\u0E43\u0E0A\u0E49\u0E07\u0E32\u0E19!\n\nURL:\n${url}\n\n` +
      `\u0E27\u0E34\u0E18\u0E35\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32:\n` +
      `1. \u0E40\u0E1B\u0E34\u0E14 Alert \u0E43\u0E19 TradingView\n` +
      `2. \u0E40\u0E25\u0E37\u0E2D\u0E01 Webhook URL\n` +
      `3. \u0E27\u0E32\u0E07 URL \u0E14\u0E49\u0E32\u0E19\u0E1A\u0E19\n` +
      `4. \u0E15\u0E31\u0E49\u0E07 Message: {"ticker":"XAUUSD","action":"buy","price":{{close}}}\n\n` +
      `/webhook reset \u2014 \u0E2A\u0E23\u0E49\u0E32\u0E07 URL \u0E43\u0E2B\u0E21\u0E48\n` +
      `/webhook off \u2014 \u0E1B\u0E34\u0E14 Webhook`
    );
  }

  // ========== Portfolio Commands ==========
  if ((text === "พอร์ต" || text === "portfolio" || text === "สถานะ") && authService && crmClient) {
    const session = await authService.getSession("line", userId);
    if (!session) {
      return replyLine(client, replyToken, "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อน");
    }

    try {
      const portfolio = await calculatePortfolio(crmClient, session.accessToken);
      const flexMessage = buildPortfolioFlexMessage(portfolio);
      await client.replyMessage({ replyToken, messages: [flexMessage] });
      return;
    } catch (err) {
      console.error("LINE portfolio error:", err.message);
      return replyLine(client, replyToken, "\u274C ไม่สามารถดึงข้อมูลพอร์ตได้ กรุณาลองใหม่");
    }
  }

  // ========== Execution Handoff Commands ==========
  if (
    text === "positions" || text === "/positions" || text === "จัดการสถานะ" ||
    text === "เปิดออเดอร์" || text === "ส่งคำสั่ง" || text === "execute" ||
    text === "ไป telegram" || text === "telegram"
  ) {
    const reason = (text === "positions" || text === "/positions" || text === "จัดการสถานะ")
      ? "positions"
      : "advanced_execution";
    return replyLine(client, replyToken, buildTelegramHandoffText(reason));
  }

  // ========== Thai Keyword Commands ==========
  let commandText = null;
  const lowerText = text.toLowerCase();

  if (THAI_COMMANDS[text]) {
    commandText = THAI_COMMANDS[text];
  } else if (text.startsWith("/")) {
    commandText = text;
  } else if (lowerText.startsWith("ราคา ")) {
    commandText = `/price ${text.slice(5).trim()}`;
  } else if (lowerText.startsWith("วิเคราะห์ ") || lowerText.startsWith("วิเคราะห์")) {
    const sym = text.replace(/^วิเคราะห์\s*/, "").trim();
    commandText = sym ? `/analyze ${sym}` : "/analyze xauusd";
  } else if (lowerText.startsWith("แนวรับแนวต้าน ")) {
    commandText = `/levels ${text.slice(14).trim()}`;
  }

  // Route through command router
  if (commandText && commandRouter) {
    const result = await commandRouter.execute(commandText, "line", userId, "");
    if (result) {
      return replyLine(client, replyToken, result.text);
    }
  }

  // Legacy fallback for basic commands (no CRM)
  if (text === "/start" || text === "เริ่มต้น") {
    return replyLine(client, replyToken,
      "สวัสดีครับ! \uD83D\uDC4B\n\n" +
      "ผมคือ Jerry — AI Trading Analyst ของ Yellow Box Markets\n\n" +
      "\uD83D\uDD39 วิเคราะห์ตลาดด้วย TA, FA, Sentiment\n" +
      "\uD83D\uDD39 ดูราคาสด, ข่าว, แนวรับแนวต้าน\n" +
      "\uD83D\uDD39 สอนกลยุทธ์การเทรด\n\n" +
      "คำสั่ง:\n" +
      "\"เข้าสู่ระบบ\" — เข้าสู่ระบบ\n" +
      "\"พอร์ต\" — ดูสถานะพอร์ต\n" +
      "\"ราคา\" — ดูราคาสด\n" +
      "\"วิเคราะห์\" — วิเคราะห์ตลาด\n" +
      "\"ข่าว\" — ข่าวเศรษฐกิจวันนี้\n" +
      "\"เช็คลิสต์\" — Pre-trade Checklist\n\n" +
      "หรือส่งข้อความได้เลยครับ! \uD83D\uDCAC"
    );
  }

  if (text === "/checklist" || text === "เช็คลิสต์") {
    return replyLine(client, replyToken,
      "\uD83D\uDCCB Pre-trade Checklist 5 ขั้นตอน\n\n" +
      "1\uFE0F\u20E3 TREND — HTF ทิศทางหลัก (Bullish/Bearish/Range?)\n" +
      "2\uFE0F\u20E3 LEVELS — แนวรับ/แนวต้านสำคัญ + Fibonacci\n" +
      "3\uFE0F\u20E3 CONFIRM — รอ confirmation (Candlestick pattern, Indicator signal)\n" +
      "4\uFE0F\u20E3 ENTRY — จุดเข้าเทรด Entry, SL, TP + คำนวณ R:R\n" +
      "5\uFE0F\u20E3 SIZE — คำนวณ Lot Size ตาม risk 1-2%"
    );
  }

  if (text === "/reset" || text === "เริ่มใหม่") {
    aiEngine.resetConversation("line", userId);
    return replyLine(client, replyToken, "\uD83D\uDD04 เริ่มบทสนทนาใหม่แล้วครับ");
  }

  // Unknown slash command — ignore
  if (text.startsWith("/")) return;

  // ========== Free text → AI chat ==========
  try {
    // Build member context if authenticated
    let memberContext = "";
    if (authService) {
      const session = await authService.getSession("line", userId);
      if (session) {
        memberContext = authService.buildMemberContext(session);
      }
    }

    // Check guardian mode
    const isGuardian = guardianService ? guardianService.isActive("line", userId) : false;

    const reply = await aiEngine.chat("line", userId, text, "", memberContext, { guardianMode: isGuardian });

    // Detect trade setup in AI response and add confirmation buttons
    if (tradePlanService) {
      const setup = tradePlanService.resolveTradeSetup(
        reply,
        aiEngine.getLastTradeSetup("line", userId)
      );
      if (setup) {
        const plan = tradePlanService.createPending("line", userId, setup);
        const quickReplyMsg = buildLineTradeSetupHandoff(plan.id, reply);
        // Chunk if needed, but quick reply only on last message
        if (reply.length > 4500) {
          const chunks = reply.match(/.{1,4500}/gs);
          const messages = chunks.slice(0, 4).map(c => ({ type: "text", text: c }));
          messages.push({
            type: "text",
            text: chunks.length > 4 ? chunks.slice(4).join('') : "\uD83D\uDCCA Trade Setup detected — บันทึกแผนหรือยกเลิก?",
            quickReply: quickReplyMsg.quickReply,
          });
          await client.replyMessage({ replyToken, messages: messages.slice(0, 5) });
        } else {
          await client.replyMessage({ replyToken, messages: [quickReplyMsg] });
        }
        return;
      }
    }

    await replyLine(client, replyToken, reply);
  } catch (err) {
    console.error("LINE reply error:", err.message);
    await replyLine(client, replyToken, "\u274C เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
  }
}

/**
 * Build LINE Flex Message for portfolio display
 * Dark theme with gold accents (#DCAA2E on #1a1a2e)
 */
function buildPortfolioFlexMessage(portfolio) {
  const fmt = (n) => n != null ? Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'N/A';

  const marginText = portfolio.marginLevel != null ? `${portfolio.marginLevel}%` : 'N/A';
  const healthPct = portfolio.healthScore;
  const healthColor = healthPct >= 70 ? '#27AE60' : healthPct >= 40 ? '#F39C12' : '#E74C3C';

  // Positions list (max 5)
  const positionBoxes = (portfolio.positions || []).slice(0, 5).map(p => ({
    type: "box",
    layout: "horizontal",
    contents: [
      { type: "text", text: `${p.symbol}`, size: "xs", color: "#DCAA2E", flex: 3 },
      { type: "text", text: p.direction, size: "xs", color: p.direction === 'BUY' ? '#27AE60' : '#E74C3C', flex: 2, align: "center" },
      { type: "text", text: `$${fmt(p.pnl)}`, size: "xs", color: p.pnl >= 0 ? '#27AE60' : '#E74C3C', flex: 3, align: "end" },
    ],
  }));

  // Recommendations (max 3)
  const recoBoxes = (portfolio.recommendations || []).slice(0, 3).map(r => ({
    type: "text",
    text: `\u2022 ${r}`,
    size: "xs",
    color: "#AAAAAA",
    wrap: true,
  }));

  return {
    type: "flex",
    altText: `Portfolio: Balance $${fmt(portfolio.totalBalance)} | Health ${healthPct}%`,
    contents: {
      type: "bubble",
      styles: {
        body: { backgroundColor: "#1a1a2e" },
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          // Header
          {
            type: "text",
            text: "\uD83D\uDCCA Portfolio Advisor",
            weight: "bold",
            size: "lg",
            color: "#DCAA2E",
          },
          { type: "separator", color: "#333333" },
          // Balance section
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "Balance", size: "sm", color: "#AAAAAA", flex: 4 },
                  { type: "text", text: `$${fmt(portfolio.totalBalance)}`, size: "sm", color: "#FFFFFF", flex: 5, align: "end" },
                ],
              },
              {
                type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "Equity", size: "sm", color: "#AAAAAA", flex: 4 },
                  { type: "text", text: `$${fmt(portfolio.totalEquity)}`, size: "sm", color: "#FFFFFF", flex: 5, align: "end" },
                ],
              },
              {
                type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "Margin Level", size: "sm", color: "#AAAAAA", flex: 4 },
                  { type: "text", text: marginText, size: "sm", color: "#DCAA2E", flex: 5, align: "end", weight: "bold" },
                ],
              },
            ],
          },
          { type: "separator", color: "#333333" },
          // Health Score
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "box", layout: "horizontal", contents: [
                  { type: "text", text: "Health Score", size: "sm", color: "#AAAAAA", flex: 4 },
                  { type: "text", text: `${healthPct}/100`, size: "sm", color: healthColor, flex: 5, align: "end", weight: "bold" },
                ],
              },
              // Health bar
              {
                type: "box",
                layout: "horizontal",
                contents: [
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [{ type: "filler" }],
                    width: `${healthPct}%`,
                    height: "6px",
                    backgroundColor: healthColor,
                    cornerRadius: "3px",
                  },
                  {
                    type: "box",
                    layout: "vertical",
                    contents: [{ type: "filler" }],
                    width: `${100 - healthPct}%`,
                    height: "6px",
                    backgroundColor: "#333333",
                    cornerRadius: "3px",
                  },
                ],
              },
            ],
          },
          // Positions
          ...(positionBoxes.length > 0 ? [
            { type: "separator", color: "#333333" },
            { type: "text", text: "Positions", size: "sm", color: "#DCAA2E", weight: "bold" },
            ...positionBoxes,
          ] : []),
          // Recommendations
          ...(recoBoxes.length > 0 ? [
            { type: "separator", color: "#333333" },
            { type: "text", text: "Recommendations", size: "xs", color: "#DCAA2E", weight: "bold" },
            ...recoBoxes,
          ] : []),
        ],
      },
    },
  };
}

/**
 * Reply on LINE with chunking (max 5 messages × 4500 chars)
 */
async function replyLine(client, replyToken, text) {
  const messages = [];
  if (text.length > 4500) {
    const chunks = text.match(/.{1,4500}/gs);
    for (const chunk of chunks.slice(0, 5)) {
      messages.push({ type: "text", text: chunk });
    }
  } else {
    messages.push({ type: "text", text });
  }

  await client.replyMessage({ replyToken, messages });
}

module.exports = setupLINE;
