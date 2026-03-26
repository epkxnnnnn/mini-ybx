/**
 * Command Router — Centralized command handling for all platforms
 * Returns { text: string } for platform-agnostic rendering
 */

// Commands that don't require authentication
const PUBLIC_COMMANDS = ['/start', '/login', '/logout', '/checklist', '/zones', '/cancel'];

class CommandRouter {
  constructor(crmClient, aiEngine, authService) {
    this.crm = crmClient;
    this.aiEngine = aiEngine;
    this.authService = authService;
    this.guardianService = null;

    // command → handler map
    this.commands = {
      '/price': this.handlePrice.bind(this),
      '/analyze': this.handleAnalyze.bind(this),
      '/news': this.handleNews.bind(this),
      '/levels': this.handleLevels.bind(this),
      '/rate': this.handleRate.bind(this),
      '/checklist': this.handleChecklist.bind(this),
      '/zones': this.handleZones.bind(this),
      '/reset': this.handleReset.bind(this),
      '/start': this.handleStart.bind(this),
      '/login': this.handleLogin.bind(this),
      '/logout': this.handleLogout.bind(this),
      '/profile': this.handleProfile.bind(this),
      '/account': this.handleAccount.bind(this),
    };
  }

  setGuardianService(guardianService) {
    this.guardianService = guardianService;
  }

  /**
   * Parse a command string into { command, args }
   * e.g. "/price xauusd" → { command: "/price", args: "xauusd" }
   */
  parse(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      return { command: trimmed.toLowerCase(), args: '' };
    }
    return {
      command: trimmed.slice(0, spaceIdx).toLowerCase(),
      args: trimmed.slice(spaceIdx + 1).trim(),
    };
  }

  /**
   * Try to execute a command. Returns { text } or null if not a known command.
   */
  async execute(text, platform, userId, userName) {
    const parsed = this.parse(text);
    if (!parsed) return null;

    const handler = this.commands[parsed.command];
    if (!handler) return null;

    // Auth gate — require login for non-public commands
    if (this.authService && !PUBLIC_COMMANDS.includes(parsed.command)) {
      if (!this.authService.isAuthenticated(platform, userId)) {
        return { text: '🔒 กรุณาเข้าสู่ระบบก่อนใช้คำสั่งนี้\nพิมพ์ /login เพื่อเข้าสู่ระบบ' };
      }
    }

    try {
      return await handler(parsed.args, platform, userId, userName);
    } catch (err) {
      console.error(`Command error [${parsed.command}]:`, err.message);
      return { text: `❌ คำสั่ง ${parsed.command} ผิดพลาด: ${err.message}` };
    }
  }

  // ========== Command Handlers ==========

  async handlePrice(args) {
    const symbol = this._resolveSymbol(args) || 'XAUUSD';
    const raw = await this.crm.getTickStats(symbol);
    const stats = this._unwrap(raw);
    const tick = this._findTick(stats, symbol);

    if (!tick) {
      return { text: `❌ ไม่พบข้อมูลราคาสำหรับ ${symbol.toUpperCase()}` };
    }

    const bid = this._fmt(tick.bid);
    const ask = this._fmt(tick.ask);
    const spread = this._fmt(tick.spread ?? (tick.ask - tick.bid));
    const high = this._fmt(tick.bidHigh ?? tick.high);
    const low = this._fmt(tick.bidLow ?? tick.low);
    const change = tick.priceChange != null ? `${tick.priceChange > 0 ? '+' : ''}${tick.priceChange.toFixed(2)}%` : (tick.change != null ? this._fmtChange(tick.change) : 'N/A');
    const changePct = tick.priceChange != null ? '' : (tick.changePercent != null ? `(${tick.changePercent > 0 ? '+' : ''}${tick.changePercent.toFixed(2)}%)` : '');

    return {
      text:
        `📊 ราคา ${symbol.toUpperCase()} — YBX Live\n\n` +
        `Bid: $${bid} | Ask: $${ask} | Spread: ${spread}\n` +
        `High: $${high} | Low: $${low}\n` +
        `Change: ${change} ${changePct}`.trim(),
    };
  }

  async handleAnalyze(args, platform, userId, userName) {
    const symbol = this._resolveSymbol(args);
    if (!symbol) {
      return { text: '⚠️ กรุณาระบุสินทรัพย์ เช่น /analyze xauusd' };
    }

    // Fetch all analysis data in parallel
    const [structure, htfBias, keyLevels, sweeps, stats] = await Promise.allSettled([
      this.crm.getMarketStructure(symbol),
      this.crm.getHtfBias(symbol),
      this.crm.getKeyLevels(symbol),
      this.crm.getLiquiditySweeps(symbol),
      this.crm.getTickStats(symbol),
    ]);

    // Build context for AI
    let context = `\n\n[Market Analysis Data: ${symbol.toUpperCase()}]\n`;

    if (structure.status === 'fulfilled' && structure.value) {
      const s = this._unwrap(structure.value);
      if (s) context += `Structure: ${s.currentTrend || s.trend || s.direction || 'N/A'} — ${s.structureBreaks?.length ? s.structureBreaks[0].type || s.structureBreaks[0].event : 'N/A'}\n`;
    }

    if (htfBias.status === 'fulfilled' && htfBias.value) {
      const hb = this._unwrap(htfBias.value);
      if (hb) {
        const biases = hb.biases || [];
        const biasStr = biases.map(b => `${b.timeframe}: ${b.bias} (${b.strength})`).join(', ');
        context += `HTF Bias: ${biasStr || hb.bias || hb.direction || 'N/A'}\n`;
      }
    }

    if (keyLevels.status === 'fulfilled' && keyLevels.value) {
      const raw = this._unwrap(keyLevels.value);
      const levels = Array.isArray(raw) ? raw : (raw?.levels || raw?.data || []);
      const supports = levels.filter(l => l.type === 'support');
      const resistances = levels.filter(l => l.type === 'resistance');
      const sStr = supports.length ? supports.map(l => `$${this._fmt(l.price)}`).join(', ') : 'N/A';
      const rStr = resistances.length ? resistances.map(l => `$${this._fmt(l.price)}`).join(', ') : 'N/A';
      context += `Key Levels: Support ${sStr} | Resistance ${rStr}\n`;
    }

    if (sweeps.status === 'fulfilled' && sweeps.value) {
      const raw = this._unwrap(sweeps.value);
      const sweepArr = Array.isArray(raw) ? raw : (raw?.sweeps || raw?.data || []);
      if (sweepArr.length > 0) {
        const recent = sweepArr[0];
        context += `Recent Liquidity Sweep: ${recent.sweepType || ''} $${this._fmt(recent.price)}\n`;
      }
    }

    // Get price
    if (stats.status === 'fulfilled') {
      const statsData = this._unwrap(stats.value);
      const tick = this._findTick(statsData, symbol);
      if (tick) {
        context += `Current Price — Bid: $${this._fmt(tick.bid)} | Ask: $${this._fmt(tick.ask)}\n`;
      }
    }

    // Build member context if authenticated
    let memberContext = '';
    if (this.authService) {
      const session = await this.authService.getSession(platform, userId);
      if (session) {
        memberContext = this.authService.buildMemberContext(session);
      }
    }

    const guardianMode = this.guardianService
      ? this.guardianService.isActive(platform, userId)
      : false;

    // Send to AI engine with the analysis context
    const prompt = `วิเคราะห์ ${symbol.toUpperCase()} ให้หน่อย${context}`;
    const reply = await this.aiEngine.chat(platform, userId, prompt, userName, memberContext, { guardianMode });
    return { text: reply };
  }

  async handleNews(args) {
    const currency = args ? args.toUpperCase() : undefined;
    const raw = await this.crm.getEconomicCalendar(currency);
    const calendar = this._unwrap(raw);

    if (!calendar || (Array.isArray(calendar) && calendar.length === 0)) {
      return { text: '📰 ไม่มีข่าวเศรษฐกิจสำคัญในวันนี้' };
    }

    const events = Array.isArray(calendar) ? calendar : (calendar.events || calendar.data || []);
    if (events.length === 0) {
      return { text: '📰 ไม่มีข่าวเศรษฐกิจสำคัญในวันนี้' };
    }

    let text = '📰 ข่าวเศรษฐกิจวันนี้\n\n';
    const shown = events.slice(0, 10);
    for (const ev of shown) {
      const impact = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';
      const time = ev.time ? new Date(ev.time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : (ev.datetime || '');
      const evCurrency = ev.currency || ev.country || '';
      const title = ev.title || ev.event || ev.name || '';
      const forecast = ev.forecast != null ? `คาด: ${ev.forecast}` : '';
      const previous = ev.previous != null ? `ก่อนหน้า: ${ev.previous}` : '';
      const actual = ev.actual != null ? `จริง: ${ev.actual}` : '';

      text += `${impact} ${time} ${evCurrency} — ${title}\n`;
      if (forecast || previous || actual) {
        text += `   ${[actual, forecast, previous].filter(Boolean).join(' | ')}\n`;
      }
    }

    if (events.length > 10) {
      text += `\n...และอีก ${events.length - 10} รายการ`;
    }

    return { text };
  }

  async handleLevels(args) {
    const symbol = this._resolveSymbol(args);
    if (!symbol) {
      return { text: '⚠️ กรุณาระบุสินทรัพย์ เช่น /levels xauusd' };
    }

    const raw = await this.crm.getKeyLevels(symbol);
    const kl = this._unwrap(raw);
    if (!kl) {
      return { text: `❌ ไม่พบข้อมูล Key Levels สำหรับ ${symbol.toUpperCase()}` };
    }

    // CRM returns array of { price, type, strength, touchCount }
    const levels = Array.isArray(kl) ? kl : (kl.levels || kl.data || []);
    const supports = levels.filter(l => l.type === 'support');
    const resistances = levels.filter(l => l.type === 'resistance');

    let text = `📍 Key Levels: ${symbol.toUpperCase()}\n\n`;

    text += '🟢 แนวรับ (Support):\n';
    if (supports.length > 0) {
      for (const s of supports) {
        const strength = s.strength ? ` [strength: ${s.strength}]` : '';
        const touches = s.touchCount ? ` (${s.touchCount} touches)` : '';
        text += `  • $${this._fmt(s.price)}${strength}${touches}\n`;
      }
    } else {
      text += '  ไม่มีข้อมูล\n';
    }

    text += '\n🔴 แนวต้าน (Resistance):\n';
    if (resistances.length > 0) {
      for (const r of resistances) {
        const strength = r.strength ? ` [strength: ${r.strength}]` : '';
        const touches = r.touchCount ? ` (${r.touchCount} touches)` : '';
        text += `  • $${this._fmt(r.price)}${strength}${touches}\n`;
      }
    } else {
      text += '  ไม่มีข้อมูล\n';
    }

    return { text };
  }

  async handleRate() {
    const raw = await this.crm.getExchangeRate();
    const data = this._unwrap(raw);
    if (!data) {
      return { text: '❌ ไม่สามารถดึงข้อมูลอัตราแลกเปลี่ยนได้' };
    }

    // CRM returns ExchangeRateSettingsDto
    const currency = data.localCurrency || 'THB';
    let text = `💱 อัตราแลกเปลี่ยน ${currency}/USD\n\n`;

    if (data.depositRate != null || data.withdrawRate != null) {
      text += `อัตราพื้นฐาน: ฿${this._fmt(data.baseRate)} / $1\n`;
      text += `ฝากเงิน (Deposit): ฿${this._fmt(data.depositRate)} / $1\n`;
      text += `ถอนเงิน (Withdrawal): ฿${this._fmt(data.withdrawRate)} / $1\n`;
      if (data.minimumDeposit) text += `\nฝากขั้นต่ำ: $${this._fmt(data.minimumDeposit)}`;
      if (data.minimumWithdrawal) text += `\nถอนขั้นต่ำ: $${this._fmt(data.minimumWithdrawal)}`;
      if (data.rateMode) text += `\nโหมด: ${data.rateMode === 'live' ? '🟢 Live' : '⚙️ Manual'}`;
    } else if (data.baseRate) {
      text += `อัตรา: ฿${this._fmt(data.baseRate)} / $1\n`;
    } else {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'number') {
          text += `${k}: ${this._fmt(v)}\n`;
        }
      }
    }

    return { text };
  }

  handleChecklist() {
    return {
      text:
        '📋 Pre-trade Checklist 5 ขั้นตอน\n\n' +
        '1️⃣ TREND — HTF ทิศทางหลัก (Bullish/Bearish/Range?)\n' +
        '2️⃣ LEVELS — แนวรับ/แนวต้านสำคัญ + Fibonacci\n' +
        '3️⃣ CONFIRM — รอ confirmation (Candlestick pattern, Indicator signal)\n' +
        '4️⃣ ENTRY — จุดเข้าเทรด Entry, SL, TP + คำนวณ R:R\n' +
        '5️⃣ SIZE — คำนวณ Lot Size ตาม risk 1-2%',
    };
  }

  handleZones() {
    return {
      text:
        '📊 Trade Setup Grading\n\n' +
        'A+ ★★★★★ — Multi-TF confluence, 100% size, R:R ≥ 1:3\n' +
        'A  ★★★★☆ — Strong confluence, 100% size, R:R ≥ 1:2\n' +
        'B  ★★★☆☆ — Moderate confluence, 75% size, R:R ≥ 1:2\n' +
        'C  ★★☆☆☆ — Weak setup, 50% size, R:R ≥ 1:3\n' +
        'D  ★☆☆☆☆ — No confluence → SKIP',
    };
  }

  handleReset(_args, platform, userId) {
    this.aiEngine.resetConversation(platform, userId);
    return { text: '🔄 เริ่มบทสนทนาใหม่แล้วครับ' };
  }

  handleStart(_args, platform, userId, userName) {
    const name = userName || 'Trader';

    // Check if already logged in
    if (this.authService && this.authService.isAuthenticated(platform, userId)) {
      return {
        text:
          `สวัสดีครับ ${name}! 👋\n\n` +
          `ผมคือ Jerry — AI Trading Analyst ของ Yellow Box Markets\n\n` +
          `🔹 วิเคราะห์ตลาดด้วย TA, FA, Sentiment\n` +
          `🔹 ดูราคาสด, ข่าว, แนวรับแนวต้าน\n` +
          `🔹 สอนกลยุทธ์การเทรด\n\n` +
          `คำสั่ง:\n` +
          `/price [symbol] — ดูราคาสด\n` +
          `/analyze [symbol] — วิเคราะห์ตลาด\n` +
          `/news — ข่าวเศรษฐกิจวันนี้\n` +
          `/levels [symbol] — แนวรับแนวต้าน\n` +
          `/rate — อัตราแลกเปลี่ยน THB/USD\n` +
          `/profile — ดูข้อมูลสมาชิก\n` +
          `/account — ดูบัญชีเทรด\n` +
          `/checklist — Pre-trade Checklist\n` +
          `/zones — Trade Setup Grading\n` +
          `/reset — เริ่มบทสนทนาใหม่\n` +
          `/logout — ออกจากระบบ`,
      };
    }

    return {
      text:
        `สวัสดีครับ ${name}! 👋\n\n` +
        `ผมคือ Jerry ผู้ช่วย AI ของ Yellow Box Markets\n\n` +
        `🔒 กรุณาเข้าสู่ระบบเพื่อใช้งาน\n` +
        `พิมพ์ /login เพื่อเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน YBX ของคุณ\n\n` +
        `คำสั่งที่ใช้ได้โดยไม่ต้องเข้าสู่ระบบ:\n` +
        `/checklist — Pre-trade Checklist\n` +
        `/zones — Trade Setup Grading`,
    };
  }

  handleLogin() {
    return {
      text:
        '🔐 เข้าสู่ระบบ YBX Member\n\n' +
        'กรุณาส่งอีเมลที่ลงทะเบียนกับ Yellow Box Markets\n' +
        '(พิมพ์ /cancel เพื่อยกเลิก)',
    };
  }

  handleLogout(_args, platform, userId) {
    if (this.authService) {
      this.authService.logout(platform, userId);
    }
    this.aiEngine.resetConversation(platform, userId);
    return { text: '👋 ออกจากระบบเรียบร้อยแล้ว\nพิมพ์ /login เพื่อเข้าสู่ระบบอีกครั้ง' };
  }

  async handleProfile(_args, platform, userId) {
    if (!this.authService) return { text: '❌ ระบบสมาชิกไม่พร้อมใช้งาน' };

    const session = await this.authService.getSession(platform, userId);
    if (!session) return { text: '🔒 กรุณาเข้าสู่ระบบก่อน — /login' };

    const m = session.memberData;
    return {
      text:
        `👤 ข้อมูลสมาชิก\n\n` +
        `ชื่อ: ${m.name}\n` +
        `อีเมล: ${m.email}\n` +
        `Tier: ${m.tier}\n` +
        `สถานะ: ${m.status}`,
    };
  }

  async handleAccount(_args, platform, userId) {
    if (!this.authService) return { text: '❌ ระบบสมาชิกไม่พร้อมใช้งาน' };

    const session = await this.authService.getSession(platform, userId);
    if (!session) return { text: '🔒 กรุณาเข้าสู่ระบบก่อน — /login' };

    // Refresh account data
    const data = await this.authService.refreshAccountData(platform, userId);
    if (!data) return { text: '❌ ไม่สามารถดึงข้อมูลบัญชีได้' };

    let text = '💼 บัญชีเทรด\n\n';

    const accounts = Array.isArray(data.accounts) ? data.accounts : (data.accounts?.accounts || []);
    if (accounts.length === 0) {
      text += 'ไม่พบบัญชีเทรด\n';
    } else {
      for (const a of accounts) {
        const login = a.login || a.accountId || a.id || 'N/A';
        const balance = a.balance != null ? `$${this._fmt(a.balance)}` : 'N/A';
        const equity = a.equity != null ? `$${this._fmt(a.equity)}` : 'N/A';
        const leverage = a.leverage ? `1:${a.leverage}` : 'N/A';
        text += `📊 Account ${login}\n`;
        text += `   Balance: ${balance} | Equity: ${equity}\n`;
        text += `   Leverage: ${leverage}\n\n`;
      }
    }

    // Open positions
    const positions = Array.isArray(data.positions) ? data.positions : (data.positions?.positions || data.positions?.data || []);
    if (positions.length > 0) {
      text += '📈 Open Positions:\n';
      for (const p of positions) {
        const sym = p.symbol || 'N/A';
        const type = p.type || p.side || 'N/A';
        const volume = p.volume || p.lots || 'N/A';
        const profit = p.profit != null ? `$${this._fmt(p.profit)}` : 'N/A';
        text += `  ${sym} ${type} ${volume} lots → P/L: ${profit}\n`;
      }
    }

    return { text };
  }

  // ========== Helpers ==========

  /**
   * Unwrap CRM ApiResponse<T> wrapper — returns .data if present
   */
  _unwrap(response) {
    if (!response) return null;
    // CRM wraps everything in { success, data, message, errors }
    if (response.data !== undefined) return response.data;
    return response;
  }

  /**
   * Resolve user input to a CRM-compatible symbol
   */
  _resolveSymbol(input) {
    if (!input) return null;
    const lower = input.toLowerCase().trim();
    if (!lower) return null;

    const map = {
      // Gold
      'xauusd': 'XAUUSD', 'gold': 'XAUUSD', 'ทองคำ': 'XAUUSD', 'ทอง': 'XAUUSD',
      // Silver
      'xagusd': 'XAGUSD', 'silver': 'XAGUSD', 'เงิน': 'XAGUSD',
      // Major Forex
      'eurusd': 'EURUSD', 'gbpusd': 'GBPUSD', 'usdjpy': 'USDJPY',
      'gbpjpy': 'GBPJPY', 'eurjpy': 'EURJPY', 'audusd': 'AUDUSD',
      'nzdusd': 'NZDUSD', 'usdchf': 'USDCHF',
      // Thai keywords
      'ดอลล์': 'EURUSD', 'ยูโร': 'EURUSD',
      'ปอนด์': 'GBPUSD', 'เยน': 'USDJPY',
      'ออสซี่': 'AUDUSD', 'นิวซี': 'NZDUSD',
      'สวิส': 'USDCHF',
      // Crypto
      'btc': 'BTCUSD', 'bitcoin': 'BTCUSD', 'บิทคอยน์': 'BTCUSD',
      'eth': 'ETHUSD', 'ethereum': 'ETHUSD',
      // Oil
      'oil': 'XTIUSD', 'น้ำมัน': 'XTIUSD', 'crude': 'XTIUSD', 'wti': 'XTIUSD',
    };

    // Exact match
    if (map[lower]) return map[lower];

    // Partial match (Thai keywords)
    for (const [keyword, symbol] of Object.entries(map)) {
      if (lower.includes(keyword)) return symbol;
    }

    // If it looks like a forex pair already (e.g. "eurusd"), return uppercased
    if (/^[a-z]{6}$/.test(lower)) return lower.toUpperCase();

    return lower.toUpperCase(); // fallback: pass through
  }

  /**
   * Find tick data for a symbol in the tick stats response
   */
  _findTick(stats, symbol) {
    if (!stats) return null;
    const arr = Array.isArray(stats) ? stats : (stats.data || stats.ticks || []);
    const upper = symbol.toUpperCase();
    return arr.find(t =>
      (t.symbol || t.name || '').toUpperCase() === upper
    ) || null;
  }

  _fmt(num) {
    if (num == null) return 'N/A';
    const n = Number(num);
    if (isNaN(n)) return String(num);
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  _fmtChange(change) {
    const n = Number(change);
    if (isNaN(n)) return String(change);
    const sign = n >= 0 ? '+' : '';
    return `${sign}$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

module.exports = CommandRouter;
