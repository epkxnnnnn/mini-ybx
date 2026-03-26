const { Pool } = require('pg');

class StateRepository {
  constructor(connectionString = process.env.DATABASE_URL) {
    this.connectionString = connectionString;
    this.pool = null;
    this.enabled = !!connectionString;
    this.lastError = null;
  }

  async init() {
    if (!this.enabled) return;

    this.pool = new Pool({
      connectionString: this.connectionString,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jerry_state (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, key)
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jerry_execution_events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        correlation_id TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jerry_lineapp_events (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        platform TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        screen TEXT,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    this.lastError = null;
  }

  async list(namespace) {
    if (!this.enabled) return [];

    try {
      const result = await this.pool.query(
        'SELECT key, value FROM jerry_state WHERE namespace = $1',
        [namespace]
      );
      this.lastError = null;
      return result.rows.map((row) => ({
        key: row.key,
        value: row.value,
      }));
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async set(namespace, key, value) {
    if (!this.enabled) return;

    try {
      await this.pool.query(
        `
          INSERT INTO jerry_state(namespace, key, value, updated_at)
          VALUES ($1, $2, $3::jsonb, NOW())
          ON CONFLICT (namespace, key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
        [namespace, key, JSON.stringify(value)]
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async delete(namespace, key) {
    if (!this.enabled) return;

    try {
      await this.pool.query(
        'DELETE FROM jerry_state WHERE namespace = $1 AND key = $2',
        [namespace, key]
      );
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async appendExecutionEvent(event) {
    if (!this.enabled) return null;

    const payload = event.payload || {};
    try {
      const result = await this.pool.query(
        `
          INSERT INTO jerry_execution_events(platform, user_id, category, action, status, correlation_id, payload)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          RETURNING id, created_at
        `,
        [
          event.platform,
          String(event.userId),
          event.category,
          event.action,
          event.status,
          event.correlationId || null,
          JSON.stringify(payload),
        ]
      );
      this.lastError = null;
      return result.rows[0];
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async listExecutionEvents(platform, userId, limit = 100) {
    if (!this.enabled) return [];

    try {
      const result = await this.pool.query(
        `
          SELECT id, created_at, platform, user_id, category, action, status, correlation_id, payload
          FROM jerry_execution_events
          WHERE platform = $1 AND user_id = $2
          ORDER BY id DESC
          LIMIT $3
        `,
        [platform, String(userId), limit]
      );
      this.lastError = null;
      return result.rows;
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  async appendLineAppEvent(event) {
    if (!this.enabled) return null;

    try {
      const result = await this.pool.query(
        `
          INSERT INTO jerry_lineapp_events(platform, user_id, event_name, screen, payload)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          RETURNING id, created_at
        `,
        [
          event.platform,
          String(event.userId),
          event.eventName,
          event.screen || null,
          JSON.stringify(event.payload || {}),
        ]
      );
      this.lastError = null;
      return result.rows[0];
    } catch (err) {
      this.lastError = err.message;
      throw err;
    }
  }

  getHealth() {
    return {
      enabled: this.enabled,
      connected: this.enabled ? !!this.pool && !this.lastError : false,
      lastError: this.lastError,
    };
  }

  async close() {
    if (!this.pool) return;
    await this.pool.end();
    this.pool = null;
  }
}

module.exports = StateRepository;
