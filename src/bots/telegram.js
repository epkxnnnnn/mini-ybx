/**
 * Telegram Bot — Yellow Box Markets
 * Includes trade confirm buttons and guardian mode check
 */
const TelegramBot = require("node-telegram-bot-api");
const { getSymbolSpec } = require("../services/symbol-spec-service");

// Injected dependencies (set via setDependencies)
let guardianService = null;
let tradePlanService = null;
let crmClient = null;
let authServiceRef = null;
let executionAuditService = null;

function recordExecutionEvent(event) {
  if (!executionAuditService) return;
  executionAuditService.record(event).catch((err) => {
    console.error("Execution audit error:", err.message);
  });
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUsd(value) {
  const amount = toNumber(value);
  if (amount == null) return "N/A";
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getAccountSnapshot(account) {
  if (!account) return null;

  const balance = toNumber(account.balance);
  const equity = toNumber(account.equity) ?? balance;
  const margin = toNumber(account.margin) ?? 0;
  const freeMargin = toNumber(account.freeMargin) ?? (equity != null ? equity - margin : null);
  const marginLevel = margin > 0 && equity != null ? (equity / margin) * 100 : null;

  return {
    id: account.login || account.accountId || account.id || null,
    balance,
    equity,
    margin,
    freeMargin,
    leverage: account.leverage || null,
    marginLevel,
  };
}

function evaluateOrderPreflight(state) {
  const blockers = [];
  const warnings = [];
  const plan = state?.plan || {};
  const account = getAccountSnapshot(state?.account);
  const entry = toNumber(state?.orderType === "MARKET" ? plan.entry : state?.price ?? plan.entry);
  const sl = toNumber(plan.sl);
  const tp = toNumber(plan.tp);
  const riskRewardRaw = String(plan.riskReward || "").match(/1:([\d.]+)/);
  const riskReward = riskRewardRaw ? Number(riskRewardRaw[1]) : null;

  if (!account) {
    blockers.push("ไม่พบบัญชีเทรดสำหรับตรวจสอบก่อนส่งคำสั่ง");
  }

  if (!state?.volume || state.volume <= 0) {
    blockers.push("ยังไม่ได้ระบุขนาด Lot");
  }

  if (!state?.orderType) {
    blockers.push("ยังไม่ได้เลือกประเภทคำสั่ง");
  }

  if (state?.orderType !== "MARKET" && !(toNumber(state?.price) > 0)) {
    blockers.push("Pending order ต้องมีราคาที่ถูกต้อง");
  }

  if (![entry, sl, tp].every((value) => value != null && value > 0)) {
    blockers.push("แผนเทรดยังมีข้อมูล Entry/SL/TP ไม่ครบ");
  } else if (plan.direction === "BUY" && !(sl < entry && tp > entry)) {
    blockers.push("โครงสร้าง BUY setup ไม่ถูกต้อง: SL ต้องต่ำกว่า Entry และ TP ต้องสูงกว่า Entry");
  } else if (plan.direction === "SELL" && !(sl > entry && tp < entry)) {
    blockers.push("โครงสร้าง SELL setup ไม่ถูกต้อง: SL ต้องสูงกว่า Entry และ TP ต้องต่ำกว่า Entry");
  }

  if (account?.marginLevel != null) {
    if (account.marginLevel < 150) {
      blockers.push(`Margin Level ต่ำมาก (${Math.round(account.marginLevel)}%)`);
    } else if (account.marginLevel < 300) {
      warnings.push(`Margin Level ค่อนข้างตึง (${Math.round(account.marginLevel)}%)`);
    }
  }

  if (account?.freeMargin != null && account.freeMargin <= 0) {
    blockers.push("Free Margin ไม่เพียงพอ");
  } else if (account?.freeMargin != null && account?.equity != null && account.equity > 0) {
    const freeMarginRatio = account.freeMargin / account.equity;
    if (freeMarginRatio < 0.2) {
      warnings.push(`Free Margin เหลือน้อย (${Math.round(freeMarginRatio * 100)}% ของ Equity)`);
    }
  }

  if (riskReward != null && riskReward < 1.5) {
    warnings.push(`R:R ต่ำ (${plan.riskReward}) ควรทบทวนก่อนส่งคำสั่ง`);
  } else if (riskReward == null) {
    warnings.push("ไม่พบค่า R:R ที่ชัดเจนในแผนเทรด");
  }

  if (state?.volume >= 5) {
    warnings.push(`Lot ค่อนข้างใหญ่ (${state.volume} lots) กรุณาตรวจสอบซ้ำ`);
  }

  const maxSuggested = state?.sizing?.suggestions?.[state.sizing.suggestions.length - 1]?.lot;
  if (maxSuggested && state.volume > maxSuggested * 1.5) {
    warnings.push(`Lot สูงกว่าช่วงแนะนำอย่างมีนัยสำคัญ (แนะนำสูงสุดราว ${maxSuggested} lots)`);
  }

  if (state?.orderType === "LIMIT" && toNumber(plan.entry) != null) {
    if (plan.direction === "BUY" && state.price > plan.entry) {
      warnings.push("BUY LIMIT สูงกว่า Entry ในแผนเดิม");
    }
    if (plan.direction === "SELL" && state.price < plan.entry) {
      warnings.push("SELL LIMIT ต่ำกว่า Entry ในแผนเดิม");
    }
  }

  if (state?.orderType === "STOP" && toNumber(plan.entry) != null) {
    if (plan.direction === "BUY" && state.price < plan.entry) {
      warnings.push("BUY STOP ต่ำกว่า Entry ในแผนเดิม");
    }
    if (plan.direction === "SELL" && state.price > plan.entry) {
      warnings.push("SELL STOP สูงกว่า Entry ในแผนเดิม");
    }
  }

  return { account, blockers, warnings };
}

function buildOrderConfirmationText(state, preflight) {
  const p = state.plan;
  const typeLabel = state.orderType === 'MARKET' ? 'Market' : `${state.orderType} @ $${state.price}`;
  const lines = [
    "⚠️ ยืนยันคำสั่งเทรด",
    "",
    `Account: ${state.accountLogin}`,
    `${p.symbol} ${p.direction} ${state.volume} lots (${typeLabel})`,
    `Entry: ${p.entry === 'Market' ? 'Market' : '$' + p.entry}`,
    `SL: $${p.sl} | TP: $${p.tp}`,
  ];

  if (preflight.account) {
    lines.push(
      "",
      "ข้อมูลบัญชีก่อนส่งคำสั่ง",
      `Balance: ${formatUsd(preflight.account.balance)} | Equity: ${formatUsd(preflight.account.equity)}`,
      `Free Margin: ${formatUsd(preflight.account.freeMargin)} | Margin Level: ${preflight.account.marginLevel != null ? Math.round(preflight.account.marginLevel) + '%' : 'N/A'}`,
    );
  }

  if (preflight.warnings.length > 0) {
    lines.push("", "คำเตือนก่อนส่งคำสั่ง");
    for (const warning of preflight.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (preflight.blockers.length > 0) {
    lines.push("", "รายการที่ต้องแก้ก่อนส่งคำสั่ง");
    for (const blocker of preflight.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  return lines.join("\n");
}

function normalizePosition(position) {
  const volume = toNumber(position.volume || position.lots);
  const openPrice = toNumber(position.openPrice || position.entryPrice || position.priceOpen);
  const stopLoss = toNumber(position.sl || position.stopLoss);
  const takeProfit = toNumber(position.tp || position.takeProfit);
  const pnl = toNumber(position.profit || position.pnl) ?? 0;
  const accountId = position.accountId || position.mt5AccountId || position.login || position.accountLogin || position.account;
  const ticket = position.ticket || position.positionTicket || position.id;
  const directionRaw = String(position.type || position.direction || position.side || '').toUpperCase();
  const direction = directionRaw.includes('BUY') ? 'BUY' : directionRaw.includes('SELL') ? 'SELL' : directionRaw;

  if (!accountId || !ticket || !volume || !openPrice || !direction) return null;

  return {
    accountId: String(accountId),
    ticket: String(ticket),
    symbol: position.symbol || 'N/A',
    direction,
    volume,
    pnl,
    openPrice,
    stopLoss,
    takeProfit,
  };
}

function evaluatePositionHealth(position) {
  if (!position) {
    return { level: 'unknown', recommendations: [] };
  }

  const recommendations = [];
  let score = 0;

  if (position.pnl > 0) score += 2;
  if (position.pnl < 0) score -= 2;
  if (position.stopLoss) score += 1;
  else recommendations.push('ควรตั้ง Stop Loss');
  if (position.takeProfit) score += 1;

  if (position.pnl > 0 && !position.stopLoss) {
    recommendations.push('มีกำไรแล้ว ควรเลื่อน SL ไปที่ BE');
  }
  if (position.pnl > 50) {
    recommendations.push('พิจารณาปิดบางส่วนเพื่อล็อกกำไร');
  }
  if (position.pnl < -50) {
    recommendations.push('พิจารณาลดขนาดสถานะหรือตัดขาดทุน');
  }

  let level = 'watch';
  if (score >= 3) level = 'healthy';
  else if (score <= -1) level = 'risk';

  return {
    level,
    recommendations,
  };
}

function buildPositionSummary(position, index) {
  const health = evaluatePositionHealth(position);
  const healthLabel = health.level === 'healthy'
    ? '🟢 Healthy'
    : health.level === 'risk'
      ? '🔴 Risk'
      : '🟡 Watch';
  return (
    `📌 Position #${index + 1}\n` +
    `Account: ${position.accountId}\n` +
    `${position.symbol} ${position.direction} ${position.volume} lots\n` +
    `Open: ${formatUsd(position.openPrice)} | P/L: ${formatUsd(position.pnl)}\n` +
    `SL: ${formatUsd(position.stopLoss)} | TP: ${formatUsd(position.takeProfit)}\n` +
    `Health: ${healthLabel}` +
    (health.recommendations.length ? `\nHint: ${health.recommendations[0]}` : '')
  );
}

function buildPositionActionPreview(position, action) {
  if (!position) return 'ไม่พบตำแหน่งที่เลือก';

  if (action === 'close_half') {
    const partialVolume = Math.min(position.volume, Math.max(0.01, Math.round((position.volume / 2) * 100) / 100));
    return (
      `⚠️ ยืนยันลดความเสี่ยง\n\n` +
      `${buildPositionSummary(position, 0)}\n\n` +
      `Action: Close 50% (${partialVolume} lots)`
    );
  }

  if (action === 'close_full') {
    return (
      `⚠️ ยืนยันปิดสถานะทั้งหมด\n\n` +
      `${buildPositionSummary(position, 0)}\n\n` +
      `Action: Close full (${position.volume} lots)`
    );
  }

  if (action === 'move_sl_be') {
    const note = position.pnl < 0
      ? '\n\nหมายเหตุ: ตำแหน่งยังติดลบ การเลื่อน SL ไปที่ BE อาจถูกปิดเร็วเมื่อราคาย้อนกลับ'
      : '';
    return (
      `🛡️ ยืนยันป้องกันความเสี่ยง\n\n` +
      `${buildPositionSummary(position, 0)}\n\n` +
      `Action: Move Stop Loss to Break-even (${formatUsd(position.openPrice)})${note}`
    );
  }

  if (action === 'secure_profit') {
    return (
      `🛡️ ยืนยันล็อกกำไร\n\n` +
      `${buildPositionSummary(position, 0)}\n\n` +
      `Action:\n` +
      `- Close 50%\n` +
      `- Move SL to Break-even (${formatUsd(position.openPrice)})`
    );
  }

  if (action === 'edit_sl_tp') {
    return (
      `✏️ แก้ไข SL/TP\n\n` +
      `${buildPositionSummary(position, 0)}\n\n` +
      `ส่งข้อความในรูปแบบ:\n` +
      `sl=3345 tp=3375\n` +
      `หรือแก้เฉพาะค่าเดียว เช่น:\n` +
      `sl=3345`
    );
  }

  return 'ไม่รู้จัก action ที่เลือก';
}

function parsePositionEditInput(text) {
  if (!text || typeof text !== 'string') return null;

  const slMatch = text.match(/sl\s*=\s*([\d.]+)/i);
  const tpMatch = text.match(/tp\s*=\s*([\d.]+)/i);
  const stopLoss = slMatch ? toNumber(slMatch[1]) : null;
  const takeProfit = tpMatch ? toNumber(tpMatch[1]) : null;

  if (stopLoss == null && takeProfit == null) return null;
  return { stopLoss, takeProfit };
}

function getLotSizingSpec(symbol) {
  return getSymbolSpec(symbol);
}

function estimateLotSizes(plan, account) {
  const symbol = plan?.symbol;
  const entry = toNumber(plan?.entry);
  const sl = toNumber(plan?.sl);
  const equity = toNumber(account?.equity) ?? toNumber(account?.balance);
  const spec = getLotSizingSpec(symbol);

  if (!spec || !entry || !sl || !equity || equity <= 0) {
    return null;
  }

  const stopDistance = Math.abs(entry - sl);
  if (stopDistance <= 0) return null;

  const pointCount = stopDistance / spec.pointSize;
  const riskPerLot = pointCount * spec.usdPerPointPerLot;
  if (!Number.isFinite(riskPerLot) || riskPerLot <= 0) return null;

  const suggestions = [1, 2].map((riskPct) => {
    const riskAmount = equity * (riskPct / 100);
    const lot = Math.max(0.01, Math.floor((riskAmount / riskPerLot) * 100) / 100);
    return {
      riskPct,
      riskAmount,
      lot,
    };
  }).filter((item, index, arr) => item.lot > 0 && (index === 0 || item.lot > arr[index - 1].lot));

  if (suggestions.length === 0) return null;

  return {
    symbol: String(symbol).toUpperCase(),
    equity,
    stopDistance,
    riskPerLot,
    assumptions: spec.label,
    suggestions,
  };
}

function buildSizingGuidance(plan, sizing) {
  if (!sizing) {
    return 'กรุณาพิมพ์ขนาด Lot (เช่น 0.01, 0.1, 1.0):';
  }

  const suggestionLines = sizing.suggestions.map((item) =>
    `- Risk ${item.riskPct}% ≈ ${item.lot} lots (risk ~ ${formatUsd(item.riskAmount)})`
  );

  return (
    `ขนาด Lot แนะนำโดยประมาณ\n` +
    `สมมติฐาน: ${sizing.assumptions}\n` +
    `Equity: ${formatUsd(sizing.equity)} | ระยะ SL: ${sizing.stopDistance.toFixed(2)}\n` +
    suggestionLines.join('\n') +
    `\n\nพิมพ์ขนาด Lot เอง หรือเลือกจากปุ่มด้านล่าง`
  );
}

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

  // ========== Trade Plan & Order Execution Callback Queries ==========
  bot.on("callback_query", async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const userId = query.from.id;

    if (!tradePlanService) {
      await bot.answerCallbackQuery(query.id, { text: "Service unavailable" });
      return;
    }

    // --- Save Plan ---
    if (data.startsWith("save_plan:")) {
      const planId = data.slice("save_plan:".length);
      const plan = tradePlanService.savePlan(planId);
      if (plan) {
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "trade_plan",
          action: "save_plan",
          status: "success",
          correlationId: planId,
          payload: { plan },
        });
        await bot.answerCallbackQuery(query.id, { text: "\u2705 บันทึกแผนแล้ว" });
        await bot.sendMessage(chatId,
          `\u2705 บันทึกแผนเทรดแล้ว\n${plan.symbol} ${plan.direction}\nEntry: $${plan.entry} | SL: $${plan.sl} | TP: $${plan.tp}`
        );
      } else {
        await bot.answerCallbackQuery(query.id, { text: "\u274C ไม่พบแผนนี้" });
      }
      return;
    }

    // --- Cancel Plan ---
    if (data.startsWith("cancel_plan:")) {
      const planId = data.slice("cancel_plan:".length);
      tradePlanService.cancelPlan(planId);
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "trade_plan",
        action: "cancel_plan",
        status: "success",
        correlationId: planId,
        payload: {},
      });
      await bot.answerCallbackQuery(query.id, { text: "\u274C ยกเลิกแล้ว" });
      await bot.sendMessage(chatId, "\u274C ยกเลิกแผนเทรดแล้ว");
      return;
    }

    // --- Execute Plan: Start order flow ---
    if (data.startsWith("execute_plan:")) {
      const planId = data.slice("execute_plan:".length);

      // Guardian mode — hard block order execution
      if (guardianService && guardianService.isActive("telegram", userId)) {
        await bot.answerCallbackQuery(query.id, { text: "🛡️ Guardian Mode: ไม่สามารถเปิดออเดอร์ได้" });
        await bot.sendMessage(chatId,
          "🛡️ Guardian Mode Active\n\n" +
          "⚠️ Margin Level อยู่ในระดับวิกฤต — ไม่อนุญาตให้เปิดออเดอร์ใหม่\n" +
          "แนะนำ: ปิดสถานะที่ขาดทุน หรือเพิ่มเงินทุน"
        );
        return;
      }

      if (!crmClient || !authServiceRef) {
        await bot.answerCallbackQuery(query.id, { text: "ระบบเทรดยังไม่พร้อม" });
        return;
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: "กรุณา /login ก่อนส่งคำสั่ง" });
        await bot.sendMessage(chatId, "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อนส่งคำสั่งเทรด\nพิมพ์ /login เพื่อเข้าสู่ระบบ");
        return;
      }

      const pending = tradePlanService.getPendingPlan(planId);
      if (!pending) {
        await bot.answerCallbackQuery(query.id, { text: "\u274C ไม่พบแผนนี้" });
        return;
      }

      // Fetch MT5 accounts
      try {
        await bot.answerCallbackQuery(query.id, { text: "กำลังโหลดบัญชี..." });
        const accountsRes = await crmClient.getMemberAccounts(session.accessToken);
        const accounts = Array.isArray(accountsRes) ? accountsRes : (accountsRes?.data || accountsRes?.accounts || []);

        if (accounts.length === 0) {
          await bot.sendMessage(chatId, "\u274C ไม่พบบัญชีเทรด กรุณาติดต่อฝ่ายสนับสนุน");
          return;
        }

        // Save order state
        tradePlanService.setOrderState("telegram", userId, {
          step: 'select_account',
          planId: planId,
          plan: pending.plan,
          accounts,
          chatId: chatId,
        });
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "order",
          action: "start_execution",
          status: "success",
          correlationId: planId,
          payload: { plan: pending.plan },
        });

        // Show account selection
        const keyboard = accounts.map(a => {
          const login = a.login || a.accountId || a.id || 'N/A';
          const balance = a.balance != null ? `$${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
          return [{ text: `${login} ${balance}`, callback_data: `select_account:${a.login || a.accountId || a.id}` }];
        });
        keyboard.push([{ text: "\u274C ยกเลิก", callback_data: "cancel_order" }]);

        await bot.sendMessage(chatId,
          `\uD83D\uDCBC เลือกบัญชีเทรดสำหรับคำสั่ง:\n${pending.plan.symbol} ${pending.plan.direction}`,
          { reply_markup: { inline_keyboard: keyboard } }
        );
      } catch (err) {
        console.error("Fetch accounts error:", err.message);
        await bot.sendMessage(chatId, "\u274C ไม่สามารถโหลดบัญชีได้: " + err.message);
        tradePlanService.clearOrderState("telegram", userId);
      }
      return;
    }

    // --- Select Account ---
    if (data.startsWith("select_account:")) {
      const accountId = data.slice("select_account:".length);
      const state = tradePlanService.getOrderState("telegram", userId);
      if (!state || state.step !== 'select_account') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีคำสั่งที่รอดำเนินการ" });
        return;
      }

      await bot.answerCallbackQuery(query.id);

      const account = Array.isArray(state.accounts)
        ? state.accounts.find((item) => String(item.login || item.accountId || item.id) === accountId)
        : null;
      state.accountId = accountId;
      state.accountLogin = accountId;
      state.account = account || null;
      state.sizing = estimateLotSizes(state.plan, account);
      state.step = 'enter_volume';
      tradePlanService.setOrderState("telegram", userId, state);
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "order",
        action: "select_account",
        status: "success",
        correlationId: state.planId,
        payload: { accountId },
      });

      const p = state.plan;
      const sizingText = buildSizingGuidance(p, state.sizing);
      const quickLotButtons = state.sizing?.suggestions?.length
        ? [state.sizing.suggestions.map((item) => ({
            text: `${item.riskPct}% = ${item.lot} lots`,
            callback_data: `set_volume:${item.lot}`,
          }))]
        : [];
      quickLotButtons.push([{ text: "\u274C ยกเลิก", callback_data: "cancel_order" }]);
      await bot.sendMessage(chatId,
        `\uD83D\uDCE4 คำสั่งเทรด\n` +
        `Symbol: ${p.symbol} | Direction: ${p.direction}\n` +
        `Entry: ${p.entry === 'Market' ? 'Market' : '$' + p.entry} | SL: $${p.sl} | TP: $${p.tp}\n` +
        `Account: ${accountId}\n\n` +
        `${sizingText}`,
        {
          reply_markup: {
            inline_keyboard: quickLotButtons,
          },
        }
      );
      return;
    }

    // --- Quick-select Volume ---
    if (data.startsWith("set_volume:")) {
      const volume = parseFloat(data.slice("set_volume:".length));
      const state = tradePlanService.getOrderState("telegram", userId);
      if (!state || state.step !== 'enter_volume') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีคำสั่งที่รอดำเนินการ" });
        return;
      }

      if (!Number.isFinite(volume) || volume <= 0 || volume > 100) {
        await bot.answerCallbackQuery(query.id, { text: "Lot ที่เลือกไม่ถูกต้อง" });
        return;
      }

      state.volume = volume;
      state.step = 'select_type';
      tradePlanService.setOrderState("telegram", userId, state);
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "order",
        action: "set_volume",
        status: "success",
        correlationId: state.planId,
        payload: { volume },
      });

      await bot.answerCallbackQuery(query.id, { text: `เลือก Lot ${volume}` });
      await bot.sendMessage(chatId, "เลือกประเภทคำสั่ง:", {
        reply_markup: {
          inline_keyboard: [[
            { text: "Market Order", callback_data: "order_type:MARKET" },
            { text: "Limit Order", callback_data: "order_type:LIMIT" },
            { text: "Stop Order", callback_data: "order_type:STOP" },
          ], [
            { text: "\u274C ยกเลิก", callback_data: "cancel_order" },
          ]],
        },
      });
      return;
    }

    // --- Order Type Selection ---
    if (data.startsWith("order_type:")) {
      const orderType = data.slice("order_type:".length);
      const state = tradePlanService.getOrderState("telegram", userId);
      if (!state || state.step !== 'select_type') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีคำสั่งที่รอดำเนินการ" });
        return;
      }

      await bot.answerCallbackQuery(query.id);

      state.orderType = orderType;
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "order",
        action: "set_order_type",
        status: "success",
        correlationId: state.planId,
        payload: { orderType },
      });

      if (orderType === 'MARKET') {
        // Skip to confirmation
        state.price = null;
        state.step = 'confirm';
        tradePlanService.setOrderState("telegram", userId, state);
        await showOrderConfirmation(bot, chatId, state);
      } else {
        // Ask for price
        state.step = 'enter_price';
        tradePlanService.setOrderState("telegram", userId, state);
        await bot.sendMessage(chatId, `กรุณาพิมพ์ราคาที่ต้องการสำหรับ ${orderType} Order:`);
      }
      return;
    }

    // --- Confirm Order ---
    if (data === "confirm_order") {
      // Guardian mode — hard block order confirmation
      if (guardianService && guardianService.isActive("telegram", userId)) {
        await bot.answerCallbackQuery(query.id, { text: "🛡️ Guardian Mode: ไม่สามารถส่งคำสั่งได้" });
        await bot.sendMessage(chatId,
          "🛡️ Guardian Mode Active\n\n" +
          "⚠️ Margin Level อยู่ในระดับวิกฤต — ไม่อนุญาตให้ส่งคำสั่งเทรด\n" +
          "แนะนำ: ปิดสถานะที่ขาดทุน หรือเพิ่มเงินทุน"
        );
        tradePlanService.clearOrderState("telegram", userId);
        return;
      }

      const state = tradePlanService.getOrderState("telegram", userId);
      if (!state || state.step !== 'confirm') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีคำสั่งที่รอดำเนินการ" });
        return;
      }

      if (!crmClient || !authServiceRef) {
        await bot.answerCallbackQuery(query.id, { text: "ระบบเทรดยังไม่พร้อม" });
        return;
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: "Session หมดอายุ กรุณา /login ใหม่" });
        tradePlanService.clearOrderState("telegram", userId);
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: "กำลังส่งคำสั่ง..." });

      try {
        const preflight = evaluateOrderPreflight(state);
        if (preflight.blockers.length > 0) {
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "order",
            action: "confirm_order",
            status: "blocked",
            correlationId: state.planId,
            payload: { blockers: preflight.blockers, warnings: preflight.warnings },
          });
          await bot.sendMessage(chatId,
            "❌ ไม่สามารถส่งคำสั่งได้\n" + preflight.blockers.map((item) => `- ${item}`).join("\n")
          );
          tradePlanService.clearOrderState("telegram", userId);
          return;
        }

        let result;
        const orderParams = {
          symbol: state.plan.symbol,
          side: state.plan.direction,
          volume: state.volume,
          stopLoss: state.plan.sl,
          takeProfit: state.plan.tp,
        };

        if (state.orderType === 'MARKET') {
          result = await crmClient.placeOrder(session.accessToken, state.accountId, orderParams);
        } else {
          result = await crmClient.placePendingOrder(session.accessToken, state.accountId, {
            ...orderParams,
            orderType: state.orderType,
            price: state.price,
          });
        }

        const resData = result.data || result;
        const dealId = resData.dealId || resData.ticket || resData.orderId || 'N/A';
        const execPrice = resData.price || resData.openPrice || 'N/A';
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "order",
          action: "confirm_order",
          status: "success",
          correlationId: state.planId,
          payload: {
            accountId: state.accountId,
            orderType: state.orderType,
            volume: state.volume,
            symbol: state.plan.symbol,
            direction: state.plan.direction,
            dealId,
            execPrice,
          },
        });

        await bot.sendMessage(chatId,
          `\u2705 คำสั่งสำเร็จ\n` +
          `Deal #${dealId}\n` +
          `${state.plan.symbol} ${state.plan.direction} ${state.volume} lots` +
          (execPrice !== 'N/A' ? ` @ $${execPrice}` : '') + `\n` +
          `SL: $${state.plan.sl} | TP: $${state.plan.tp}`
        );
      } catch (err) {
        console.error("Order execution error:", err.message);
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "order",
          action: "confirm_order",
          status: "error",
          correlationId: state.planId,
          payload: { error: err.message },
        });
        await bot.sendMessage(chatId, `\u274C คำสั่งไม่สำเร็จ: ${err.message}`);
      }

      tradePlanService.clearOrderState("telegram", userId);
      return;
    }

    // --- Cancel Order ---
    if (data === "cancel_order") {
      const state = tradePlanService.getOrderState("telegram", userId);
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "order",
        action: "cancel_order",
        status: "success",
        correlationId: state?.planId || null,
        payload: {},
      });
      tradePlanService.clearOrderState("telegram", userId);
      await bot.answerCallbackQuery(query.id, { text: "\u274C ยกเลิกแล้ว" });
      await bot.sendMessage(chatId, "\u274C ยกเลิกคำสั่งเทรดแล้ว");
      return;
    }

    // --- Prepare Position Action ---
    if (data.startsWith("prepare_pos:")) {
      const [, action, indexRaw] = data.split(":");
      const positionState = tradePlanService.getPositionState("telegram", userId);
      const index = Number(indexRaw);
      const position = positionState?.positions?.[index];

      if (!positionState || !position || !Number.isInteger(index)) {
        await bot.answerCallbackQuery(query.id, { text: "ไม่พบสถานะที่เลือก" });
        return;
      }

      positionState.pendingAction = { action, index };
      tradePlanService.setPositionState("telegram", userId, positionState);
      recordExecutionEvent({
        platform: "telegram",
        userId,
        category: "position",
        action: "prepare_action",
        status: "success",
        correlationId: position.ticket,
        payload: { action, position },
      });

      await bot.answerCallbackQuery(query.id);
      if (action === 'edit_sl_tp') {
        await bot.sendMessage(chatId, buildPositionActionPreview(position, action));
        return;
      }

      await bot.sendMessage(chatId, buildPositionActionPreview(position, action), {
        reply_markup: {
          inline_keyboard: [[
            { text: "\u2705 ยืนยัน", callback_data: "confirm_pos_action" },
            { text: "\u274C ยกเลิก", callback_data: "cancel_pos_action" },
          ]],
        },
      });
      return;
    }

    // --- Confirm Position Action ---
    if (data === "confirm_pos_action") {
      const positionState = tradePlanService.getPositionState("telegram", userId);
      const pendingAction = positionState?.pendingAction;
      const position = pendingAction ? positionState?.positions?.[pendingAction.index] : null;

      if (!pendingAction || !position) {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มี action ที่รอดำเนินการ" });
        return;
      }

      if (!crmClient || !authServiceRef) {
        await bot.answerCallbackQuery(query.id, { text: "ระบบเทรดยังไม่พร้อม" });
        return;
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: "Session หมดอายุ กรุณา /login ใหม่" });
        tradePlanService.clearPositionState("telegram", userId);
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: "กำลังดำเนินการ..." });

      try {
        if (pendingAction.action === "close_half") {
          const volume = Math.min(position.volume, Math.max(0.01, Math.round((position.volume / 2) * 100) / 100));
          await crmClient.closePosition(session.accessToken, position.accountId, position.ticket, volume);
          await bot.sendMessage(chatId,
            `✅ ลดความเสี่ยงสำเร็จ\n${position.symbol} ${position.direction}\nปิด 50% (${volume} lots) จากบัญชี ${position.accountId}`
          );
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "close_half",
            status: "success",
            correlationId: position.ticket,
            payload: { accountId: position.accountId, symbol: position.symbol, volume },
          });
        } else if (pendingAction.action === "close_full") {
          await crmClient.closePosition(session.accessToken, position.accountId, position.ticket, position.volume);
          await bot.sendMessage(chatId,
            `✅ ปิดสถานะสำเร็จ\n${position.symbol} ${position.direction} ${position.volume} lots\nAccount: ${position.accountId}`
          );
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "close_full",
            status: "success",
            correlationId: position.ticket,
            payload: { accountId: position.accountId, symbol: position.symbol, volume: position.volume },
          });
        } else if (pendingAction.action === "move_sl_be") {
          await crmClient.modifyPosition(session.accessToken, position.accountId, position.ticket, {
            stopLoss: position.openPrice,
            takeProfit: position.takeProfit,
          });
          await bot.sendMessage(chatId,
            `🛡️ ป้องกันความเสี่ยงสำเร็จ\n${position.symbol} ${position.direction}\nStop Loss ถูกเลื่อนไปที่ Break-even ${formatUsd(position.openPrice)}`
          );
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "move_sl_be",
            status: "success",
            correlationId: position.ticket,
            payload: { accountId: position.accountId, symbol: position.symbol, stopLoss: position.openPrice },
          });
        } else if (pendingAction.action === "secure_profit") {
          const volume = Math.min(position.volume, Math.max(0.01, Math.round((position.volume / 2) * 100) / 100));
          await crmClient.closePosition(session.accessToken, position.accountId, position.ticket, volume);
          await crmClient.modifyPosition(session.accessToken, position.accountId, position.ticket, {
            stopLoss: position.openPrice,
            takeProfit: position.takeProfit,
          });
          await bot.sendMessage(chatId,
            `✅ ล็อกกำไรสำเร็จ\n${position.symbol} ${position.direction}\nปิด 50% (${volume} lots) และเลื่อน SL ไปที่ Break-even ${formatUsd(position.openPrice)}`
          );
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "secure_profit",
            status: "success",
            correlationId: position.ticket,
            payload: { accountId: position.accountId, symbol: position.symbol, volume, stopLoss: position.openPrice },
          });
        } else {
          await bot.sendMessage(chatId, "❌ ไม่รู้จัก action ที่เลือก");
        }
      } catch (err) {
        console.error("Position action error:", err.message);
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "position",
          action: pendingAction.action,
          status: "error",
          correlationId: position.ticket,
          payload: { error: err.message, accountId: position.accountId, symbol: position.symbol },
        });
        await bot.sendMessage(chatId, `❌ ดำเนินการกับสถานะไม่สำเร็จ: ${err.message}`);
      }

      tradePlanService.clearPositionState("telegram", userId);
      return;
    }

    // --- Cancel Position Action ---
    if (data === "cancel_pos_action") {
      const positionState = tradePlanService.getPositionState("telegram", userId);
      const pendingAction = positionState?.pendingAction;
      const position = pendingAction ? positionState?.positions?.[pendingAction.index] : null;
      if (pendingAction && position) {
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "position",
          action: pendingAction.action,
          status: "cancelled",
          correlationId: position.ticket,
          payload: { accountId: position.accountId, symbol: position.symbol },
        });
      }
      if (positionState) {
        delete positionState.pendingAction;
        tradePlanService.setPositionState("telegram", userId, positionState);
      }
      await bot.answerCallbackQuery(query.id, { text: "\u274C ยกเลิกแล้ว" });
      await bot.sendMessage(chatId, "\u274C ยกเลิกการจัดการสถานะแล้ว");
      return;
    }

    // ========== Deposit / Withdraw / Transfer Callbacks ==========

    // --- Payment Method Selection ---
    if (data.startsWith("txn_method:")) {
      const method = data.slice("txn_method:".length);
      const txnState = tradePlanService.getTxnState("telegram", userId);
      if (!txnState || txnState.step !== 'select_payment') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีรายการที่รอดำเนินการ" });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      txnState.paymentMethod = method;
      txnState.step = 'confirm';
      tradePlanService.setTxnState("telegram", userId, txnState);

      await showTxnConfirmation(bot, chatId, txnState);
      return;
    }

    // --- Transfer Type Selection ---
    if (data.startsWith("transfer_type:")) {
      const transferType = data.slice("transfer_type:".length);
      const txnState = tradePlanService.getTxnState("telegram", userId);
      if (!txnState || txnState.step !== 'select_transfer_type') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีรายการที่รอดำเนินการ" });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      txnState.transferType = transferType;

      // Ask user to select source wallet/account
      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        await bot.sendMessage(chatId, "\uD83D\uDD12 Session หมดอายุ กรุณา /login ใหม่");
        tradePlanService.clearTxnState("telegram", userId);
        return;
      }

      try {
        const accountsRes = await crmClient.getMemberAccounts(session.accessToken);
        const accounts = Array.isArray(accountsRes) ? accountsRes : (accountsRes?.data || accountsRes?.accounts || []);

        if (accounts.length === 0) {
          await bot.sendMessage(chatId, "\u274C ไม่พบบัญชี กรุณาติดต่อฝ่ายสนับสนุน");
          tradePlanService.clearTxnState("telegram", userId);
          return;
        }

        txnState.step = 'select_source';
        tradePlanService.setTxnState("telegram", userId, txnState);

        const keyboard = accounts.map(a => {
          const login = a.login || a.accountId || a.id || 'N/A';
          const balance = a.balance != null ? `$${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
          return [{ text: `${login} ${balance}`, callback_data: `txn_source:${a.walletId || a.login || a.accountId || a.id}` }];
        });
        keyboard.push([{ text: "\u274C ยกเลิก", callback_data: "cancel_txn" }]);

        await bot.sendMessage(chatId, "\uD83D\uDCBC เลือกบัญชีต้นทาง:", {
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (err) {
        console.error("Fetch accounts for transfer error:", err.message);
        await bot.sendMessage(chatId, "\u274C ไม่สามารถโหลดบัญชีได้: " + err.message);
        tradePlanService.clearTxnState("telegram", userId);
      }
      return;
    }

    // --- Transfer Source Selection ---
    if (data.startsWith("txn_source:")) {
      const sourceId = data.slice("txn_source:".length);
      const txnState = tradePlanService.getTxnState("telegram", userId);
      if (!txnState || txnState.step !== 'select_source') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีรายการที่รอดำเนินการ" });
        return;
      }

      await bot.answerCallbackQuery(query.id);
      txnState.sourceWalletId = sourceId;
      txnState.step = 'enter_amount';
      tradePlanService.setTxnState("telegram", userId, txnState);

      await bot.sendMessage(chatId, "\uD83D\uDCB0 กรุณาพิมพ์จำนวนเงินที่ต้องการโอน (USD):\nหรือพิมพ์ /cancel เพื่อยกเลิก");
      return;
    }

    // --- Confirm Transaction ---
    if (data === "confirm_txn") {
      const txnState = tradePlanService.getTxnState("telegram", userId);
      if (!txnState || txnState.step !== 'confirm') {
        await bot.answerCallbackQuery(query.id, { text: "ไม่มีรายการที่รอดำเนินการ" });
        return;
      }

      if (!crmClient || !authServiceRef) {
        await bot.answerCallbackQuery(query.id, { text: "ระบบยังไม่พร้อม" });
        return;
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: "Session หมดอายุ กรุณา /login ใหม่" });
        tradePlanService.clearTxnState("telegram", userId);
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: "กำลังดำเนินการ..." });

      try {
        let result;
        if (txnState.type === 'deposit') {
          result = await crmClient.memberDeposit(session.accessToken, txnState.amount, txnState.paymentMethod);
        } else if (txnState.type === 'withdraw') {
          result = await crmClient.memberWithdraw(session.accessToken, txnState.amount, txnState.paymentMethod);
        } else if (txnState.type === 'transfer') {
          result = await crmClient.memberTransfer(session.accessToken, txnState.amount, txnState.transferType, txnState.sourceWalletId);
        }

        const resData = result?.data || result;
        const txnId = resData?.transactionId || resData?.id || resData?.referenceId || '';
        const typeLabel = txnState.type === 'deposit' ? 'ฝากเงิน' : txnState.type === 'withdraw' ? 'ถอนเงิน' : 'โอนเงิน';
        const amountFmt = `$${Number(txnState.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        await bot.sendMessage(chatId,
          `\u2705 ${typeLabel}สำเร็จ\n` +
          (txnId ? `Ref: ${txnId}\n` : '') +
          `จำนวน: ${amountFmt}`
        );

        // Show payment instructions for deposits
        if (txnState.type === 'deposit') {
          await sendDepositPaymentInfo(bot, chatId, txnState.paymentMethod, txnState.amount, resData);
        }
      } catch (err) {
        console.error("Transaction error:", err.message);
        const typeLabel = txnState.type === 'deposit' ? 'ฝากเงิน' : txnState.type === 'withdraw' ? 'ถอนเงิน' : 'โอนเงิน';
        await bot.sendMessage(chatId, `\u274C ${typeLabel}ไม่สำเร็จ: ${err.message}`);
      }

      tradePlanService.clearTxnState("telegram", userId);
      return;
    }

    // --- Cancel Transaction ---
    if (data === "cancel_txn") {
      tradePlanService.clearTxnState("telegram", userId);
      await bot.answerCallbackQuery(query.id, { text: "\u274C ยกเลิกแล้ว" });
      await bot.sendMessage(chatId, "\u274C ยกเลิกรายการแล้ว");
      return;
    }

    await bot.answerCallbackQuery(query.id);
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

    // ========== Transaction Flow — intercept amount input ==========
    if (tradePlanService) {
      const positionState = tradePlanService.getPositionState("telegram", userId);
      if (positionState && text === "/cancel") {
        tradePlanService.clearPositionState("telegram", userId);
        return bot.sendMessage(chatId, "\u274C ยกเลิกการจัดการสถานะแล้ว");
      }

      if (positionState?.pendingAction?.action === 'edit_sl_tp') {
        const edit = parsePositionEditInput(text);
        const position = positionState.positions?.[positionState.pendingAction.index];

        if (!edit || !position) {
          return bot.sendMessage(chatId, "⚠️ รูปแบบไม่ถูกต้อง\nใช้เช่น sl=3345 tp=3375 หรือ sl=3345\nพิมพ์ /cancel เพื่อยกเลิก");
        }

        if (edit.stopLoss != null) {
          if (position.direction === 'BUY' && edit.stopLoss >= position.openPrice) {
            return bot.sendMessage(chatId, "⚠️ สำหรับ BUY ตำแหน่ง Stop Loss ควรต่ำกว่า Open Price");
          }
          if (position.direction === 'SELL' && edit.stopLoss <= position.openPrice) {
            return bot.sendMessage(chatId, "⚠️ สำหรับ SELL ตำแหน่ง Stop Loss ควรสูงกว่า Open Price");
          }
        }
        if (edit.takeProfit != null) {
          if (position.direction === 'BUY' && edit.takeProfit <= position.openPrice) {
            return bot.sendMessage(chatId, "⚠️ สำหรับ BUY ตำแหน่ง Take Profit ควรสูงกว่า Open Price");
          }
          if (position.direction === 'SELL' && edit.takeProfit >= position.openPrice) {
            return bot.sendMessage(chatId, "⚠️ สำหรับ SELL ตำแหน่ง Take Profit ควรต่ำกว่า Open Price");
          }
        }

        if (!crmClient || !authServiceRef) {
          return bot.sendMessage(chatId, "❌ ระบบเทรดยังไม่พร้อม");
        }

        const session = await authServiceRef.getSession("telegram", userId);
        if (!session) {
          tradePlanService.clearPositionState("telegram", userId);
          return bot.sendMessage(chatId, "\uD83D\uDD12 Session หมดอายุ กรุณา /login ใหม่");
        }

        try {
          await crmClient.modifyPosition(session.accessToken, position.accountId, position.ticket, {
            stopLoss: edit.stopLoss != null ? edit.stopLoss : position.stopLoss,
            takeProfit: edit.takeProfit != null ? edit.takeProfit : position.takeProfit,
          });
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "edit_sl_tp",
            status: "success",
            correlationId: position.ticket,
            payload: { accountId: position.accountId, symbol: position.symbol, ...edit },
          });
          tradePlanService.clearPositionState("telegram", userId);
          return bot.sendMessage(chatId,
            `✅ แก้ไข SL/TP สำเร็จ\n${position.symbol} ${position.direction}\n` +
            `SL: ${formatUsd(edit.stopLoss != null ? edit.stopLoss : position.stopLoss)} | ` +
            `TP: ${formatUsd(edit.takeProfit != null ? edit.takeProfit : position.takeProfit)}`
          );
        } catch (err) {
          recordExecutionEvent({
            platform: "telegram",
            userId,
            category: "position",
            action: "edit_sl_tp",
            status: "error",
            correlationId: position.ticket,
            payload: { error: err.message, accountId: position.accountId, symbol: position.symbol, ...edit },
          });
          return bot.sendMessage(chatId, `❌ แก้ไข SL/TP ไม่สำเร็จ: ${err.message}`);
        }
      }

      const txnState = tradePlanService.getTxnState("telegram", userId);

      if (txnState && text === "/cancel") {
        tradePlanService.clearTxnState("telegram", userId);
        return bot.sendMessage(chatId, "\u274C ยกเลิกรายการแล้ว");
      }

      // Step: waiting for amount (deposit/withdraw/transfer)
      if (txnState && txnState.step === 'enter_amount') {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
          return bot.sendMessage(chatId, "\u26A0\uFE0F กรุณาพิมพ์จำนวนเงินที่ถูกต้อง (เช่น 100, 500.50)\nหรือพิมพ์ /cancel เพื่อยกเลิก");
        }

        txnState.amount = amount;

        if (txnState.type === 'transfer') {
          // Transfer already has all info, go to confirm
          txnState.step = 'confirm';
          tradePlanService.setTxnState("telegram", userId, txnState);
          await showTxnConfirmation(bot, chatId, txnState);
        } else {
          // Deposit/withdraw: ask payment method
          txnState.step = 'select_payment';
          tradePlanService.setTxnState("telegram", userId, txnState);

          await bot.sendMessage(chatId, "\uD83D\uDCB3 เลือกช่องทาง:", {
            reply_markup: {
              inline_keyboard: [[
                { text: "Bank Transfer", callback_data: "txn_method:bank_transfer" },
                { text: "QR PromptPay", callback_data: "txn_method:promptpay" },
              ], [
                { text: "Crypto (USDT)", callback_data: "txn_method:crypto_usdt" },
                { text: "\u274C ยกเลิก", callback_data: "cancel_txn" },
              ]],
            },
          });
        }
        return;
      }
    }

    // ========== Order Execution Flow — intercept volume/price input ==========
    if (tradePlanService) {
      const orderState = tradePlanService.getOrderState("telegram", userId);

      if (orderState && text === "/cancel") {
        tradePlanService.clearOrderState("telegram", userId);
        return bot.sendMessage(chatId, "\u274C ยกเลิกคำสั่งเทรดแล้ว");
      }

      // Step: waiting for lot volume
      if (orderState && orderState.step === 'enter_volume') {
        const volume = parseFloat(text);
        if (isNaN(volume) || volume <= 0 || volume > 100) {
          return bot.sendMessage(chatId, "\u26A0\uFE0F กรุณาพิมพ์ขนาด Lot ที่ถูกต้อง (เช่น 0.01, 0.1, 1.0)\nหรือพิมพ์ /cancel เพื่อยกเลิก");
        }

        orderState.volume = volume;
        orderState.step = 'select_type';
        tradePlanService.setOrderState("telegram", userId, orderState);

        await bot.sendMessage(chatId, "เลือกประเภทคำสั่ง:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Market Order", callback_data: "order_type:MARKET" },
              { text: "Limit Order", callback_data: "order_type:LIMIT" },
              { text: "Stop Order", callback_data: "order_type:STOP" },
            ], [
              { text: "\u274C ยกเลิก", callback_data: "cancel_order" },
            ]],
          },
        });
        return;
      }

      // Step: waiting for price (limit/stop orders)
      if (orderState && orderState.step === 'enter_price') {
        const price = parseFloat(text);
        if (isNaN(price) || price <= 0) {
          return bot.sendMessage(chatId, "\u26A0\uFE0F กรุณาพิมพ์ราคาที่ถูกต้อง\nหรือพิมพ์ /cancel เพื่อยกเลิก");
        }

        orderState.price = price;
        orderState.step = 'confirm';
        tradePlanService.setOrderState("telegram", userId, orderState);

        await showOrderConfirmation(bot, chatId, orderState);
        return;
      }
    }

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

    // ========== Deposit / Withdraw / Transfer Commands ==========
    if (text === "/deposit" || text === "/withdraw" || text === "/transfer") {
      if (!crmClient || !authServiceRef) {
        return bot.sendMessage(chatId, "\u274C ระบบการเงินยังไม่พร้อมใช้งาน");
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        return bot.sendMessage(chatId, "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อน\nพิมพ์ /login เพื่อเข้าสู่ระบบ");
      }

      if (text === "/transfer") {
        // Transfer: ask for transfer type first
        tradePlanService.setTxnState("telegram", userId, {
          step: 'select_transfer_type',
          type: 'transfer',
          chatId: chatId,
        });

        return bot.sendMessage(chatId, "\uD83D\uDD04 เลือกประเภทการโอน:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "Wallet \u2192 MT5", callback_data: "transfer_type:wallet_to_mt5" },
              { text: "MT5 \u2192 Wallet", callback_data: "transfer_type:mt5_to_wallet" },
            ], [
              { text: "\u274C ยกเลิก", callback_data: "cancel_txn" },
            ]],
          },
        });
      }

      // Deposit or Withdraw: ask for amount directly
      const typeLabel = text === "/deposit" ? "ฝากเงิน" : "ถอนเงิน";
      tradePlanService.setTxnState("telegram", userId, {
        step: 'enter_amount',
        type: text.slice(1), // 'deposit' or 'withdraw'
        chatId: chatId,
      });

      return bot.sendMessage(chatId,
        `\uD83D\uDCB0 ${typeLabel}\n\nกรุณาพิมพ์จำนวนเงิน (USD):\n(เช่น 100, 500.50)\n\nพิมพ์ /cancel เพื่อยกเลิก`
      );
    }

    if (text === "/positions") {
      if (!crmClient || !authServiceRef) {
        return bot.sendMessage(chatId, "\u274C ระบบเทรดยังไม่พร้อมใช้งาน");
      }

      const session = await authServiceRef.getSession("telegram", userId);
      if (!session) {
        return bot.sendMessage(chatId, "\uD83D\uDD12 กรุณาเข้าสู่ระบบก่อน\nพิมพ์ /login เพื่อเข้าสู่ระบบ");
      }

      try {
        const positionsRes = await crmClient.getMemberPositions(session.accessToken);
        const rawPositions = positionsRes?.data
          ? (Array.isArray(positionsRes.data) ? positionsRes.data : (positionsRes.data.positions || []))
          : (Array.isArray(positionsRes) ? positionsRes : []);
        const positions = rawPositions.map(normalizePosition).filter(Boolean);

        if (positions.length === 0) {
          tradePlanService.clearPositionState("telegram", userId);
          return bot.sendMessage(chatId, "📭 ขณะนี้ไม่มีสถานะเปิดอยู่");
        }

        tradePlanService.setPositionState("telegram", userId, {
          positions,
          updatedAt: Date.now(),
        });
        recordExecutionEvent({
          platform: "telegram",
          userId,
          category: "position",
          action: "list_positions",
          status: "success",
          correlationId: null,
          payload: { count: positions.length },
        });

        await bot.sendMessage(chatId, `📌 Open Positions (${positions.length})\nเลือก action เพื่อลดความเสี่ยงหรือปิดสถานะ`);

        for (let i = 0; i < positions.length; i++) {
          const position = positions[i];
          const health = evaluatePositionHealth(position);
          const recommendedRow = [];
          if (position.pnl > 0) {
            recommendedRow.push({ text: "🛡️ Secure Profit", callback_data: `prepare_pos:secure_profit:${i}` });
          } else if (!position.stopLoss) {
            recommendedRow.push({ text: "🛡️ Move SL to BE", callback_data: `prepare_pos:move_sl_be:${i}` });
          }

          const inlineKeyboard = [[
            { text: "↘️ Close 50%", callback_data: `prepare_pos:close_half:${i}` },
            { text: "🛑 Close Full", callback_data: `prepare_pos:close_full:${i}` },
          ], [
            { text: "🛡️ Move SL to BE", callback_data: `prepare_pos:move_sl_be:${i}` },
            { text: "✏️ Edit SL/TP", callback_data: `prepare_pos:edit_sl_tp:${i}` },
          ]];
          if (recommendedRow.length > 0) {
            inlineKeyboard.unshift(recommendedRow);
          }

          await bot.sendMessage(chatId, buildPositionSummary(position, i), {
            reply_markup: {
              inline_keyboard: inlineKeyboard,
            },
          });
        }
      } catch (err) {
        console.error("Positions fetch error:", err.message);
        return bot.sendMessage(chatId, `❌ ไม่สามารถโหลดสถานะได้: ${err.message}`);
      }
      return;
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
        "\uD83D\uDCCA เปิด Trading Dashboard เพื่อดูราคาสด, วิเคราะห์ตลาด, ปฏิทินเศรษฐกิจ และอัตราแลกเปลี่ยน",
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
          `ผมคือ Jerry — AI Trading Analyst ของ Yellow Box Markets\n\n` +
          `\uD83D\uDD39 วิเคราะห์ตลาดด้วย TA, FA, Sentiment\n` +
          `\uD83D\uDD39 ดูราคาสด, ข่าว, แนวรับแนวต้าน\n` +
          `\uD83D\uDD39 สอนกลยุทธ์การเทรด\n\n` +
          `คำสั่ง:\n` +
          `/login — เข้าสู่ระบบ\n` +
          `/price [symbol] — ดูราคาสด\n` +
          `/analyze [symbol] — วิเคราะห์ตลาด\n` +
          `/news — ข่าวเศรษฐกิจวันนี้\n` +
          `/levels [symbol] — แนวรับแนวต้าน\n` +
          `/rate — อัตราแลกเปลี่ยน THB/USD\n` +
          `/dashboard — เปิด Trading Dashboard\n` +
          `/checklist — Pre-trade Checklist\n` +
          `/zones — Trade Setup Grading\n` +
          `/reset — เริ่มบทสนทนาใหม่`,
          startOpts
        );
      }
      if (text === "/checklist") {
        return sendTelegramMessage(bot, chatId,
          `\uD83D\uDCCB Pre-trade Checklist 5 ขั้นตอน\n\n` +
          `1\uFE0F\u20E3 TREND — HTF ทิศทางหลัก (Bullish/Bearish/Range?)\n` +
          `2\uFE0F\u20E3 LEVELS — แนวรับ/แนวต้านสำคัญ + Fibonacci\n` +
          `3\uFE0F\u20E3 CONFIRM — รอ confirmation (Candlestick pattern, Indicator signal)\n` +
          `4\uFE0F\u20E3 ENTRY — จุดเข้าเทรด Entry, SL, TP + คำนวณ R:R\n` +
          `5\uFE0F\u20E3 SIZE — คำนวณ Lot Size ตาม risk 1-2%`
        );
      }
      if (text === "/zones") {
        return sendTelegramMessage(bot, chatId,
          `\uD83D\uDCCA Trade Setup Grading\n\n` +
          `A+ \u2605\u2605\u2605\u2605\u2605 — Multi-TF confluence, 100% size, R:R \u2265 1:3\n` +
          `A  \u2605\u2605\u2605\u2605\u2606 — Strong confluence, 100% size, R:R \u2265 1:2\n` +
          `B  \u2605\u2605\u2605\u2606\u2606 — Moderate confluence, 75% size, R:R \u2265 1:2\n` +
          `C  \u2605\u2605\u2606\u2606\u2606 — Weak setup, 50% size, R:R \u2265 1:3\n` +
          `D  \u2605\u2606\u2606\u2606\u2606 — No confluence \u2192 SKIP`
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
        const setup = tradePlanService.resolveTradeSetup(
          reply,
          aiEngine.getLastTradeSetup("telegram", userId)
        );
        if (setup) {
          const plan = tradePlanService.createPending("telegram", userId, setup);
          const planButtons = [
            { text: "\u2705 บันทึกแผน", callback_data: `save_plan:${plan.id}` },
            { text: "\uD83D\uDCE4 ส่งคำสั่ง", callback_data: `execute_plan:${plan.id}` },
            { text: "\u274C ยกเลิก", callback_data: `cancel_plan:${plan.id}` },
          ];
          await sendTelegramMessage(bot, chatId, reply, {
            reply_markup: {
              inline_keyboard: [planButtons],
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
 * Show order confirmation summary with confirm/cancel buttons
 */
async function showOrderConfirmation(bot, chatId, state) {
  const preflight = evaluateOrderPreflight(state);

  const message = buildOrderConfirmationText(state, preflight);
  const actions = preflight.blockers.length > 0
    ? [[{ text: "\u274C ยกเลิก", callback_data: "cancel_order" }]]
    : [[
        { text: "\u2705 ยืนยันส่งคำสั่ง", callback_data: "confirm_order" },
        { text: "\u274C ยกเลิก", callback_data: "cancel_order" },
      ]];

  await bot.sendMessage(chatId, message, {
    reply_markup: {
      inline_keyboard: actions,
    },
  });
}

/**
 * Send deposit payment info (QR code, wallet address, bank details)
 * Uses CRM response data + env var fallbacks
 */
async function sendDepositPaymentInfo(bot, chatId, paymentMethod, amount, resData) {
  const amountFmt = `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (paymentMethod === 'promptpay') {
    // QR Code — from CRM response or env var
    const qrUrl = resData?.qrCodeUrl || resData?.qrCode || resData?.paymentUrl || process.env.DEPOSIT_PROMPTPAY_QR_URL;
    if (qrUrl) {
      try {
        await bot.sendPhoto(chatId, qrUrl, {
          caption: `\uD83D\uDCF1 สแกน QR PromptPay เพื่อฝากเงิน ${amountFmt}\n\n\u26A0\uFE0F กรุณาโอนตามจำนวนที่ระบุ\nระบบจะตรวจสอบและเครดิตอัตโนมัติ`,
        });
      } catch (err) {
        console.error("Send QR photo error:", err.message);
        await bot.sendMessage(chatId,
          `\uD83D\uDCF1 QR PromptPay สำหรับฝากเงิน ${amountFmt}\n` +
          `Link: ${qrUrl}\n\n\u26A0\uFE0F กรุณาโอนตามจำนวนที่ระบุ`
        );
      }
    } else {
      const promptpayId = process.env.DEPOSIT_PROMPTPAY_ID || '';
      await bot.sendMessage(chatId,
        `\uD83D\uDCF1 PromptPay สำหรับฝากเงิน ${amountFmt}\n` +
        (promptpayId ? `PromptPay ID: ${promptpayId}\n` : '') +
        `\n\u26A0\uFE0F กรุณาโอนตามจำนวนที่ระบุ แล้วรอระบบตรวจสอบ`
      );
    }
  } else if (paymentMethod === 'crypto_usdt') {
    // Crypto wallet address — from CRM response or env var
    const walletAddress = resData?.walletAddress || resData?.depositAddress || process.env.DEPOSIT_USDT_WALLET;
    const network = resData?.network || process.env.DEPOSIT_USDT_NETWORK || 'TRC-20';

    if (walletAddress) {
      await bot.sendMessage(chatId,
        `\uD83D\uDCB0 USDT Wallet สำหรับฝากเงิน ${amountFmt}\n\n` +
        `Network: ${network}\n` +
        `Address:\n\`${walletAddress}\`\n\n` +
        `\u26A0\uFE0F ส่งเฉพาะ USDT ผ่าน ${network} เท่านั้น\nการส่งเหรียญอื่นหรือผิด Network อาจทำให้สูญหาย`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId,
        `\uD83D\uDCB0 กรุณาติดต่อฝ่ายสนับสนุนเพื่อรับที่อยู่ Wallet สำหรับฝาก USDT`
      );
    }
  } else if (paymentMethod === 'bank_transfer') {
    // Bank details — from CRM response or env var
    const bankName = resData?.bankName || process.env.DEPOSIT_BANK_NAME || '';
    const bankAccount = resData?.bankAccount || resData?.accountNumber || process.env.DEPOSIT_BANK_ACCOUNT || '';
    const bankAccountName = resData?.bankAccountName || process.env.DEPOSIT_BANK_ACCOUNT_NAME || '';

    if (bankAccount) {
      await bot.sendMessage(chatId,
        `\uD83C\uDFE6 โอนเงินผ่านธนาคารสำหรับฝากเงิน ${amountFmt}\n\n` +
        (bankName ? `ธนาคาร: ${bankName}\n` : '') +
        `เลขบัญชี: ${bankAccount}\n` +
        (bankAccountName ? `ชื่อบัญชี: ${bankAccountName}\n` : '') +
        `\n\u26A0\uFE0F กรุณาโอนตามจำนวนที่ระบุ แล้วรอระบบตรวจสอบ`
      );
    } else {
      await bot.sendMessage(chatId,
        `\uD83C\uDFE6 กรุณาติดต่อฝ่ายสนับสนุนเพื่อรับข้อมูลบัญชีธนาคารสำหรับฝากเงิน`
      );
    }
  }
}

/**
 * Show transaction confirmation summary
 */
async function showTxnConfirmation(bot, chatId, txnState) {
  const amountFmt = `$${Number(txnState.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let summary;

  if (txnState.type === 'deposit') {
    const methodLabel = { bank_transfer: 'Bank Transfer', promptpay: 'QR PromptPay', crypto_usdt: 'Crypto (USDT)' }[txnState.paymentMethod] || txnState.paymentMethod;
    summary = `\u26A0\uFE0F ยืนยันการฝากเงิน\n\nจำนวน: ${amountFmt}\nช่องทาง: ${methodLabel}`;
  } else if (txnState.type === 'withdraw') {
    const methodLabel = { bank_transfer: 'Bank Transfer', promptpay: 'QR PromptPay', crypto_usdt: 'Crypto (USDT)' }[txnState.paymentMethod] || txnState.paymentMethod;
    summary = `\u26A0\uFE0F ยืนยันการถอนเงิน\n\nจำนวน: ${amountFmt}\nช่องทาง: ${methodLabel}`;
  } else if (txnState.type === 'transfer') {
    const typeLabel = { wallet_to_mt5: 'Wallet \u2192 MT5', mt5_to_wallet: 'MT5 \u2192 Wallet' }[txnState.transferType] || txnState.transferType;
    summary = `\u26A0\uFE0F ยืนยันการโอนเงิน\n\nจำนวน: ${amountFmt}\nประเภท: ${typeLabel}\nบัญชีต้นทาง: ${txnState.sourceWalletId}`;
  }

  await bot.sendMessage(chatId, summary, {
    reply_markup: {
      inline_keyboard: [[
        { text: "\u2705 ยืนยัน", callback_data: "confirm_txn" },
        { text: "\u274C ยกเลิก", callback_data: "cancel_txn" },
      ]],
    },
  });
}

/**
 * Set additional dependencies after initialization
 */
setupTelegram.setDependencies = function (deps) {
  if (deps.guardianService) guardianService = deps.guardianService;
  if (deps.tradePlanService) tradePlanService = deps.tradePlanService;
  if (deps.crmClient) crmClient = deps.crmClient;
  if (deps.authService) authServiceRef = deps.authService;
  if (deps.executionAuditService) executionAuditService = deps.executionAuditService;
};
setupTelegram.evaluateOrderPreflight = evaluateOrderPreflight;
setupTelegram.buildOrderConfirmationText = buildOrderConfirmationText;
setupTelegram.normalizePosition = normalizePosition;
setupTelegram.evaluatePositionHealth = evaluatePositionHealth;
setupTelegram.buildPositionActionPreview = buildPositionActionPreview;
setupTelegram.buildPositionSummary = buildPositionSummary;
setupTelegram.estimateLotSizes = estimateLotSizes;
setupTelegram.buildSizingGuidance = buildSizingGuidance;
setupTelegram.parsePositionEditInput = parsePositionEditInput;

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
