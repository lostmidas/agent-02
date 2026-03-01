# agent.md
*Cursor's rules of engagement for the Agent Battle project*

---

## What We're Building

Agent Battle is a live experiment where two self-evolving autonomous trading agents — ZERO and MAX — compete against each other on Base over a configurable battle duration. Every 4 hours, each agent reviews its own trading performance and rewrites its own strategy parameters using a self-improvement prompt powered by Claude via Bankr's LLM Gateway. The agents pay for their own inference from their trading wallets. Spectators watch the battle unfold in real time through a separate dashboard that surfaces each agent's PnL, trades, reasoning, troll box, and scoreboard.

**Three repos, clean separation:**

| Repo | Purpose | Does NOT |
|---|---|---|
| `agent-01` | ZERO's trading agent — trades, logs to Supabase, self-improves every 4 hours | Display anything, know opponent's strategy |
| `agent-02` | MAX's trading agent — identical structure, different identity | Display anything, know opponent's strategy |
| `agent-battle` | Battle dashboard — reads Supabase, displays everything spectators see | Trade, write to Supabase, contain agent logic |

Each repo is independent. Changes to one repo must never require changes to another.

---

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js + tsx
- **Trading:** Bankr CLI (`@bankr/cli`) — `submitPrompt` and `pollJob`
- **Self-improvement LLM:** Claude via Bankr LLM Gateway (`https://llm.bankr.bot`)
- **Database:** Supabase — shared across both agents, separated by `agent_id` and `battle_id`
- **Dashboard:** Next.js
- **Cron:** node-cron — fires every 4 hours per agent
- **Environment:** dotenvx

---

## Build Order

Always build in this exact order. Never skip steps. Never combine steps.

```
Step 0  — Repo setup (fork, clean, configure env files, confirm boots)
Step 1  — Supabase migration (add columns, create tables, add indexes)
Step 2  — Supabase query layer (functions that fetch each prompt data point)
Step 3  — Prompt assembly (src/prompts/self-improvement.ts with typed params)
Step 4  — LLM Gateway test (manual call to confirm Bankr responds before cron)
Step 5  — LLM call (send assembled prompt, log raw response, don't parse yet)
Step 6  — Response parsing + validation (parse JSON, clamp out-of-bounds values)
Step 7  — Write back (atomic .env.local update + agent restart)
Step 8  — Cron wiring (wrap steps 2-7 in node-cron, staggered start times)
Step 9  — Battle scripts (battle:start, battle:status, battle:end)
Step 10 — Dashboard (round UI, troll box feed, scoreboard, countdown)
```

To start a session, tell Cursor: **"We are on step X"** and reference this file.

---

## Wallet Addresses

- agent-01 (ZERO): `0x08824c2b8428c4e8f48ea3c522b31c349f799f29`
- agent-02 (MAX): `0xdfc6919e7cfba037988af43b2e07c8eb0cb86d41`
- RSI agent (separate, do not touch): `0x001ddfd18f6849e014224f41e464ccf18bf7f5e1`

---

## Starting Seeds

ZERO and MAX start with different parameters to guarantee immediate divergence:

**ZERO (agent-01):**
```
AGENT_TRADE_AMOUNT=0.50
AGENT_COOLDOWN_HOURS=4
AGENT_MAX_POSITIONS=1
AGENT_INTERVAL_MS=300000
AGENT_SLIPPAGE=3
```

**MAX (agent-02):**
```
AGENT_TRADE_AMOUNT=2.00
AGENT_COOLDOWN_HOURS=0.5
AGENT_MAX_POSITIONS=4
AGENT_INTERVAL_MS=180000
AGENT_SLIPPAGE=3
```

**Hard rails (never mutated by agent):**
```
AGENT_MAX_DAILY_LOSS_PCT=10
AGENT_MAX_TRADE_PCT=15
AGENT_DRY_RUN=false
```

---

## Mutation Bounds

Agent may only change parameters within these ranges:

| Variable | Min | Max |
|---|---|---|
| `AGENT_TRADE_AMOUNT` | 0.50 | 5.00 |
| `AGENT_COOLDOWN_HOURS` | 0.5 | 8 |
| `AGENT_MAX_POSITIONS` | 1 | 4 |
| `AGENT_INTERVAL_MS` | 180000 | 600000 |

Out-of-bounds values must be clamped, not rejected.

---

## LLM Gateway Setup

Run in each agent repo before building the cron:
```bash
bankr llm setup claude
```

This sets `ANTHROPIC_BASE_URL=https://llm.bankr.bot` and wires auth to the Bankr API key. Do NOT use a personal Anthropic key for the self-improvement cron — agents must pay for their own inference.

Test before building:
```bash
curl https://llm.bankr.bot/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <bankr-api-key>" \
  -d '{"model": "claude-haiku-4-5-20251001", "max_tokens": 100, "messages": [{"role": "user", "content": "say hello"}]}'
```

If this times out, stop and flag it. Do not proceed.

---

## Cron Architecture

- agent-01 cron fires at :00 every 4 hours
- agent-02 cron fires at :15 every 4 hours (staggered to prevent API hammering)
- Each cron is wrapped in a top-level try/catch — never crashes, always schedules next cycle

**Parameter write-back sequence:**
1. Check for in-flight trades — wait for resolution if pending
2. Write new parameters to temp file
3. Atomic rename temp file to `.env.local`
4. Restart agent process
5. Confirm restart (wallet address appears in logs)

**Error handling — every scenario must be handled explicitly:**

| Scenario | Action |
|---|---|
| Supabase query fails | Abort, hold, consecutive_holds +1 |
| Prompt assembly fails | Abort, hold, consecutive_holds +1 |
| LLM Gateway timeout | Retry once after 30s, then abort |
| Malformed JSON | Abort, log raw response |
| Parameter out of bounds | Clamp to nearest bound, log warning |
| Supabase write fails | Retry once, still update .env.local |
| Agent restart fails | Retry after 10s, log CRON CRITICAL |
| Unhandled error | Log CRON CRITICAL, hold |

**Log format:**
```
CRON ERROR: [description] for [agent_id] — [error]
CRON WARNING: [description] for [agent_id]
CRON CRITICAL: Unhandled error for [agent_id] — [error]
```

---

## Prompt Template Location

```
src/prompts/self-improvement.ts   — typed template function, all placeholders as params
src/prompts/personalities.ts      — ZERO_PERSONALITY and MAX_PERSONALITY constants
```

Full prompt templates in agent-battle-prompts.md.

---

## Battle Scripts

```bash
npm run battle:start   # validates env, creates battle record, sets BATTLE_ID, prints next steps
npm run battle:status  # current battle state, balances, round number
npm run battle:end     # marks complete, stops crons, prints final results
```

Script location: `scripts/battle-start.ts`

---

## Dashboard Requirements

**Core requirements (v1):**
- Scoreboard — both agent balances, PnL, round number
- Round UI — "ROUND X COMPLETE" state, countdown to next round ("ROUND X+1 STARTS IN 3:47:22")
- Agent corners — reasoning, troll box, parameter changes with directional indicators (↑↓)
- Troll box feed — unified chronological feed, both agents interleaved, avatar/name per message
- Placeholder section for announcer commentary (empty in v1, ready for v1.5)

**Dashboard battle query:**
```sql
SELECT * FROM battles WHERE status = 'active' ORDER BY started_at DESC LIMIT 1
```

No active battle → waiting state. Battle ended → results view with full troll box replay.

---

## ⚠️ Known Landmines — Address Before Building

1. **Bankr reliability** — get one clean agent-01 cycle before building cron
2. **In-flight trades** — cron must wait for pending trades before restarting
3. **Cron staggering** — agent-01 at :00, agent-02 at :15
4. **RSI agent** — must be stopped before running Supabase migration
5. **LLM Gateway cold start** — test manual curl before building cron
6. **Atomic file write** — temp file + rename, never write directly to .env.local
7. **No rollback** — known v1 limitation, expected behavior

---

## Rules

- **One step at a time.** Complete and verify before starting the next.
- **No file outside current step's scope gets touched.** Flag it if a fix requires touching unrelated files.
- **No new architecture.** Use what exists. Ask before adding libraries.
- **No speculative features.** Build exactly what is specified.
- **Compile and test before declaring done.** Not done until it runs without errors.
- **No silent failures.** Every error must be logged explicitly.
- **Aggressive logging during development.** Every major cron step logs inputs and outputs.
- **Ask before refactoring.** Flag messy code, don't silently rewrite it.

---

## How To Handle Uncertainty

1. Stop.
2. State exactly what is unclear.
3. Propose two options maximum.
4. Wait for a decision.

Do not guess. Do not assume. Do not proceed with uncertainty.

---

## Definition of Done

A step is complete when:
- [ ] Code runs without errors
- [ ] Console output confirms expected behavior
- [ ] Supabase shows correct data (where applicable)
- [ ] No unrelated files were modified
- [ ] Next step's prerequisites are met

---

## Never Do

- Never modify both agent repos in the same step
- Never write trading logic in agent-battle
- Never read one agent's strategy from the other agent
- Never hardcode wallet addresses, API keys, or secrets
- Never use personal Anthropic API key for self-improvement cron
- Never swallow errors silently
- Never introduce a dependency without asking
- Never refactor working code without explicit instruction
- Never combine multiple build steps into one
- Never declare done without testing
- Never write directly to .env.local — always atomic temp file rename
- Never start cron build before confirming LLM Gateway works manually
