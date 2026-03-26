const test = require('node:test');
const assert = require('node:assert/strict');

function loadMarginMonitorWithEnv(envOverrides = {}) {
  const modulePath = require.resolve('../src/jobs/margin-monitor');
  const previous = {
    MARGIN_DANGER_LEVEL: process.env.MARGIN_DANGER_LEVEL,
    MARGIN_SAFE_LEVEL: process.env.MARGIN_SAFE_LEVEL,
    MARGIN_POLL_INTERVAL_MS: process.env.MARGIN_POLL_INTERVAL_MS,
    MARGIN_ALERT_COOLDOWN_MS: process.env.MARGIN_ALERT_COOLDOWN_MS,
  };

  Object.assign(process.env, envOverrides);
  delete require.cache[modulePath];
  const mod = require('../src/jobs/margin-monitor');

  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[modulePath];
  return mod;
}

test('margin monitor defaults expose expected thresholds and zones', () => {
  const marginMonitor = loadMarginMonitorWithEnv({
    MARGIN_DANGER_LEVEL: '',
    MARGIN_SAFE_LEVEL: '',
    MARGIN_POLL_INTERVAL_MS: '',
    MARGIN_ALERT_COOLDOWN_MS: '',
  });

  assert.equal(marginMonitor.ZONE_DANGER, 150);
  assert.equal(marginMonitor.ZONE_CAUTION, 300);
  assert.equal(marginMonitor.getZone(149), 'danger');
  assert.equal(marginMonitor.getZone(200), 'caution');
  assert.equal(marginMonitor.getZone(301), 'safe');
});

test('margin monitor honors valid env overrides', () => {
  const marginMonitor = loadMarginMonitorWithEnv({
    MARGIN_DANGER_LEVEL: '175',
    MARGIN_SAFE_LEVEL: '350',
    MARGIN_POLL_INTERVAL_MS: '15000',
    MARGIN_ALERT_COOLDOWN_MS: '60000',
  });

  assert.equal(marginMonitor.ZONE_DANGER, 175);
  assert.equal(marginMonitor.ZONE_CAUTION, 350);
  assert.equal(marginMonitor.POLL_INTERVAL, 15000);
  assert.equal(marginMonitor.ALERT_COOLDOWN, 60000);
});
