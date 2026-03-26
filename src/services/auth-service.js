/**
 * Auth Service — Member session management
 * In-memory sessions (lost on restart, same pattern as conversation memory)
 */

const crypto = require('crypto');

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const TOKEN_EXPIRY = 55 * 60 * 1000; // 55 min (tokens last ~60 min)
const CLEANUP_INTERVAL = 15 * 60 * 1000; // 15 min
const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

class AuthService {
  constructor(crmClient, options = {}) {
    this.crm = crmClient;
    this.repo = options.repo || null;
    this.sessions = options.sessions || new Map(); // platform:userId → session
    this.loginStates = options.loginStates || new Map(); // platform:userId → { step, email? }

    // Auto-cleanup expired sessions
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL);
  }

  _key(platform, userId) {
    return `${platform}:${userId}`;
  }

  _persist(namespace, key, value) {
    if (!this.repo) return;
    this.repo.set(namespace, key, value).catch((err) => {
      console.error(`State persist failed [${namespace}:${key}]:`, err.message);
    });
  }

  _deletePersisted(namespace, key) {
    if (!this.repo) return;
    this.repo.delete(namespace, key).catch((err) => {
      console.error(`State delete failed [${namespace}:${key}]:`, err.message);
    });
  }

  /**
   * Login member via CRM, fetch profile + accounts, store session
   */
  async login(platform, userId, email, password) {
    const key = this._key(platform, userId);

    // Authenticate
    const authData = await this.crm.memberLogin(email, password);

    // Fetch profile + accounts in parallel
    const [profileRes, accountsRes] = await Promise.allSettled([
      this.crm.getMemberProfile(authData.accessToken),
      this.crm.getMemberAccounts(authData.accessToken),
    ]);

    const profileRaw = profileRes.status === 'fulfilled' ? profileRes.value : null;
    const accountsRaw = accountsRes.status === 'fulfilled' ? accountsRes.value : null;

    const profile = profileRaw ? (profileRaw.data || profileRaw) : {};
    const accounts = accountsRaw ? (accountsRaw.data || accountsRaw) : {};

    const session = {
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      tokenExpiresAt: Date.now() + TOKEN_EXPIRY,
      expiresAt: Date.now() + SESSION_TTL,
      memberData: {
        id: profile.id || profile._id || null,
        email: email,
        name: profile.name || profile.fullName || profile.firstName || email.split('@')[0],
        tier: profile.tier || profile.membershipTier || profile.level || 'Standard',
        status: profile.status || 'active',
      },
      accountData: accounts,
    };

    this.sessions.set(key, session);
    this._persist('auth:sessions', key, session);
    this.clearLoginState(platform, userId);

    return session;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(platform, userId) {
    const key = this._key(platform, userId);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(key);
      this._deletePersisted('auth:sessions', key);
      return false;
    }
    return true;
  }

  /**
   * Get session (auto-refreshes token if near expiry)
   */
  async getSession(platform, userId) {
    const key = this._key(platform, userId);
    const session = this.sessions.get(key);
    if (!session) return null;

    // Session expired
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(key);
      this._deletePersisted('auth:sessions', key);
      return null;
    }

    // Token near expiry — refresh
    if (Date.now() > session.tokenExpiresAt - 120_000 && session.refreshToken) {
      try {
        const newTokens = await this.crm.memberRefreshToken(session.refreshToken);
        session.accessToken = newTokens.accessToken;
        session.refreshToken = newTokens.refreshToken;
        session.tokenExpiresAt = Date.now() + TOKEN_EXPIRY;
        this._persist('auth:sessions', key, session);
      } catch (err) {
        console.error('Member token refresh failed:', err.message);
        // Session still usable until it expires
      }
    }

    return session;
  }

  /**
   * Destroy session
   */
  logout(platform, userId) {
    const key = this._key(platform, userId);
    this.sessions.delete(key);
    this.loginStates.delete(key);
    this._deletePersisted('auth:sessions', key);
    this._deletePersisted('auth:login-states', key);
  }

  // ========== Login State (multi-step flow for Telegram) ==========

  getLoginState(platform, userId) {
    return this.loginStates.get(this._key(platform, userId)) || null;
  }

  setLoginState(platform, userId, state) {
    const key = this._key(platform, userId);
    this.loginStates.set(key, state);
    this._persist('auth:login-states', key, state);
  }

  clearLoginState(platform, userId) {
    const key = this._key(platform, userId);
    this.loginStates.delete(key);
    this._deletePersisted('auth:login-states', key);
  }

  // ========== Account Data ==========

  /**
   * Re-fetch account data on demand
   */
  async refreshAccountData(platform, userId) {
    const session = await this.getSession(platform, userId);
    if (!session) return null;

    try {
      const [accountsRes, positionsRes] = await Promise.allSettled([
        this.crm.getMemberAccounts(session.accessToken),
        this.crm.getMemberPositions(session.accessToken),
      ]);

      if (accountsRes.status === 'fulfilled') {
        session.accountData = accountsRes.value.data || accountsRes.value;
        this._persist('auth:sessions', this._key(platform, userId), session);
      }

      const positions = positionsRes.status === 'fulfilled'
        ? (positionsRes.value.data || positionsRes.value)
        : null;

      return { accounts: session.accountData, positions };
    } catch (err) {
      console.error('Account data refresh error:', err.message);
      return null;
    }
  }

  // ========== Member Context for AI ==========

  /**
   * Build member context string for AI system prompt
   */
  buildMemberContext(session) {
    if (!session) return '';

    const parts = ['\n\n[Member Profile]'];
    const m = session.memberData;
    parts.push(`Name: ${m.name} | Email: ${m.email} | Tier: ${m.tier} | Status: ${m.status}`);

    // Account data
    const accts = session.accountData;
    if (accts) {
      const arr = Array.isArray(accts) ? accts : (accts.accounts || [accts]);
      if (arr.length > 0) {
        parts.push('[Trading Accounts]');
        for (const a of arr) {
          const login = a.login || a.accountId || a.id || 'N/A';
          const balance = a.balance != null ? `$${Number(a.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
          const equity = a.equity != null ? `$${Number(a.equity).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
          const leverage = a.leverage ? `1:${a.leverage}` : 'N/A';
          parts.push(`Account ${login}: Balance ${balance} | Equity ${equity} | Leverage ${leverage}`);
        }
      }
    }

    return parts.join('\n');
  }

  // ========== Session Token (HMAC-signed, for web clients) ==========

  /**
   * Generate HMAC-signed session token binding platform + userId
   * Format: base64(JSON) + "." + hex(HMAC)
   */
  generateSessionToken(platform, userId) {
    const payload = JSON.stringify({ p: platform, u: String(userId), t: Date.now() });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_TOKEN_SECRET).update(payloadB64).digest('hex');
    return `${payloadB64}.${sig}`;
  }

  /**
   * Validate session token, return { platform, userId } or null
   */
  validateSessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dotIdx = token.indexOf('.');
    if (dotIdx < 0) return null;

    const payloadB64 = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expectedSig = crypto.createHmac('sha256', SESSION_TOKEN_SECRET).update(payloadB64).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');

    if (sig.length !== expectedSig.length || sigBuf.length !== expectedBuf.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      return { platform: payload.p, userId: payload.u };
    } catch {
      return null;
    }
  }

  // ========== Cleanup ==========

  _cleanup() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(key);
        this._deletePersisted('auth:sessions', key);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

module.exports = AuthService;
