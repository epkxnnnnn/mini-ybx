/**
 * Telegram Bot — Yellow Box Markets
 * Includes trade confirm buttons and guardian mode check
 */
const TelegramBot = require("node-telegram-bot-api");

// Injected dependencies (set via setDependencies)
let guardianService = null;
let tradePlanService = null;

function setupTelegram(aiEngine, commandRouter, authService) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("\u23ED\uFE0F  Telegram: No token, skipping");
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });
  const WEBAPP_URL = process.env.WEBAPP_URL || null;

  // Set menu button for Mini App (Dashboard)
  if (WEBAPP_URL) {
    bot.setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "Dashboard",
        web_app: { url: WEBAPP_URL },
      },
    }).catch((err) => console.error("Failed to set menu button:", err.message));
  }

  // ========== Trade Plan Callback Queries ==========
  bot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;

    if (!tradePlanService) {
      await bot.answerCallbackQuery(query.id, { text: "Service unavailable" });
      return;
    }

    if (data.startsWith("save_plan:")) {
      const planId = data.slice("save_plan:".length);
      const plan = tradePlanService.savePlan(planId);
      if (plan) {
        await bot.answerCallbackQuery(query.id, { text: "\u2705 บันทึกแผนแล้ว" });
        await bot.sendMessage(chatId,
          `\u2705 บันทึกแผนเทรดแล้ว\n${plan.symbol} ${plan.direction}\nEntry: $${plan.entry} | SL: $${plan.sl} | TP: $${plan.tp}`
        );
      } else {
        await bot.answerCallbackQuery(query.id, { text: "\u274C ไม่พบแผนนี้" });
      }
    } else if (data.startsWith("cancel_plan:")) {
      const planId = data.slice("cancel_plan:".length);
      tradePlanService.cancelPlan(planId);
      await bot.answerCallbackQuery(query.id, { text: "\u274C ยกเลิกแล้ว" });
      await bot.sendMessage(chatId, "\u274C ยกเลิกแผนเทรดแล้ว");
    } else {
      await bot.answerCallbackQuery(query.id);
    }
  });

  // Handle web_app_data from Mini App
  bot.on("message", async (msg) => {
    if (msg.web_app_data) {
      const chatId = msg.chat.id;
      try {
        const data = JSON.parse(msg.web_app_data.data);
        if (data.action === "analyze" && data.symbol) {
          const text = `/analyze ${data.symbol}`;
          if (commandRouter) {
            const result = await commandRouter.execute(text, "telegram", msg.from.id, msg.from.first_name || "");
            if (result) {
              return sendTelegramMessage(bot, chatId, result.text);
            }
          }
          const reply = await aiEngine.chat("telegram", msg.from.id, text, msg.from.first_name || "");
          return sendTelegramMessage(bot, chatId, reply);
        }
      } catch (err) {
        console.error("WebApp data error:", err.message);
        bot.sendMessage(chatId, "\u274C เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
      }
      return;
    }
  });

  // Handle all messages (commands + free text)
  bot.on("message", async (msg) => {
    if (!msg.text || msg.web_app_data) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || "";
    const text = msg.text.trim();

    // ========== Login Flow State Machine ==========
    if (authService) {
      const loginState = authService.getLoginState("telegram", userId);

      // /cancel — exit login flow at any point
      if (text === "/cancel" && loginState) {
        authService.clearLoginState("telegram", userId);
        return bot.sendMessage(chatId, "\u274C ยกเลิกการเข้าสู่ระบบแล้ว");
      }

      // Step: waiting for email
      if (loginState && loginState.step === "email") {
        const email = text.trim();
        if (!email.includes("@")) {
          return bot.sendMessage(chatId, "\u26A0\uFE0F กรุณาส่งอีเมลที่ถูกต้อง หรือพิมพ์ /cancel เพื่อยกเลิก");
        }
        authService.setLoginState("telegram", userId, { step: "password", email });
        return bot.sendMessage(chatId, `\uD83D\uDCE7 อีเมล: ${email}\n\n\uD83D\uDD11 กรุณาส่งรหัสผ่านของคุณ\n(ข้อความจะถูกลบทันทีเพื่อความปลอดภัย)`);
      }

      // Step: waiting for password
      if (loginState && loginState.step === "password") {
        const password = text.trim();
        const email = loginState.email;

        // Delete the password message for security
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (err) {
          // May fail if bot lacks delete permission — not critical
        }

        try {
          const session = await authService.login("telegram", userId, email, password);
          const m = session.memberData;

          let welcomeText = `\u2705 เข้าสู่ระบบสำเร็จ!\n\n` +
            `\uD83D\uDC64 สวัสดีครับ ${m.name}\n` +
            `\uD83C\uDFC6 Tier: ${m.tier}\n` +
            `\uD83D\uDCE7 ${m.email}\n`;

          // Show account info
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

          welcomeText += `\nพร้อมช่วยเหลือแล้วครับ! \uD83D\uDCAC`;
          return bot.sendMessage(chatId, welcomeText);
        } catch (err) {
          authService.clearLoginState("telegram", userId);
          return bot.sendMessage(chatId, `\u274C เข้าสู่ระบบไม่สำเร็จ: ${err.message}\n\nพิมพ์ /login เพื่อลองใหม่`);
        }
      }

      // /login command — start login flow
      if (text === "/login") {
        if (authService.isAuthenticated("telegram", userId)) {
          return bot.sendMessage(chatId, "\u2705 คุณเข้าสู่ระบบอยู่แล้ว\nพิมพ์ /logout เพื่อออกจากระบบ");
        }
        authService.setLoginState("telegram", userId, { step: "email" });
        return bot.sendMessage(chatId,
          "\uD83D\uDD10 เข้าสู่ระบบ YBX Member\n\n" +
          "กรุณาส่งอีเมลที่ลงทะเบียนกับ Yellow Box Markets\n" +
          "(พิมพ์ /cancel เพื่อยกเลิก)"
        );
      }

      // /logout command
      if (text === "/logout") {
        authService.logout("telegram", userId);
        aiEngine.resetConversation("telegram", userId);
        return bot.sendMessage(chatId, "\uD83D\uDC4B ออกจากระบบเรียบร้อยแล้ว\nพิมพ์ /login เพื่อเข้าสู่ระบบอีกครั้ง");
      }

      // Auth gate — block unauthenticated users (except /start, /checklist, /zones)
      const publicCommands = ["/start", "/checklist", "/zones"];
      const isPublicCommand = publicCommands.some(cmd => text.startsWith(cmd));

      if (!isPublicCommand && !authService.isAuthenticated("telegram", userId)) {
        return bot.sendMessage(chatId,
          "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อนใช้งาน\n" +
          "พิมพ์ /login เพื่อเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน YBX ของคุณ"
        );
      }
    }

    // ========== Command Routing ==========

    // Try command router first (handles /start, /price, /analyze, etc.)
    if (text.startsWith("/") && commandRouter) {
      const result = await commandRouter.execute(text, "telegram", userId, userName);
      if (result) {
        return sendTelegramMessage(bot, chatId, result.text);
      }
    }

    // /dashboard command — open Mini App
    if (text === "/dashboard" && WEBAPP_URL) {
      return bot.sendMessage(chatId,
        "\uD83D\uDCCA เปิด Trading Dashboard เพื่อดูราคาสด, วิเคราะห์ ENGULF-X, ปฏิทินเศรษฐกิจ และอัตราแลกเปลี่ยน",
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "\uD83D\uDCCA Open Dashboard", web_app: { url: WEBAPP_URL } }
            ]],
          },
        }
      );
    }

    // Legacy command fallback (when no CRM / command router)
    if (text.startsWith("/")) {
      if (text === "/start") {
        const startOpts = {};
        if (WEBAPP_URL) {
          startOpts.reply_markup = {
            inline_keyboard: [[
              { text: "\uD83D\uDCCA Open Dashboard", web_app: { url: WEBAPP_URL } }
            ]],
          };
        }
        return bot.sendMessage(chatId,
          `สวัสดีครับ ${userName || "Trader"}! \uD83D\uDC4B\n\n` +
          `ผมคือ Jerry ผู้ช่วย AI ของ Yellow Box Markets\n\n` +
          `\uD83D\uDD39 วิเคราะห์ตลาดด้วย ENGULF-X\n` +
          `\uD83D\uDD39 ดูราคาสด, ข่าว, แนวรับแนวต้าน\n` +
          `\uD83D\uDD39 สอนกลยุทธ์การเทรด\n\n` +
          `คำสั่ง:\n` +
          `/login — เข้าสู่ระบบ\n` +
          `/price [symbol] — ดูราคาสด\n` +
          `/analyze [symbol] — วิเคราะห์ ENGULF-X\n` +
          `/news — ข่าวเศรษฐกิจวันนี้\n` +
          `/levels [symbol] — แนวรับแนวต้าน\n` +
          `/rate — อัตราแลกเปลี่ยน THB/USD\n` +
          `/dashboard — เปิด Trading Dashboard\n` +
          `/checklist — เช็คลิสต์ 5 ขั้นตอน\n` +
          `/zones — ตาราง Zone Priority\n` +
          `/reset — เริ่มบทสนทนาใหม่`,
          startOpts
        );
      }
      if (text === "/checklist") {
        return sendTelegramMessage(bot, chatId,
          `\uD83D\uDCCB ENGULF-X เช็คลิสต์ 5 ขั้นตอน\n\n` +
          `1\uFE0F\u20E3 BOS — MAJOR หรือ MINOR?\n` +
          `2\uFE0F\u20E3 YELLOW BOX — กล่อง RET ที่ยังไม่ได้ใช้\n` +
          `3\uFE0F\u20E3 CONFIRM — CHOCH PULLBACK\n` +
          `4\uFE0F\u20E3 ZONE — 1ST MAJOR หรือ KF\n` +
          `5\uFE0F\u20E3 ACTION — คำนวณ TP/SL\n\n` +
          `\u2757 กฎ 1%/2% อัตโนมัติมีความสำคัญสูงสุด\n` +
          `\u2022 BUY = ราคาลด 1% → ซื้อทันที\n` +
          `\u2022 SELL = ราคาเพิ่ม 2% → ขายทันที`
        );
      }
      if (text === "/zones") {
        return sendTelegramMessage(bot, chatId,
          `\uD83D\uDCCA Zone Priority Table\n\n` +
          `1. 1ST MAJOR \u2605\u2605\u2605\u2605\u2605 — 100% size, R:R 1:1.5\n` +
          `2. KF (ข้ามฟาก) \u2605\u2605\u2605\u2605\u2606 — 100% size, R:R 1:2\n` +
          `3. YELLOW BOX \u2605\u2605\u2605\u2606\u2606 — 80% size, R:R 1:2.5\n` +
          `4. MAJOR BOX \u2605\u2605\u2606\u2606\u2606 — 60% size, R:R 1:3\n` +
          `5. MINOR RET \u2605\u2606\u2606\u2606\u2606 — 50% size, R:R 1:3+\n\n` +
          `\u26A0\uFE0F ถ้า R:R ไม่ถึงขั้นต่ำ → SKIP`
        );
      }
      if (text === "/reset") {
        aiEngine.resetConversation("telegram", userId);
        return bot.sendMessage(chatId, "\uD83D\uDD04 เริ่มบทสนทนาใหม่แล้วครับ");
      }
      // Unknown command — ignore
      return;
    }

    // ========== Free text → AI chat ==========
    bot.sendChatAction(chatId, "typing");

    try {
      // Build member context if authenticated
      let memberContext = "";
      if (authService) {
        const session = await authService.getSession("telegram", userId);
        if (session) {
          memberContext = authService.buildMemberContext(session);
        }
      }

      // Check guardian mode
      const isGuardian = guardianService ? guardianService.isActive("telegram", userId) : false;

      const reply = await aiEngine.chat("telegram", userId, text, userName, memberContext, { guardianMode: isGuardian });

      // Detect trade setup in AI response and add inline keyboard
      if (tradePlanService) {
        const setup = tradePlanService.detectTradeSetup(reply);
        if (setup) {
          const plan = tradePlanService.createPending("telegram", userId, setup);
          await sendTelegramMessage(bot, chatId, reply, {
            reply_markup: {
              inline_keyboard: [[
                { text: "\u2705 บันทึกแผน", callback_data: `save_plan:${plan.id}` },
                { text: "\u274C ยกเลิก", callback_data: `cancel_plan:${plan.id}` },
              ]],
            },
          });
          return;
        }
      }

      await sendTelegramMessage(bot, chatId, reply);
    } catch (err) {
      console.error("Telegram handler error:", err.message);
      bot.sendMessage(chatId, "\u274C เกิดข้อผิดพลาด กรุณาลองใหม่ครับ");
    }
  });

  console.log("\u2705 Telegram bot started");
  return bot;
}

/**
 * Set additional dependencies after initialization
 */
setupTelegram.setDependencies = function (deps) {
  if (deps.guardianService) guardianService = deps.guardianService;
  if (deps.tradePlanService) tradePlanService = deps.tradePlanService;
};

/**
 * Send message with Telegram's 4096 char limit handling
 * Optionally pass extra options (reply_markup, etc.)
 */
async function sendTelegramMessage(bot, chatId, text, extraOpts = {}) {
  if (text.length > 4000) {
    const chunks = text.match(/.{1,4000}/gs);
    for (let i = 0; i < chunks.length; i++) {
      const opts = { parse_mode: "Markdown" };
      // Attach extra opts (inline keyboard) to last chunk only
      if (i === chunks.length - 1) Object.assign(opts, extraOpts);
      await bot.sendMessage(chatId, chunks[i], opts).catch(() => {
        const fallbackOpts = i === chunks.length - 1 ? extraOpts : {};
        bot.sendMessage(chatId, chunks[i], fallbackOpts);
      });
    }
  } else {
    const opts = { parse_mode: "Markdown", ...extraOpts };
    await bot.sendMessage(chatId, text, opts).catch(() => {
      bot.sendMessage(chatId, text, extraOpts);
    });
  }
}

module.exports = setupTelegram;
