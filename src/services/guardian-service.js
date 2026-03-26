/**
 * Guardian Service — Guardian mode state management
 * Activates when margin level drops critically, modifies AI behavior
 */

class GuardianService {
  constructor(options = {}) {
    // Map keyed by "platform:userId" → { active, activatedAt }
    this.states = options.states || new Map();
    this.repo = options.repo || null;
  }

  _key(platform, userId) {
    return `${platform}:${userId}`;
  }

  _persist(key, value) {
    if (!this.repo) return;
    this.repo.set('guardian:states', key, value).catch((err) => {
      console.error(`State persist failed [guardian:states:${key}]:`, err.message);
    });
  }

  /**
   * Check if guardian mode is active for a user
   */
  isActive(platform, userId) {
    const state = this.states.get(this._key(platform, userId));
    return !!(state && state.active);
  }

  /**
   * Activate guardian mode
   */
  activate(platform, userId) {
    const key = this._key(platform, userId);
    const existing = this.states.get(key);
    if (existing && existing.active) return; // already active
    const state = { active: true, activatedAt: Date.now() };
    this.states.set(key, state);
    this._persist(key, state);
    console.log(`[Guardian] Activated for ${key}`);
  }

  /**
   * Deactivate guardian mode
   */
  deactivate(platform, userId) {
    const key = this._key(platform, userId);
    const existing = this.states.get(key);
    if (!existing || !existing.active) return; // already inactive
    const state = { active: false, activatedAt: existing.activatedAt };
    this.states.set(key, state);
    this._persist(key, state);
    console.log(`[Guardian] Deactivated for ${key}`);
  }

  /**
   * Get guardian status for a user
   */
  getStatus(platform, userId) {
    const state = this.states.get(this._key(platform, userId));
    if (!state) return { active: false, activatedAt: null };
    return { active: state.active, activatedAt: state.activatedAt };
  }
}

module.exports = GuardianService;
