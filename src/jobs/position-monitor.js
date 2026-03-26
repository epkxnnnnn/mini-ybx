const { log } = require('../services/logger');

function getEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const POLL_INTERVAL = getEnvNumber('POSITION_POLL_INTERVAL_MS', 120_000);
const ALERT_COOLDOWN = getEnvNumber('POSITION_ALERT_COOLDOWN_MS', 30 * 60 * 1000);
const BREAK_EVEN_PNL = getEnvNumber('POSITION_BE_PNL_THRESHOLD', 25);
const SECURE_PROFIT_PNL = getEnvNumber('POSITION_SECURE_PROFIT_PNL_THRESHOLD', 50);
const LOSS_ALERT_PNL = getEnvNumber('POSITION_LOSS_ALERT_THRESHOLD', -50);

function toNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function evaluateFollowUpActions(position) {
  const actions = [];

  if (position.pnl >= BREAK_EVEN_PNL && !position.stopLoss) {
    actions.push('move_sl_be');
  }
  if (position.pnl >= SECURE_PROFIT_PNL) {
    actions.push('secure_profit');
  }
  if (position.pnl <= LOSS_ALERT_PNL) {
    actions.push('close_half');
  }

  return actions;
}

function getSuggestionMessage(position, action) {
  if (action === 'move_sl_be') {
    return (
      `🛡️ Jerry AI ติดตามสถานะ\n` +
      `${position.symbol} ${position.direction} มีกำไร ${position.pnl >= 0 ? '+' : ''}$${position.pnl.toFixed(2)}\n` +
      `แนะนำ: เลื่อน Stop Loss ไปที่ Break-even เพื่อป้องกันกำไร`
    );
  }
  if (action === 'secure_profit') {
    return (
      `✅ Jerry AI ติดตามสถานะ\n` +
      `${position.symbol} ${position.direction} มีกำไร ${position.pnl >= 0 ? '+' : ''}$${position.pnl.toFixed(2)}\n` +
      `แนะนำ: ปิด 50% และเลื่อน SL ไปที่ Break-even เพื่อล็อกกำไร`
    );
  }
  return (
    `⚠️ Jerry AI ติดตามสถานะ\n` +
    `${position.symbol} ${position.direction} ขาดทุน $${Math.abs(position.pnl).toFixed(2)}\n` +
    `แนะนำ: ลดความเสี่ยงโดยปิดบางส่วนหรือตรวจสอบ Stop Loss`
  );
}

function getCooldownKey(platform, userId, ticket, action) {
  return `${platform}:${userId}:${ticket}:${action}`;
}

function startPositionMonitor({
  authService,
  crmClient,
  tradePlanService,
  telegramBot,
  lineClient,
  auditService,
  stateRepository,
}) {
  if (!authService || !crmClient || !tradePlanService) {
    log('warn', 'position_monitor_skipped', { reason: 'missing_dependencies' });
    return null;
  }

  const alertStates = new Map();
  const status = {
    running: true,
    pollIntervalMs: POLL_INTERVAL,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastScannedSessions: 0,
    suggestionsSent: 0,
  };

  async function persistStatus() {
    if (!stateRepository?.enabled) return;
    await stateRepository.set('jobs:status', 'position-monitor', status);
  }

  async function sendSuggestion(platform, userId, positions, index, action) {
    const position = positions[index];
    if (!position) return;

    const message = getSuggestionMessage(position, action);
    if (platform === 'telegram' && telegramBot) {
      tradePlanService.setPositionState('telegram', userId, {
        positions,
        updatedAt: Date.now(),
        source: 'position-monitor',
      });

      const actionLabel = action === 'move_sl_be'
        ? '🛡️ Move SL to BE'
        : action === 'secure_profit'
          ? '✅ Secure Profit'
          : '↘️ Close 50%';
      await telegramBot.sendMessage(userId, message, {
        reply_markup: {
          inline_keyboard: [[
            { text: actionLabel, callback_data: `prepare_pos:${action}:${index}` },
          ]],
        },
      });
    } else if (platform === 'line' && lineClient) {
      await lineClient.pushMessage({
        to: userId,
        messages: [{ type: 'text', text: `${message}\n\nใช้ Telegram เพื่อจัดการสถานะขั้นสูง` }],
      });
    }

    status.suggestionsSent += 1;
    if (auditService) {
      await auditService.record({
        platform,
        userId,
        category: 'position_monitor',
        action,
        status: 'suggested',
        correlationId: position.ticket,
        payload: { accountId: position.accountId, symbol: position.symbol, pnl: position.pnl },
      });
    }
  }

  async function pollAll() {
    status.lastRunAt = new Date().toISOString();
    status.lastScannedSessions = 0;

    try {
      for (const [sessionKey] of authService.sessions) {
        const [platform, ...userIdParts] = sessionKey.split(':');
        const userId = userIdParts.join(':');
        status.lastScannedSessions += 1;

        try {
          const session = await authService.getSession(platform, userId);
          if (!session) continue;

          const positionsRes = await crmClient.getMemberPositions(session.accessToken);
          const rawPositions = positionsRes?.data
            ? (Array.isArray(positionsRes.data) ? positionsRes.data : (positionsRes.data.positions || []))
            : (Array.isArray(positionsRes) ? positionsRes : []);
          const positions = rawPositions.map(normalizePosition).filter(Boolean);

          for (let i = 0; i < positions.length; i++) {
            const position = positions[i];
            const actions = evaluateFollowUpActions(position);
            for (const action of actions) {
              const cooldownKey = getCooldownKey(platform, userId, position.ticket, action);
              const lastAlertAt = alertStates.get(cooldownKey) || 0;
              if (Date.now() - lastAlertAt < ALERT_COOLDOWN) continue;

              await sendSuggestion(platform, userId, positions, i, action);
              alertStates.set(cooldownKey, Date.now());
            }
          }
        } catch (err) {
          log('warn', 'position_monitor_session_error', { sessionKey, error: err.message });
        }
      }

      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
    } catch (err) {
      status.lastError = err.message;
      log('error', 'position_monitor_error', { error: err.message });
    }

    await persistStatus().catch((err) => {
      log('warn', 'position_monitor_status_persist_error', { error: err.message });
    });
  }

  let timer = null;
  async function scheduleNext() {
    try {
      await pollAll();
    } catch (err) {
      log('error', 'position_monitor_poll_error', { error: err.message });
    }
    timer = setTimeout(scheduleNext, POLL_INTERVAL);
  }
  timer = setTimeout(scheduleNext, POLL_INTERVAL);
  log('info', 'position_monitor_started', { pollIntervalMs: POLL_INTERVAL });

  return {
    get timer() { return timer; },
    pollAll,
    status,
    alertStates,
  };
}

module.exports = {
  startPositionMonitor,
  evaluateFollowUpActions,
  normalizePosition,
  getSuggestionMessage,
  POLL_INTERVAL,
  ALERT_COOLDOWN,
  BREAK_EVEN_PNL,
  SECURE_PROFIT_PNL,
  LOSS_ALERT_PNL,
};
