const test = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('../src/server');

async function withServer(fn) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, () => resolve(instance));
    instance.on('error', reject);
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test('GET /api/health returns service status', async (t) => {
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/health`);
      const json = await res.json();

      assert.equal(res.status, 200);
      assert.equal(json.status, 'ok');
      assert.equal(json.service, 'YBX Chatbot');
      assert.ok(Object.prototype.hasOwnProperty.call(json, 'repository'));
    });
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('sandbox does not permit opening a listening socket');
      return;
    }
    throw err;
  }
});

test('POST /webhook/tradingview acknowledges webhook payloads', async (t) => {
  try {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/webhook/tradingview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: 'XAUUSD', action: 'BUY' }),
      });
      const json = await res.json();

      assert.equal(res.status, 200);
      assert.deepEqual(json, { success: true });
    });
  } catch (err) {
    if (err.code === 'EPERM') {
      t.skip('sandbox does not permit opening a listening socket');
      return;
    }
    throw err;
  }
});
