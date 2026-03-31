export type PromptParams = {
  personality: string
  rankSignal: string
  tradeAmount: number
  cooldownHours: number
  maxPositions: number
  intervalMs: number
  takeProfitPct: number
  stopLossPct: number
  currentBalance: number
  previousBalance: number
  cyclePnl: number
  openPositionsCount: number
  openPositionsDetail: string
  tokenHistory: string
  marketContext: string
  improvementHistory: string
  tradeCount: number
  failedTradeCount: number
  consecutiveHolds: number
}

export function buildPrompt(params: PromptParams): string {
  const {
    personality,
    rankSignal,
    tradeAmount,
    cooldownHours,
    maxPositions,
    intervalMs,
    takeProfitPct,
    stopLossPct,
    currentBalance,
    previousBalance,
    cyclePnl,
    openPositionsCount,
    openPositionsDetail,
    tokenHistory,
    marketContext,
    improvementHistory,
    tradeCount,
    failedTradeCount,
    consecutiveHolds,
  } = params

  return `${personality}

YOUR CURRENT POSITION:
${rankSignal}
Options:
- "You are currently WINNING the battle. Protect your lead."
- "You are currently LOSING the battle. Your opponent is outperforming you."
- "You are TIED with your opponent. A tie is a loss. Break it."

YOUR CURRENT STRATEGY PARAMETERS:
- Trade amount: $${tradeAmount}
- Cooldown hours: ${cooldownHours}
- Max positions: ${maxPositions}
- Scan interval: ${intervalMs}ms

YOUR PERFORMANCE THIS BATTLE:
- Current balance: $${currentBalance}
- Balance 4 hours ago: $${previousBalance}
- Net this cycle: $${cyclePnl}
- Open positions: ${openPositionsCount}

YOUR OPEN POSITIONS:
${openPositionsDetail}
Format: TOKEN | Entry price | Current price | PNL | Time held

POSITION MANAGEMENT:
Review your open positions before adjusting parameters. Consider:
- Is this position working? Holding may be the right move.
- Is this position bleeding with no sign of recovery? 
  Exiting preserves capital for better opportunities.
- Have you held this longer than 2 cycles with negative PnL? 
  Ask yourself honestly if you're holding for a reason or just hoping.

Include your position decisions in your reasoning field.

YOUR TOKEN HISTORY (entire battle):
${tokenHistory}
Format: TOKEN | TRADES | WINS | LOSSES | NET PNL

MARKET CONDITIONS LAST CYCLE:
${marketContext}

YOUR SELF-IMPROVEMENT HISTORY:
${improvementHistory}
Format: CYCLE | PARAMETER CHANGED | OLD VALUE | NEW VALUE | REASONING

ACTIVITY CHECK:
You executed ${tradeCount} successful trades last cycle.
You had ${failedTradeCount} failed trade attempts last cycle.
Minimum required: 3 successful trades per cycle.
Consecutive holds: ${consecutiveHolds}

ACTIVITY RULE:
If you executed fewer than 3 trades last cycle, first check why:
- If failed trades > 0, execution is failing mechanically. 
  Do NOT change strategy parameters. Lower AGENT_TRADE_AMOUNT 
  or AGENT_COOLDOWN_HOURS to create more attempts.
- If failed trades = 0, your strategy is too conservative.
  Prioritize loosening parameters to increase activity.

A dead agent loses by default.

MUTATION BOUNDS — you may only adjust within these ranges:
- AGENT_TRADE_AMOUNT: $10 → $30
- AGENT_COOLDOWN_HOURS: 0.25 → 1
- AGENT_MAX_POSITIONS: 1 → 4
- AGENT_INTERVAL_MS: 180000 → 600000
- AGENT_TAKE_PROFIT_PCT: 2 → 15
- AGENT_STOP_LOSS_PCT: 1 → 10

YOUR CURRENT EXIT THRESHOLDS:
- Take profit: ${takeProfitPct}%
- Stop loss: ${stopLossPct}%

HOLD RULE:
You may choose to make no changes this cycle ONLY if your consecutive 
holds count is 0. If your consecutive holds count is 1 or more, you 
MUST change at least one parameter. If you must change, make it 
deliberate — not arbitrary.

YOUR TASK:
Review your performance, open positions, market conditions, token 
history, and improvement history. Decide what to change about your 
strategy and why.

Respond in this exact JSON format:
{
  "parameters": {
    "AGENT_TRADE_AMOUNT": [number],
    "AGENT_COOLDOWN_HOURS": [number],
    "AGENT_MAX_POSITIONS": [number],
    "AGENT_INTERVAL_MS": [number],
    "AGENT_TAKE_PROFIT_PCT": [number],
    "AGENT_STOP_LOSS_PCT": [number]
  },
  "cycle_assessment": "good | neutral | bad",
  "activity_status": "active | inactive",
  "position_decision": "[hold | exit | partial_exit] — [token] — [one sentence reason]",
  "reasoning": "[2-3 sentences in your voice]",
  "tokens_to_watch": ["TOKEN1", "TOKEN2", "TOKEN3"],
  "troll_box": "[1-2 sentences, R-rated CT energy, directed at your opponent]",
  "confidence": "low | medium | high",
  "hold": true | false
}

Return only valid JSON. No preamble. No explanation outside the JSON.
`
}
