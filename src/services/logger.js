const crypto = require('crypto');

function createRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: 'unserializable' });
  }
}

function log(level, event, meta = {}) {
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  const line = safeJson(record);

  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

async function withTiming(event, meta, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    log('info', event, { ...meta, durationMs: Date.now() - startedAt, ok: true });
    return result;
  } catch (err) {
    log('error', event, {
      ...meta,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err.message,
    });
    throw err;
  }
}

module.exports = {
  createRequestId,
  log,
  withTiming,
};
