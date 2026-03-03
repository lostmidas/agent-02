import {
  db,
  getConsecutiveHolds,
  getCurrentBalance,
  getImprovementHistory,
  getMarketContext,
  getOpenPositions,
  getPreviousBalance,
  getRankSignal,
  getTokenHistory,
  getTradeCount,
  insertSelfImprovementLog,
} from "../db.ts";
import { MAX_PERSONALITY } from "../prompts/personalities.ts";
import { buildPrompt } from "../prompts/self-improvement.ts";
import type { ParsedResponse } from "./parser.ts";
import { parseResponse } from "./parser.ts";
import { callLLM } from "./llm.ts";
import { writeBackAndRestart } from "./writer.ts";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const AGENT_ID = process.env.AGENT_ID ?? "unknown";
const LLM_RETRY_DELAY_MS = 30_000;
const LLM_TIMEOUT_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getEnvNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function formatOpenPositionsDetail(
  positions: { token_out: string; amount_in: string; created_at: string }[],
): string {
  if (positions.length === 0) {
    return "No open positions";
  }

  return positions
    .map((position) => {
      const heldMs = Math.max(0, Date.now() - new Date(position.created_at).getTime());
      const heldHours = Math.floor(heldMs / (60 * 60 * 1000));
      return `${position.token_out} | $${position.amount_in} | Time held: ${heldHours} hours`;
    })
    .join("\n");
}

function formatTokenHistory(
  history: { token_out: string; count: number; wins: number; losses: number }[],
): string {
  if (history.length === 0) {
    return "No token history";
  }

  return history
    .map(
      (token) =>
        `${token.token_out} | TRADES: ${token.count} | WINS: ${token.wins} | LOSSES: ${token.losses}`,
    )
    .join("\n");
}

function formatImprovementHistory(
  history: {
    cycle_number: number;
    agent_trade_amount: number;
    agent_cooldown_hours: number;
    agent_max_positions: number;
    agent_interval_ms: number;
    reasoning: string;
  }[],
): string {
  if (history.length === 0) {
    return "No improvement history";
  }

  return history
    .map(
      (entry) =>
        `CYCLE ${entry.cycle_number} | trade_amount=$${entry.agent_trade_amount} cooldown=${entry.agent_cooldown_hours} positions=${entry.agent_max_positions} interval=${entry.agent_interval_ms}ms | REASONING: ${entry.reasoning}`,
    )
    .join("\n");
}

async function callLLMWithTimeout(prompt: string): Promise<string> {
  return await Promise.race([
    callLLM(prompt),
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("LLM timeout")), LLM_TIMEOUT_MS);
    }),
  ]);
}

async function getNextCycleNumber(
  agentId: string,
  battleId: string,
): Promise<{ cycleNumber: number; queryFailed: boolean }> {
  try {
    const { data, error } = await db
      .from("self_improvement_log")
      .select("cycle_number")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .order("cycle_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { cycleNumber: 1, queryFailed: true };
    }

    return { cycleNumber: (data?.cycle_number ?? 0) + 1, queryFailed: false };
  } catch {
    return { cycleNumber: 1, queryFailed: true };
  }
}

function makeAbortLogEntry(params: {
  battleId: string;
  cycleNumber: number;
  consecutiveHolds: number;
  reason: string;
}): Parameters<typeof insertSelfImprovementLog>[0] {
  return {
    agent_id: AGENT_ID,
    battle_id: params.battleId,
    cycle_number: params.cycleNumber,
    consecutive_holds: params.consecutiveHolds + 1,
    agent_trade_amount: getEnvNumber("AGENT_TRADE_AMOUNT", 1),
    agent_cooldown_hours: getEnvNumber("AGENT_COOLDOWN_HOURS", 1),
    agent_max_positions: getEnvNumber("AGENT_MAX_POSITIONS", 1),
    agent_interval_ms: getEnvNumber("AGENT_INTERVAL_MS", 180000),
    cycle_assessment: "bad",
    activity_status: "inactive",
    hold: true,
    confidence: "low",
    reasoning: params.reason,
    troll_box: "",
    position_decision: "",
    tokens_to_watch: [],
    raw_response: null,
  };
}

async function abortCycleAndHold(params: {
  battleId: string;
  cycleNumber: number;
  consecutiveHolds: number;
  reason: string;
  message: string;
}): Promise<void> {
  console.error(params.message);
  await insertSelfImprovementLog(
    makeAbortLogEntry({
      battleId: params.battleId,
      cycleNumber: params.cycleNumber,
      consecutiveHolds: params.consecutiveHolds,
      reason: params.reason,
    }),
  );
}

export async function runSelfImprovementCycle(): Promise<void> {
  try {
    const battleId = process.env.BATTLE_ID;
    if (!battleId) {
      console.error(`CRON ERROR: BATTLE_ID missing for ${AGENT_ID} — aborting cycle`);
      return;
    }

    const { cycleNumber, queryFailed } = await getNextCycleNumber(AGENT_ID, battleId);
    console.log(
      `[cron] Starting self-improvement cycle for ${AGENT_ID} — cycle ${String(cycleNumber)}`,
    );

    const consecutiveHolds = await getConsecutiveHolds(AGENT_ID, battleId);

    if (queryFailed) {
      await abortCycleAndHold({
        battleId,
        cycleNumber,
        consecutiveHolds,
        reason: "Cycle number query failed",
        message: `CRON ERROR: Supabase query failed for ${AGENT_ID} — aborting cycle`,
      });
      return;
    }

    const [
      rankSignal,
      currentBalanceFromDb,
      previousBalanceFromDb,
      openPositions,
      tokenHistoryRows,
      marketContextRows,
      improvementHistoryRows,
      tradeCount,
    ] = await Promise.all([
      getRankSignal(AGENT_ID, battleId),
      getCurrentBalance(AGENT_ID, battleId),
      getPreviousBalance(AGENT_ID, battleId),
      getOpenPositions(AGENT_ID, battleId),
      getTokenHistory(AGENT_ID, battleId),
      getMarketContext(AGENT_ID, battleId),
      getImprovementHistory(AGENT_ID, battleId),
      getTradeCount(AGENT_ID, battleId),
    ]);

    const requiredQueriesFailed =
      rankSignal == null ||
      openPositions == null ||
      tokenHistoryRows == null ||
      marketContextRows == null ||
      improvementHistoryRows == null ||
      tradeCount == null;

    if (requiredQueriesFailed) {
      await abortCycleAndHold({
        battleId,
        cycleNumber,
        consecutiveHolds,
        reason: "One or more required Supabase queries returned null",
        message: `CRON ERROR: Supabase query failed for ${AGENT_ID} — aborting cycle`,
      });
      return;
    }

    const currentBalance = currentBalanceFromDb ?? 0;
    const previousBalance = previousBalanceFromDb ?? currentBalance;
    const cyclePnl = currentBalance - previousBalance;
    const tradeAmount = getEnvNumber("AGENT_TRADE_AMOUNT", 1);
    const cooldownHours = getEnvNumber("AGENT_COOLDOWN_HOURS", 1);
    const maxPositions = getEnvNumber("AGENT_MAX_POSITIONS", 1);
    const intervalMs = getEnvNumber("AGENT_INTERVAL_MS", 180000);

    const prompt = buildPrompt({
      personality: MAX_PERSONALITY,
      rankSignal,
      tradeAmount,
      cooldownHours,
      maxPositions,
      intervalMs,
      currentBalance,
      previousBalance,
      cyclePnl,
      openPositionsCount: openPositions.length,
      openPositionsDetail: formatOpenPositionsDetail(openPositions),
      tokenHistory: formatTokenHistory(tokenHistoryRows),
      marketContext:
        marketContextRows.length > 0 ? marketContextRows.join("\n") : "No market data available",
      improvementHistory: formatImprovementHistory(improvementHistoryRows),
      tradeCount: tradeCount.completed,
      failedTradeCount: tradeCount.failed,
      consecutiveHolds,
    });

    let rawResponse: string;
    try {
      rawResponse = await callLLMWithTimeout(prompt);
    } catch {
      await sleep(LLM_RETRY_DELAY_MS);
      try {
        rawResponse = await callLLMWithTimeout(prompt);
      } catch (error) {
        await abortCycleAndHold({
          battleId,
          cycleNumber,
          consecutiveHolds,
          reason: `LLM failed after retry: ${getErrorMessage(error)}`,
          message: `CRON ERROR: LLM failed after retry for ${AGENT_ID} — aborting cycle`,
        });
        return;
      }
    }

    let parsed: ParsedResponse;
    try {
      parsed = parseResponse(rawResponse);
    } catch (error) {
      await abortCycleAndHold({
        battleId,
        cycleNumber,
        consecutiveHolds,
        reason: `Parse failure: ${getErrorMessage(error)}`,
        message: `CRON ERROR: Failed to parse self-improvement response for ${AGENT_ID} — aborting cycle`,
      });
      return;
    }

    const nextConsecutiveHolds = parsed.hold ? consecutiveHolds + 1 : 0;
    await insertSelfImprovementLog({
      agent_id: AGENT_ID,
      battle_id: battleId,
      cycle_number: cycleNumber,
      consecutive_holds: nextConsecutiveHolds,
      agent_trade_amount: parsed.parameters.AGENT_TRADE_AMOUNT,
      agent_cooldown_hours: parsed.parameters.AGENT_COOLDOWN_HOURS,
      agent_max_positions: parsed.parameters.AGENT_MAX_POSITIONS,
      agent_interval_ms: parsed.parameters.AGENT_INTERVAL_MS,
      cycle_assessment: parsed.cycle_assessment,
      activity_status: parsed.activity_status,
      hold: parsed.hold,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      troll_box: parsed.troll_box,
      position_decision: parsed.position_decision,
      tokens_to_watch: parsed.tokens_to_watch,
      raw_response: rawResponse,
    });

    await writeBackAndRestart(parsed.parameters);
  } catch (error) {
    console.error(`CRON CRITICAL: Unhandled error for ${AGENT_ID} — ${getErrorMessage(error)}`);
  }
}

export function startSelfImprovementCron(): void {
  setTimeout(() => {
    void runSelfImprovementCycle();
    setInterval(() => {
      void runSelfImprovementCycle();
    }, TWO_HOURS_MS);
  }, TWO_HOURS_MS);
}
