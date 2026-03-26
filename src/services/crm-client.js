/**
 * CRM API Client — Yellow Box Markets
 * Handles all communication with the YBX CRM backend (JWT auth)
 */
const { log, withTiming } = require('./logger');

class CRMClient {
  constructor({ baseUrl, email, password }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.email = email;
    this.password = password;

    // JWT tokens
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = 0; // timestamp ms

    // Cache
    this.cache = new Map(); // key → { data, expiry }
    this.cacheTTL = 60_000; // 60 seconds

    // Login lock to prevent concurrent login attempts
    this._loginPromise = null;
  }

  /**
   * Ensure we have a valid access token
   */
  async _ensureAuth() {
    // Token still valid (with 2-min buffer)
    if (this.accessToken && Date.now() < this.tokenExpiry - 120_000) {
      return;
    }

    // Try refresh first
    if (this.refreshToken) {
      try {
        await this._refreshAuth();
        return;
      } catch (err) {
        console.log('CRM token refresh failed, re-logging in...');
      }
    }

    // Full login
    await this._login();
  }

  /**
   * Login with email/password to get JWT tokens
   */
  async _login() {
    // Prevent concurrent logins
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = (async () => {
      try {
        await withTiming('crm_login', { path: '/api/v1/auth/login' }, async () => {
          const res = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: this.email,
              password: this.password,
            }),
          });

          if (!res.ok) {
            throw new Error(`CRM login failed: ${res.status} ${res.statusText}`);
          }

          const json = await res.json();
          const data = json.data || json;

          this.accessToken = data.accessToken;
          this.refreshToken = data.refreshToken;
          // Default 60 min expiry
          this.tokenExpiry = Date.now() + 55 * 60 * 1000;
        });
        log('info', 'crm_authenticated', { baseUrl: this.baseUrl });
      } finally {
        this._loginPromise = null;
      }
    })();

    return this._loginPromise;
  }

  /**
   * Refresh the access token
   */
  async _refreshAuth() {
    await withTiming('crm_refresh_token', { path: '/api/v1/auth/refresh-token' }, async () => {
      const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });

      if (!res.ok) {
        this.accessToken = null;
        this.refreshToken = null;
        throw new Error('Token refresh failed');
      }

      const json = await res.json();
      const data = json.data || json;

      this.accessToken = data.accessToken;
      this.refreshToken = data.refreshToken;
      this.tokenExpiry = Date.now() + 55 * 60 * 1000;
    });
  }

  async _fetchJson(url, options, meta) {
    return withTiming('crm_http', meta, async () => {
      const res = await fetch(url, options);
      return { res, json: null };
    });
  }

  /**
   * Internal: make authenticated GET request
   */
  async _get(path, query = {}) {
    await this._ensureAuth();

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const { res } = await this._fetchJson(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json',
      },
    }, { method: 'GET', path, auth: 'service' });

    if (res.status === 401) {
      // Token expired mid-request — retry once
      this.accessToken = null;
      await this._ensureAuth();
      const { res: retry } = await this._fetchJson(url.toString(), {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json',
        },
      }, { method: 'GET', path, auth: 'service', retry: true });
      if (!retry.ok) {
        throw new Error(`CRM API ${retry.status}: ${retry.statusText} — ${path}`);
      }
      return retry.json();
    }

    if (!res.ok) {
      throw new Error(`CRM API ${res.status}: ${res.statusText} — ${path}`);
    }

    return res.json();
  }

  /**
   * Internal: unauthenticated GET (for public endpoints)
   */
  async _publicGet(path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const { res } = await this._fetchJson(url.toString(), {
      headers: { 'Accept': 'application/json' },
    }, { method: 'GET', path, auth: 'public' });

    if (!res.ok) {
      throw new Error(`CRM API ${res.status}: ${res.statusText} — ${path}`);
    }

    return res.json();
  }

  /**
   * Internal: cached GET — returns cached data if still fresh
   */
  async _cachedGet(cacheKey, path, query = {}, isPublic = false) {
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.data;
    }

    const data = isPublic
      ? await this._publicGet(path, query)
      : await this._get(path, query);
    // Shorter TTL for price data (3s), default 60s for others
    var ttl = (cacheKey === 'tick-stats' || cacheKey === 'prices') ? 3000 : this.cacheTTL;
    this.cache.set(cacheKey, { data, expiry: Date.now() + ttl });
    return data;
  }

  // ========== Member Auth (uses member's own JWT, not bot service account) ==========

  /**
   * Login as a member with email/password
   */
  async memberLogin(email, password) {
    const { res } = await this._fetchJson(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, { method: 'POST', path: '/api/v1/auth/login', auth: 'member' });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || body.error || `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }

    const json = await res.json();
    return json.data || json;
  }

  /**
   * Refresh a member's token
   */
  async memberRefreshToken(refreshToken) {
    const { res } = await this._fetchJson(`${this.baseUrl}/api/v1/auth/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }, { method: 'POST', path: '/api/v1/auth/refresh-token', auth: 'member' });

    if (!res.ok) {
      throw new Error('Member token refresh failed');
    }

    const json = await res.json();
    return json.data || json;
  }

  /**
   * Internal: make authenticated GET request using member's token
   */
  async _memberGet(memberToken, path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    const { res } = await this._fetchJson(url.toString(), {
      headers: {
        'Authorization': `Bearer ${memberToken}`,
        'Accept': 'application/json',
      },
    }, { method: 'GET', path, auth: 'member' });

    if (!res.ok) {
      throw new Error(`CRM Member API ${res.status}: ${res.statusText} — ${path}`);
    }

    return res.json();
  }

  /**
   * Get member's own profile
   */
  async getMemberProfile(memberToken) {
    return this._memberGet(memberToken, '/api/v1/profile/me');
  }

  /**
   * Get member's trading accounts
   */
  async getMemberAccounts(memberToken) {
    return this._memberGet(memberToken, '/api/v1/trading/accounts');
  }

  /**
   * Get member's open positions
   */
  async getMemberPositions(memberToken) {
    return this._memberGet(memberToken, '/api/v1/trading/positions');
  }

  /**
   * Get member's transaction history
   */
  async getMemberTransactions(memberToken, page = 1, pageSize = 20) {
    return this._memberGet(memberToken, '/api/v1/transactions', { page, pageSize });
  }

  /**
   * Get member wallets
   */
  async getMemberWallets(memberToken) {
    return this._memberGet(memberToken, '/api/v1/transactions/wallets');
  }

  /**
   * Get member bank accounts
   */
  async getMemberBankAccounts(memberToken) {
    return this._memberGet(memberToken, '/api/v1/users/bank-accounts');
  }

  /**
   * Get member's transaction summary
   */
  async getMemberTransactionSummary(memberToken) {
    return this._memberGet(memberToken, '/api/v1/transactions/summary');
  }

  /**
   * Get active payment provider configuration
   */
  async getActivePaymentProvider(memberToken) {
    return this._memberGet(memberToken, '/api/v1/payment/active-provider');
  }

  /**
   * Internal: make authenticated POST request using member's token
   */
  async _memberPost(memberToken, path, body = {}) {
    const { res } = await this._fetchJson(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${memberToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    }, { method: 'POST', path, auth: 'member' });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.message || json.title || `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      err.errorCode = json.errorCode;
      err.errors = json.errors;
      throw err;
    }
    return json;
  }

  /**
   * Internal: make authenticated PUT request using member's token
   */
  async _memberPut(memberToken, path, body = {}) {
    const { res } = await this._fetchJson(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${memberToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    }, { method: 'PUT', path, auth: 'member' });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.message || json.title || `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      err.errorCode = json.errorCode;
      err.errors = json.errors;
      throw err;
    }
    return json;
  }

  // ========== Trading Orders (member's token) ==========

  /**
   * Place a market order
   */
  async placeOrder(memberToken, accountId, { symbol, side, volume, stopLoss, takeProfit }) {
    return this._memberPost(memberToken, `/api/v1/trading/accounts/${accountId}/orders`, {
      Mt5AccountId: accountId,
      Symbol: symbol,
      Side: side,
      Volume: volume,
      StopLoss: stopLoss,
      TakeProfit: takeProfit,
      Source: 'JerryAI-Telegram',
    });
  }

  /**
   * Place a pending order (limit/stop)
   */
  async placePendingOrder(memberToken, accountId, { symbol, side, orderType, price, volume, stopLoss, takeProfit }) {
    return this._memberPost(memberToken, `/api/v1/trading/accounts/${accountId}/pending-orders`, {
      Mt5AccountId: accountId,
      Symbol: symbol,
      Side: side,
      OrderType: orderType,
      Price: price,
      Volume: volume,
      StopLoss: stopLoss,
      TakeProfit: takeProfit,
      Source: 'JerryAI-Telegram',
    });
  }

  /**
   * Close an open position
   */
  async closePosition(memberToken, accountId, positionTicket, volume) {
    return this._memberPost(memberToken, `/api/v1/trading/accounts/${accountId}/positions/${positionTicket}/close`, {
      Volume: volume,
    });
  }

  /**
   * Modify position TP/SL
   */
  async modifyPosition(memberToken, accountId, positionTicket, { takeProfit, stopLoss }) {
    return this._memberPut(memberToken, `/api/v1/trading/accounts/${accountId}/positions/${positionTicket}`, {
      TakeProfit: takeProfit,
      StopLoss: stopLoss,
    });
  }

  /**
   * Get account positions
   */
  async getAccountPositions(memberToken, accountId) {
    return this._memberGet(memberToken, `/api/v1/trading/accounts/${accountId}/positions`);
  }

  /**
   * Create a deposit request (member's token)
   */
  async memberDeposit(memberToken, payload) {
    const paymentMethod = String(payload?.paymentMethod || '').toLowerCase();
    if (paymentMethod === 'promptpay') {
      return this._memberPost(memberToken, '/api/v1/payment/stripe/promptpay/deposit', payload);
    }
    return this._memberPost(memberToken, '/api/v1/payment/overpay/deposit', payload);
  }

  /**
   * Create a withdrawal request (member's token)
   */
  async memberWithdraw(memberToken, payload, provider) {
    const lowerProvider = String(provider || '').toLowerCase();
    const path = lowerProvider === 'plusone-lao'
      ? '/api/v1/payment/plusone-lao/withdraw'
      : lowerProvider === 'plusone'
        ? '/api/v1/payment/plusone/withdraw'
        : '/api/v1/payment/overpay/withdraw';
    return this._memberPost(memberToken, path, payload);
  }

  /**
   * Create an internal transfer (member's token)
   */
  async memberTransferWalletToMt5(memberToken, payload) {
    return this._memberPost(memberToken, '/api/v1/transactions/transfer/wallet-to-mt5', payload);
  }

  async memberTransferMt5ToWallet(memberToken, payload) {
    return this._memberPost(memberToken, '/api/v1/transactions/transfer/mt5-to-wallet', payload);
  }

  // ========== Prices ==========

  async getPrices(symbols = 'XAUUSD,BTCUSD,EURUSD,GBPUSD,USDJPY') {
    return this._cachedGet('prices', '/api/v1/trading/prices', { symbols });
  }

  async getTickStats(symbols = 'XAUUSD,XAGUSD,BTCUSD,ETHUSD,EURUSD,GBPUSD,USDJPY,GBPJPY,EURJPY,AUDUSD,NZDUSD,USDCHF,XTIUSD') {
    return this._cachedGet('tick-stats', '/api/v1/trading/tick-stats', { symbols });
  }

  // ========== AI Analysis ==========

  async getMarketStructure(symbol) {
    return this._cachedGet(
      `structure:${symbol}`,
      `/api/v1/ai-assistant/structure/${encodeURIComponent(symbol)}`
    );
  }

  async getHtfBias(symbol) {
    return this._cachedGet(
      `htf-bias:${symbol}`,
      `/api/v1/ai-assistant/htf-bias/${encodeURIComponent(symbol)}`
    );
  }

  async getKeyLevels(symbol) {
    return this._cachedGet(
      `key-levels:${symbol}`,
      `/api/v1/ai-assistant/key-levels/${encodeURIComponent(symbol)}`
    );
  }

  async getLiquiditySweeps(symbol) {
    return this._cachedGet(
      `liquidity-sweeps:${symbol}`,
      `/api/v1/ai-assistant/liquidity-sweeps/${encodeURIComponent(symbol)}`
    );
  }

  // ========== Calendar & Rates ==========

  async getEconomicCalendar(currency) {
    return this._cachedGet(
      `calendar:${currency || 'all'}`,
      '/api/v1/ai-assistant/economic-calendar',
      currency ? { currency } : {}
    );
  }

  async getExchangeRate() {
    // Public endpoint — no auth needed
    return this._cachedGet('exchange-rate', '/api/v1/payment/exchange-rates', {}, true);
  }

  // ========== Copy Trading ==========

  async getCopyTradingProviders() {
    return this._cachedGet('copy-providers', '/api/v1/copy-trading/providers');
  }

  // ========== Member: Notifications, Support ==========

  async getMemberNotifications(memberToken, page = 1, pageSize = 20) {
    return this._memberGet(memberToken, '/api/v1/users/notifications', { page, pageSize });
  }

  async getMemberSupportTickets(memberToken, page = 1, pageSize = 20) {
    return this._memberGet(memberToken, '/api/v1/support/tickets', { page, pageSize });
  }

  async createSupportTicket(memberToken, subject, description) {
    return this._memberPost(memberToken, '/api/v1/support/tickets', { subject, description });
  }

  async getMemberProfile(memberToken) {
    return this._memberGet(memberToken, '/api/v1/users/profile');
  }

  // ========== Journal ==========

  async getMemberJournal(memberToken, page = 1, pageSize = 20) {
    return this._memberGet(memberToken, '/api/v1/journal', { page, pageSize });
  }

  async createJournalEntry(memberToken, entry) {
    return this._memberPost(memberToken, '/api/v1/journal', entry);
  }

  async deleteJournalEntry(memberToken, entryId) {
    const path = `/api/v1/journal/${entryId}`;
    const { res } = await this._fetchJson(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${memberToken}`,
        'Accept': 'application/json',
      },
    }, { method: 'DELETE', path, auth: 'member' });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      const msg = json.message || `${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res.json().catch(() => ({ success: true }));
  }
}

module.exports = CRMClient;
