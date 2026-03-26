class ExecutionAuditService {
  constructor(options = {}) {
    this.repo = options.repo || null;
    this.memory = [];
    this.maxMemoryEvents = options.maxMemoryEvents || 500;
  }

  async record(event) {
    const normalized = {
      platform: event.platform,
      userId: String(event.userId),
      category: event.category,
      action: event.action,
      status: event.status || 'info',
      correlationId: event.correlationId || null,
      payload: event.payload || {},
      createdAt: new Date().toISOString(),
    };

    this.memory.push(normalized);
    if (this.memory.length > this.maxMemoryEvents) {
      this.memory.shift();
    }

    if (this.repo?.enabled && typeof this.repo.appendExecutionEvent === 'function') {
      await this.repo.appendExecutionEvent(normalized);
    }

    return normalized;
  }

  async list(platform, userId, limit = 100) {
    if (this.repo?.enabled && typeof this.repo.listExecutionEvents === 'function') {
      return this.repo.listExecutionEvents(platform, userId, limit);
    }

    return this.memory
      .filter((event) => event.platform === platform && event.userId === String(userId))
      .slice(-limit)
      .reverse();
  }
}

module.exports = ExecutionAuditService;
