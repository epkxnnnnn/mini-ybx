# Mini App Live Data QA Checklist

Use this checklist to verify that the Telegram Mini App is reading live CRM/member data instead of local placeholders.

## Preconditions

- CRM backend is reachable from `YBX_CRM_BASE_URL`
- Telegram Mini App user is logged in through `/api/webapp/login`
- CRM AI endpoints are enabled and healthy
- CRM live prices include fresh timestamps

## Route Map

### Authentication and profile

- `GET /api/webapp/profile`
  - Expected source: live member profile + live trading accounts
  - Verify:
    - member name/tier matches member portal
    - total balance matches live CRM accounts
    - premium access reflects current tier/balance

- `POST /api/webapp/login`
  - Expected source: CRM member auth
  - Verify:
    - valid credentials log in
    - invalid credentials return a user-facing error

- `POST /api/webapp/logout`
  - Expected source: local app session reset
  - Verify:
    - Mini App returns to login screen
    - chat state is cleared

### Market data

- `GET /api/webapp/prices`
  - Expected source: CRM live prices + CRM tick stats
  - Verify:
    - bid/ask/high/low change values update
    - freshness label shows `LIVE`, `DELAYED`, or `UNVERIFIED`
    - timestamps move forward on refresh

- `GET /api/webapp/calendar`
  - Expected source: CRM economic calendar
  - Verify:
    - upcoming events match CRM/member portal

- `GET /api/webapp/rate`
  - Expected source: CRM exchange-rate endpoint
  - Verify:
    - displayed funding rate matches member portal

- `GET /api/webapp/analysis/:symbol`
  - Expected source: CRM AI market analysis
  - Verify:
    - symbol-specific AI analysis exists for active symbols
    - summary/sentiment/technical sections align with member portal

### Accounts and funding

- `GET /api/webapp/accounts`
  - Expected source: live member trading accounts
  - Verify:
    - account count/logins/balances match member portal

- `GET /api/webapp/wallets`
  - Expected source: live member wallets
  - Verify:
    - wallet balances match member portal

- `GET /api/webapp/bank-accounts`
  - Expected source: live member bank accounts
  - Verify:
    - verified bank list matches member portal

- `GET /api/webapp/payment-provider`
  - Expected source: live active payment provider
  - Verify:
    - provider name matches deployment expectation

- `GET /api/webapp/transactions`
  - Expected source: live member transactions
  - Verify:
    - latest deposit/withdraw/transfer records appear

- `GET /api/webapp/transactions/summary`
  - Expected source: live member transaction summary
  - Verify:
    - summary cards match transaction history

- `POST /api/webapp/deposit`
  - Expected source: live CRM payment endpoint
  - Verify:
    - deposit request succeeds with correct provider flow
    - provider-specific response payload is returned

- `POST /api/webapp/withdraw`
  - Expected source: live CRM withdrawal endpoint
  - Verify:
    - requires valid MT5 account + bank account
    - result appears in transactions/support flow

- `POST /api/webapp/transfer`
  - Expected source: live CRM transfer endpoint
  - Verify:
    - wallet-to-MT5 works
    - MT5-to-wallet works
    - balances update after refresh

### AI signals and insights

- `GET /api/webapp/ai-signals`
  - Expected source: CRM AI signals feed
  - Verify:
    - symbols/confidence/entry/SL/TP match member portal
    - no heuristic-only signals appear

- `POST /api/webapp/signal-detail`
  - Expected source: CRM AI signal-detail endpoint
  - Verify:
    - expanding a signal shows deep analysis
    - key levels, risk assessment, market context, and trade management populate

- `GET /api/webapp/portfolio`
  - Expected source: live member accounts + live risk panel + CRM AI portfolio advice + live account positions
  - Verify:
    - default selected account is the one with open positions when available
    - switching account changes all stats and positions
    - balance/equity/free margin/margin level match member portal
    - positions table matches account-specific open positions
    - recommendations and scores match AI portfolio advice

### Journal

- `GET /api/webapp/journal`
  - Expected source: live CRM trade journal
  - Verify:
    - closed trades sync from MT5 history
    - filters/pagination work

- `GET /api/webapp/journal/stats`
  - Expected source: live CRM journal stats
  - Verify:
    - win rate and summary stats match member portal

- `PUT /api/webapp/journal/:id/notes`
  - Expected source: live CRM journal update
  - Verify:
    - setup tag, notes, and rating save successfully
    - refresh preserves edits

### Notifications and support

- `GET /api/webapp/notifications`
  - Expected source: live member notifications
  - Verify:
    - latest notifications match member portal

- `GET /api/webapp/support`
  - Expected source: live support tickets
  - Verify:
    - existing tickets appear

- `POST /api/webapp/support`
  - Expected source: live support ticket creation
  - Verify:
    - new ticket is created and visible after refresh

### Chat

- `POST /api/webapp/chat`
  - Expected source: Jerry AI engine with live member context
  - Verify:
    - account-aware replies work
    - Guardian behavior is respected
    - live trade setup requests fail safely when price freshness is not live

## Screen QA

### Home

- Name and balance load correctly
- Top setups come from CRM AI signals
- Summary cards match live portfolio and funding data

### Market

- Prices refresh
- Freshness labels update
- Chart opens correctly
- News loads from TradingView

### Signals

- AI signals list matches member portal
- Expand a signal and verify deep analysis is not empty
- Save-to-journal behavior points users to the auto journal flow

### Portfolio

- Account selector defaults sensibly
- Open positions show on the correct account
- Risk and recommendation sections are populated

### Journal

- Auto-synced trades appear
- Notes/rating/save flow works

### Account/Funding

- Deposit, withdraw, transfer, wallets, bank accounts, and transaction history all match CRM

### Support

- Notifications and tickets both load
- Ticket creation works

## Known External Dependencies

- Chart modal uses TradingView embed
- News widget uses TradingView embed
- Price truth still depends on CRM tick freshness and timestamp quality

## Failure Signals

If any of these happen, treat the route as not production-ready:

- empty arrays when member portal clearly has data
- account selector shows the wrong MT5 login by default
- signal detail opens but only shows generic text
- positions missing for an account with known open trades
- funding actions succeed in UI but do not appear in CRM history
- price freshness stuck on `UNVERIFIED` after CRM timestamp fix is deployed
