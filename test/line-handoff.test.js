const test = require('node:test');
const assert = require('node:assert/strict');

const setupLINE = require('../src/bots/line');

test('buildTelegramHandoffText references Telegram execution flow', () => {
  const previous = process.env.TELEGRAM_BOT_URL;
  process.env.TELEGRAM_BOT_URL = 'https://t.me/jerry_test_bot';

  const text = setupLINE.buildTelegramHandoffText('positions');
  assert.match(text, /Telegram/);
  assert.match(text, /จัดการสถานะเปิด/);
  assert.match(text, /https:\/\/t\.me\/jerry_test_bot/);

  if (previous === undefined) delete process.env.TELEGRAM_BOT_URL;
  else process.env.TELEGRAM_BOT_URL = previous;
});

test('buildLineTradeSetupHandoff includes save and telegram quick replies', () => {
  const previous = process.env.TELEGRAM_BOT_USERNAME;
  process.env.TELEGRAM_BOT_USERNAME = 'jerry_test_bot';

  const message = setupLINE.buildLineTradeSetupHandoff('plan-123', 'trade setup');
  const labels = message.quickReply.items.map((item) => item.action.label);

  assert.equal(message.type, 'text');
  assert.match(message.text, /trade setup/);
  assert.match(message.text, /https:\/\/t\.me\/jerry_test_bot/);
  assert.deepEqual(labels, ['✅ บันทึกแผน', '📲 ไป Telegram', '❌ ยกเลิก']);

  if (previous === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
  else process.env.TELEGRAM_BOT_USERNAME = previous;
});
