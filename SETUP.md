# YBX Chatbot — Setup Guide

## Quick Start (5 minutes)

### 1. Install Dependencies
```bash
cd ybx-chatbot
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

Edit `.env` and add your keys:
```
GEMINI_API_KEY=xxxxx                 # Required — powers the AI
GEMINI_MODEL=gemini-2.5-flash       # Optional — default: gemini-2.5-flash
TELEGRAM_BOT_TOKEN=xxx             # Optional — enable Telegram
DISCORD_BOT_TOKEN=xxx              # Optional — enable Discord
DISCORD_APP_ID=xxx                 # Optional — for slash commands
LINE_CHANNEL_ACCESS_TOKEN=xxx      # Optional — enable LINE
LINE_CHANNEL_SECRET=xxx            # Optional — enable LINE
FINNHUB_API_KEY=xxx                # Optional — real-time prices
```

### 3. Run
```bash
npm start
```

Open http://localhost:3000 for the web chat demo.

---

## Platform Setup

### Telegram
1. Talk to [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` → name it "Yellow Box Markets"
3. Copy the token → paste in `.env` as `TELEGRAM_BOT_TOKEN`
4. Set commands: `/setcommands` →
   ```
   analyze - วิเคราะห์ตลาดด้วย ENGULF-X
   checklist - เช็คลิสต์ 5 ขั้นตอน
   zones - ตาราง Zone Priority
   reset - เริ่มบทสนทนาใหม่
   ```

### Discord
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create application → "Yellow Box Markets"
3. Go to Bot → create bot → copy token → `DISCORD_BOT_TOKEN`
4. Copy Application ID → `DISCORD_APP_ID`
5. Go to OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Permissions: Send Messages, Read Message History, Embed Links
6. Use generated URL to invite bot to your server

### LINE
1. Go to [LINE Developers Console](https://developers.line.biz/)
2. Create Provider → Create Messaging API Channel
3. Copy Channel Secret → `LINE_CHANNEL_SECRET`
4. Issue Channel Access Token → `LINE_CHANNEL_ACCESS_TOKEN`
5. Set webhook URL: `https://your-domain.com/webhook/line`
6. Enable "Use webhook" toggle

### Finnhub (Real-time Prices)
1. Sign up at [finnhub.io](https://finnhub.io/)
2. Copy API key → `FINNHUB_API_KEY`
3. Free tier: 60 calls/min (sufficient for chatbot)

---

## Deployment

### Option A: Railway.app (Easiest)
```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway login
railway init
railway up
```

### Option B: Vercel + Serverless
Not ideal for this — bots need persistent connections.

### Option C: VPS (DigitalOcean, AWS EC2)
```bash
# On your server
git clone <your-repo>
cd ybx-chatbot
npm install
cp .env.example .env
# Edit .env with your keys

# Run with PM2 (production)
npm i -g pm2
pm2 start src/server.js --name ybx-chatbot
pm2 save
pm2 startup
```

### Option D: Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t ybx-chatbot .
docker run -d --env-file .env -p 3000:3000 ybx-chatbot
```

---

## Architecture

```
ybx-chatbot/
├── src/
│   ├── server.js              # Express server + bot launcher
│   ├── ai-engine.js           # Claude AI + conversation memory
│   ├── engulfx-system-prompt.md  # ENGULF-X knowledge base
│   └── bots/
│       ├── telegram.js        # Telegram bot
│       ├── discord.js         # Discord bot (+ slash commands)
│       └── line.js            # LINE bot (webhook)
├── public/
│   └── index.html             # Web chat demo UI
├── .env.example
├── package.json
└── SETUP.md
```

### How It Works
1. User sends message on any platform (Telegram/Discord/LINE/Web)
2. Platform bot routes message → `ai-engine.js`
3. AI Engine optionally fetches real-time price from Finnhub
4. AI Engine sends message + ENGULF-X system prompt → Claude API
5. Claude responds using ENGULF-X methodology only
6. Response sent back to user on their platform

### Per-User Memory
Each user gets their own conversation history (last 20 messages), keyed by `platform:userId`. Reset with `/reset` command.

---

## Customization

### Change AI Model
Set `GEMINI_MODEL` in `.env`:
- `gemini-2.5-flash` — fast, cheap (default)
- `gemini-2.5-pro` — most capable, higher cost
- `gemini-2.5-flash-lite` — fastest, cheapest

### Add More Symbols
In `ai-engine.js` → `detectSymbol()`, add entries to `symbolMap`.

### Modify Bot Personality
Edit `src/engulfx-system-prompt.md` — this is the complete knowledge base and behavior rules.

### Add TradingView Signal Broadcasting
The `/webhook/tradingview` endpoint is ready. Add logic to broadcast signals to subscribed users across platforms.

---

## Cost Estimate

| Component | Cost |
|-----------|------|
| Gemini API (2.5 Flash) | ~$0.0003/message |
| Finnhub API | Free (60 calls/min) |
| Railway hosting | $5/mo |
| **Total for 1000 msgs/day** | **~$14/mo** |

Switch to `gemini-2.5-pro` for more capable responses (~$0.01/message).
