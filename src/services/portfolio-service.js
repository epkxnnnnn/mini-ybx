/**
 * Portfolio Service — Shared portfolio calculation
 * Extracted from server.js /api/webapp/portfolio route
 */

/**
 * Calculate portfolio metrics from raw CRM account + position data
 * @param {Object} crmClient - CRM client instance
 * @param {string} accessToken - Member's access token
 * @returns {Object} Portfolio data with metrics, positions, recommendations
 */
async function calculatePortfolio(crmClient, accessToken) {
  const [accountsRes, positionsRes] = await Promise.all([
    crmClient.getMemberAccounts(accessToken).catch(() => ({ data: [] })),
    crmClient.getMemberPositions(accessToken).catch(() => ({ data: [] })),
  ]);

  const accounts = accountsRes?.data
    ? (Array.isArray(accountsRes.data) ? accountsRes.data : (accountsRes.data.accounts || []))
    : [];
  const positions = positionsRes?.data
    ? (Array.isArray(positionsRes.data) ? positionsRes.data : (positionsRes.data.positions || []))
    : [];

  // Calculate totals
  const totalBalance = accounts.reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
  const totalEquity = accounts.reduce((s, a) => s + (parseFloat(a.equity) || parseFloat(a.balance) || 0), 0);
  const totalMargin = accounts.reduce((s, a) => s + (parseFloat(a.margin) || 0), 0);
  const freeMargin = totalEquity - totalMargin;
  const marginLevel = totalMargin > 0 ? (totalEquity / totalMargin) * 100 : 9999;

  // Health score (0-100)
  let healthScore = 100;
  if (marginLevel < 150) healthScore -= 40;
  else if (marginLevel < 300) healthScore -= 20;
  else if (marginLevel < 500) healthScore -= 10;

  const drawdown = totalBalance > 0 ? ((totalBalance - totalEquity) / totalBalance) * 100 : 0;
  if (drawdown > 20) healthScore -= 30;
  else if (drawdown > 10) healthScore -= 15;
  else if (drawdown > 5) healthScore -= 5;

  // Diversification: unique symbols in positions
  const symbols = [...new Set(positions.map(p => p.symbol || ''))];
  if (symbols.length <= 1 && positions.length > 0) healthScore -= 15;
  else if (symbols.length <= 2 && positions.length > 2) healthScore -= 10;

  healthScore = Math.max(0, Math.min(100, healthScore));

  // Risk breakdown by symbol
  const riskBySymbol = {};
  positions.forEach(p => {
    const sym = p.symbol || 'Unknown';
    if (!riskBySymbol[sym]) riskBySymbol[sym] = { volume: 0, pnl: 0, count: 0 };
    riskBySymbol[sym].volume += parseFloat(p.volume || p.lots || 0);
    riskBySymbol[sym].pnl += parseFloat(p.profit || p.pnl || 0);
    riskBySymbol[sym].count++;
  });

  // AI Recommendations
  const recommendations = [];
  if (marginLevel < 200 && totalMargin > 0) recommendations.push("ระดับ Margin ต่ำ — ควรลดขนาดสถานะหรือเติมเงิน");
  if (drawdown > 10) recommendations.push("Drawdown สูง " + drawdown.toFixed(1) + "% — ควรตรวจสอบ Stop Loss");
  Object.entries(riskBySymbol).forEach(([sym, data]) => {
    if (data.volume > 1 && data.pnl < -50) recommendations.push(`ลด exposure ${sym} — ขาดทุน $${Math.abs(data.pnl).toFixed(0)}`);
  });
  positions.forEach(p => {
    if (!p.sl && !p.stopLoss) recommendations.push(`ตั้ง Stop Loss สำหรับ ${p.symbol || 'position'}`);
  });
  if (!recommendations.length) recommendations.push("พอร์ตอยู่ในเกณฑ์ดี — ไม่มีคำแนะนำเร่งด่วน");

  return {
    totalBalance,
    totalEquity,
    freeMargin,
    marginLevel: marginLevel > 9000 ? null : Math.round(marginLevel),
    healthScore,
    drawdown: parseFloat(drawdown.toFixed(2)),
    positions: positions.map(p => ({
      symbol: p.symbol,
      direction: (p.type || p.direction || '').toUpperCase().includes('BUY') ? 'BUY' : 'SELL',
      volume: parseFloat(p.volume || p.lots || 0),
      pnl: parseFloat(p.profit || p.pnl || 0),
      sl: p.sl || p.stopLoss || null,
      tp: p.tp || p.takeProfit || null,
      openPrice: parseFloat(p.openPrice || p.entryPrice || 0),
    })),
    riskBySymbol,
    recommendations,
  };
}

module.exports = { calculatePortfolio };
