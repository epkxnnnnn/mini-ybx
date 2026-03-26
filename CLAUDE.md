# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YBX Chatbot is a multi-platform AI trading assistant for Yellow Box Markets, providing comprehensive trading analysis (TA, FA, Sentiment). It serves users across Telegram, Discord, LINE, and a web chat interface, all powered by a single AI engine.

## Commands

```bash
npm install          # Install dependencies
npm start            # Production: node src/server.js
npm run dev          # Development: nodemon with auto-restart
```

The server runs on `http://localhost:3000` by default (configurable via `PORT` env var).

## Architecture

**Unified AI Engine pattern**: A single `YBXAIEngine` class (`src/ai-engine.js`) handles all AI interactions. Each platform bot receives messages, delegates to the shared engine, and formats responses for its platform.

```
User Message → Platform Bot Handler → YBXAIEngine.chat() → Claude API → Platform-formatted Response
```

### Key Files

- `src/server.js` — Express server, REST API endpoints, bot initialization
- `src/ai-engine.js` — Gemini API integration (`@google/genai`), conversation memory (in-memory Map keyed by `platform:userId`), symbol detection, Finnhub price fetching
- `src/system-prompt.md` — Complete trading analysis knowledge base and AI behavior rules (the system prompt)
- `src/bots/telegram.js` — Telegram bot (long-polling mode)
- `src/bots/discord.js` — Discord bot (slash commands + message events, REST-based command registration)
- `src/bots/line.js` — LINE bot (webhook at `/webhook/line`)
- `public/index.html` — Web chat demo UI

### API Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/chat` | POST | Web chat (requires `message` + `userId`) |
| `/api/reset` | POST | Clear user conversation history |
| `/api/health` | GET | Service status + which bots are enabled |
| `/webhook/tradingview` | POST | TradingView signal receiver (broadcasting TODO) |
| `/webhook/line` | POST | LINE bot webhook |

### Conversation Memory

In-memory `Map` stores last 20 messages per user, keyed by `platform:userId`. No database — state is lost on restart.

### Symbol Detection

`detectSymbol()` in `ai-engine.js` maps Thai and English asset names (e.g., "ทองคำ", "Gold", "XAUUSD") to Finnhub-compatible symbols. When detected, real-time price data is fetched and injected into the user's message before sending to Claude.

## Environment Variables

Only `GEMINI_API_KEY` is required. Optionally set `GEMINI_MODEL` (defaults to `gemini-2.5-flash`). All bot tokens are optional — bots only start if their token is present. See `.env.example` for the full list.

## Platform-Specific Constraints

- **Telegram**: 4096 char message limit, messages are split automatically
- **Discord**: 2000 char limit, responses chunked; slash commands registered via REST API
- **LINE**: Max 5 messages × 4500 chars per response; webhook validation via channel secret

## Conventions

- CommonJS modules (`require`/`module.exports`)
- Vanilla Node.js — no TypeScript, no build step, no bundler
- Each bot setup function takes `aiEngine` as a parameter (LINE also takes `app` for webhook registration)
- No linting or test configuration exists
