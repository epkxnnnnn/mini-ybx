/**
 * Guardian Service — Guardian mode state management
 * Activates when margin level drops critically, modifies AI behavior
 */

class GuardianService {
  constructor() {
    // Map keyed by "platform:userId" → { active, activatedAt }
    this.states = new Map();
  }

  _key(platform, userId) {
    return `${platform}:${userId}`;
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
    this.states.set(key, { active: true, activatedAt: Date.now() });
    console.log(`[Guardian] Activated for ${key}`);
  }

  /**
   * Deactivate guardian mode
   */
  deactivate(platform, userId) {
    const key = this._key(platform, userId);
    const existing = this.states.get(key);
    if (!existing || !existing.active) return; // already inactive
    this.states.set(key, { active: false, activatedAt: existing.activatedAt });
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
