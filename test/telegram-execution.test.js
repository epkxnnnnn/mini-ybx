const test = require('node:test');
const assert = require('node:assert/strict');

const setupTelegram = require('../src/bots/telegram');

test('evaluateOrderPreflight blocks invalid buy structure and critical margin', () => {
  const result = setupTelegram.evaluateOrderPreflight({
    plan: {
      symbol: 'XAUUSD',
      direction: 'BUY',
      entry: 3350,
      sl: 3360,
      tp: 3370,
      riskReward: '1:1.0',
    },
    volume: 1,
    orderType: 'MARKET',
    account: {
      login: '1001',
      balance: 1000,
      equity: 900,
      margin: 700,
      freeMargin: 50,
    },
  });

  assert.equal(result.blockers.some((item) => item.includes('โครงสร้าง BUY setup ไม่ถูกต้อง')), true);
  assert.equal(result.blockers.some((item) => item.includes('Margin Level ต่ำมาก')), true);
  assert.equal(result.warnings.some((item) => item.includes('R:R ต่ำ')), true);
});

test('evaluateOrderPreflight warns on low margin, low free margin, and large lot', () => {
  const result = setupTelegram.evaluateOrderPreflight({
    plan: {
      symbol: 'EURUSD',
      direction: 'SELL',
      entry: 1.085,
      sl: 1.09,
      tp: 1.075,
      riskReward: '1:2.0',
    },
    volume: 5,
    orderType: 'MARKET',
    account: {
      login: '1002',
      balance: 2000,
      equity: 1200,
      margin: 500,
      freeMargin: 100,
    },
  });

  assert.deepEqual(result.blockers, []);
  assert.equal(result.warnings.some((item) => item.includes('Margin Level ค่อนข้างตึง')), true);
  assert.equal(result.warnings.some((item) => item.includes('Free Margin เหลือน้อย')), true);
  assert.equal(result.warnings.some((item) => item.includes('Lot ค่อนข้างใหญ่')), true);
});

test('buildOrderConfirmationText includes warnings and blockers', () => {
  const text = setupTelegram.buildOrderConfirmationText(
    {
      accountLogin: '1003',
      volume: 0.5,
      orderType: 'LIMIT',
      price: 3348,
      plan: {
        symbol: 'XAUUSD',
        direction: 'BUY',
        entry: 3350,
        sl: 3340,
        tp: 3370,
      },
    },
    {
      account: {
        balance: 5000,
        equity: 4500,
        freeMargin: 900,
        marginLevel: 220,
      },
      warnings: ['Margin Level ค่อนข้างตึง (220%)'],
      blockers: ['Pending order ต้องมีราคาที่ถูกต้อง'],
    }
  );

  assert.match(text, /ข้อมูลบัญชีก่อนส่งคำสั่ง/);
  assert.match(text, /คำเตือนก่อนส่งคำสั่ง/);
  assert.match(text, /รายการที่ต้องแก้ก่อนส่งคำสั่ง/);
});

test('normalizePosition extracts tradable position fields', () => {
  const position = setupTelegram.normalizePosition({
    accountId: 1001,
    ticket: 555,
    symbol: 'XAUUSD',
    type: 'BUY',
    volume: '0.50',
    profit: '42.5',
    openPrice: '3350',
    sl: '3340',
    tp: '3370',
  });

  assert.deepEqual(position, {
    accountId: '1001',
    ticket: '555',
    symbol: 'XAUUSD',
    direction: 'BUY',
    volume: 0.5,
    pnl: 42.5,
    openPrice: 3350,
    stopLoss: 3340,
    takeProfit: 3370,
  });
});

test('buildPositionActionPreview shows action-specific text', () => {
  const position = {
    accountId: '1001',
    ticket: '555',
    symbol: 'XAUUSD',
    direction: 'SELL',
    volume: 1,
    pnl: -12,
    openPrice: 3350,
    stopLoss: 3360,
    takeProfit: 3330,
  };

  assert.match(setupTelegram.buildPositionActionPreview(position, 'close_half'), /Close 50%/);
  assert.match(setupTelegram.buildPositionActionPreview(position, 'close_full'), /Close full/);
  assert.match(setupTelegram.buildPositionActionPreview(position, 'move_sl_be'), /Break-even/);
  assert.match(setupTelegram.buildPositionActionPreview(position, 'secure_profit'), /Close 50%/);
  assert.match(setupTelegram.buildPositionActionPreview(position, 'secure_profit'), /Break-even/);
});

test('evaluatePositionHealth marks profitable protected positions as healthy', () => {
  const health = setupTelegram.evaluatePositionHealth({
    pnl: 120,
    stopLoss: 3340,
    takeProfit: 3370,
  });

  assert.equal(health.level, 'healthy');
  assert.equal(health.recommendations.some((item) => item.includes('ล็อกกำไร')), true);
});

test('evaluatePositionHealth marks unprotected losing positions as risk', () => {
  const health = setupTelegram.evaluatePositionHealth({
    pnl: -80,
    stopLoss: null,
    takeProfit: null,
  });

  assert.equal(health.level, 'risk');
  assert.equal(health.recommendations.some((item) => item.includes('ตั้ง Stop Loss')), true);
});

test('parsePositionEditInput extracts SL and TP values', () => {
  assert.deepEqual(
    setupTelegram.parsePositionEditInput('sl=3345 tp=3375'),
    { stopLoss: 3345, takeProfit: 3375 }
  );
  assert.deepEqual(
    setupTelegram.parsePositionEditInput('tp=3375'),
    { stopLoss: null, takeProfit: 3375 }
  );
});

test('estimateLotSizes returns conservative suggestions for supported symbols', () => {
  const sizing = setupTelegram.estimateLotSizes(
    { symbol: 'XAUUSD', entry: 3350, sl: 3345 },
    { equity: 5000 }
  );

  assert.equal(sizing.symbol, 'XAUUSD');
  assert.equal(sizing.suggestions[0].riskPct, 1);
  assert.equal(sizing.suggestions[0].lot, 0.1);
  assert.equal(sizing.suggestions[1].riskPct, 2);
  assert.equal(sizing.suggestions[1].lot, 0.2);
});

test('estimateLotSizes returns null for unsupported symbols', () => {
  assert.equal(
    setupTelegram.estimateLotSizes(
      { symbol: 'BTCUSD', entry: 60000, sl: 59000 },
      { equity: 5000 }
    ),
    null
  );
});

test('evaluateOrderPreflight warns when volume materially exceeds suggested range', () => {
  const result = setupTelegram.evaluateOrderPreflight({
    plan: {
      symbol: 'XAUUSD',
      direction: 'BUY',
      entry: 3350,
      sl: 3345,
      tp: 3365,
      riskReward: '1:3.0',
    },
    volume: 0.5,
    orderType: 'MARKET',
    sizing: {
      suggestions: [{ riskPct: 1, lot: 0.1 }, { riskPct: 2, lot: 0.2 }],
    },
    account: {
      login: '1002',
      balance: 5000,
      equity: 5000,
      margin: 1000,
      freeMargin: 3500,
    },
  });

  assert.equal(result.warnings.some((item) => item.includes('Lot สูงกว่าช่วงแนะนำ')), true);
});
