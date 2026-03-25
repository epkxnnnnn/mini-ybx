/**
 * Margin Monitor — Proactive margin alert scheduler
 * Polls authenticated sessions, detects margin zone changes, pushes alerts
 */

const POLL_INTERVAL = parseInt(process.env.MARGIN_POLL_INTERVAL_MS, 10) || 60_000;
const ALERT_COOLDOWN = 30 * 60 * 1000; // 30 min cooldown per zone transition

// Margin zone thresholds
const ZONE_DANGER = 150;
const ZONE_CAUTION = 300;

function getZone(marginLevel) {
  if (marginLevel < ZONE_DANGER) return 'danger';
  if (marginLevel <= ZONE_CAUTION) return 'caution';
  return 'safe';
}

function zoneWorsened(oldZone, newZone) {
  const severity = { safe: 0, caution: 1, danger: 2 };
  return severity[newZone] > severity[oldZone];
}

/**
 * Start the margin monitoring loop
 * @param {Object} opts
 * @param {Object} opts.authService - AuthService instance
 * @param {Object} opts.crmClient - CRMClient instance
 * @param {Object} opts.guardianService - GuardianService instance
 * @param {Object|null} opts.telegramBot - Telegram bot instance
 * @param {Object|null} opts.lineClient - LINE client instance
 */
function startMarginMonitor({ authService, crmClient, guardianService, telegramBot, lineClient }) {
  if (!authService || !crmClient) {
    console.log("[Margin Monitor] Auth or CRM not configured, skipping");
    return null;
  }

  // Alert state: "platform:userId" → { lastZone, lastAlertTime, marginLevel }
  const alertStates = new Map();

  async function pollAll() {
    for (const [sessionKey, session] of authService.sessions) {
      try {
        // sessionKey format: "platform:userId"
        const [platform, ...userIdParts] = sessionKey.split(':');
        const userId = userIdParts.join(':');

        // Refresh token if needed
        const freshSession = await authService.getSession(platform, userId);
        if (!freshSession) continue;

        // Fetch fresh account data
        const accountsRes = await crmClient.getMemberAccounts(freshSession.accessToken);
        const accounts = accountsRes?.data
          ? (Array.isArray(accountsRes.data) ? accountsRes.data : (accountsRes.data.accounts || []))
          : [];

        const totalEquity = accounts.reduce((s, a) => s + (parseFloat(a.equity) || parseFloat(a.balance) || 0), 0);
        const totalMargin = accounts.reduce((s, a) => s + (parseFloat(a.margin) || 0), 0);
        const marginLevel = totalMargin > 0 ? (totalEquity / totalMargin) * 100 : 9999;

        const newZone = getZone(marginLevel);
        const alertState = alertStates.get(sessionKey) || { lastZone: 'safe', lastAlertTime: 0, marginLevel: 9999 };

        // Update guardian mode based on margin level
        if (marginLevel < ZONE_DANGER) {
          guardianService.activate(platform, userId);
        } else if (marginLevel > ZONE_CAUTION) {
          const wasActive = guardianService.isActive(platform, userId);
          guardianService.deactivate(platform, userId);
          if (wasActive) {
            await sendAlert(platform, userId, buildRecoveryMessage(marginLevel));
          }
        }

        // Check if zone worsened and cooldown elapsed
        if (zoneWorsened(alertState.lastZone, newZone)) {
          const now = Date.now();
          if (now - alertState.lastAlertTime > ALERT_COOLDOWN) {
            await sendAlert(platform, userId, buildAlertMessage(marginLevel, newZone));
            alertState.lastAlertTime = now;
          }
        }

        alertState.lastZone = newZone;
        alertState.marginLevel = marginLevel;
        alertStates.set(sessionKey, alertState);
      } catch (err) {
        // Skip this user, continue loop — never crash the scheduler
        console.warn(`[Margin Monitor] Error for ${sessionKey}:`, err.message);
      }
    }
  }

  function buildAlertMessage(marginLevel, zone) {
    const zoneName = zone === 'danger' ? 'อันตราย (Danger)' : 'ระวัง (Caution)';
    const recommendation = zone === 'danger'
      ? 'ควรลดขนาดสถานะหรือปิดออเดอร์ที่ขาดทุนทันที'
      : 'ควรตรวจสอบสถานะและตั้ง Stop Loss';

    return (
      `\u26A0\uFE0F Jerry AI แจ้งเตือน\n` +
      `Margin Level ลดลงเหลือ ${Math.round(marginLevel)}% — โซน${zoneName}\n` +
      `แนะนำ: ${recommendation}`
    );
  }

  function buildRecoveryMessage(marginLevel) {
    return (
      `\u2705 Jerry AI แจ้งเตือน\n` +
      `Margin Level กลับสู่ระดับปลอดภัย ${Math.round(marginLevel)}%\n` +
      `Guardian Mode ถูกปิดแล้ว`
    );
  }

  async function sendAlert(platform, userId, message) {
    try {
      if (platform === 'telegram' && telegramBot) {
        await telegramBot.sendMessage(userId, message);
      } else if (platform === 'line' && lineClient) {
        await lineClient.pushMessage({ to: userId, messages: [{ type: 'text', text: message }] });
      }
    } catch (err) {
      console.warn(`[Margin Monitor] Failed to send alert to ${platform}:${userId}:`, err.message);
    }
  }

  const timer = setInterval(pollAll, POLL_INTERVAL);
  console.log(`\u2705 Margin monitor started (interval: ${POLL_INTERVAL / 1000}s)`);

  return { timer, pollAll, alertStates };
}

module.exports = { startMarginMonitor };
