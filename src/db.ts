import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

export const db = createClient(supabaseUrl, supabaseKey);

export type LogType =
  | "prompt"
  | "response"
  | "trade"
  | "error"
  | "balance_update"
  | "analysis"
  | "scanning"
  | "system";

export async function log(
  type: LogType,
  content: string,
  extra?: {
    raw_data?: unknown;
    job_id?: string;
    thread_id?: string;
    agent_id?: string;
    battle_id?: string;
  }
) {
  const { error } = await db.from("agent_logs").insert({
    type,
    content,
    raw_data: extra?.raw_data ?? null,
    job_id: extra?.job_id ?? null,
    thread_id: extra?.thread_id ?? null,
    agent_id: extra?.agent_id ?? null,
    battle_id: extra?.battle_id ?? null,
  });
  if (error) console.error("[db] Failed to log:", error.message);
}

export async function insertTrade(trade: {
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out?: string;
  status: "pending" | "completed" | "failed";
  job_id?: string;
  tx_hash?: string;
  raw_response?: unknown;
  agent_id?: string;
  battle_id?: string;
}) {
  const { data, error } = await db
    .from("trades")
    .insert({
      token_in: trade.token_in,
      token_out: trade.token_out,
      amount_in: trade.amount_in,
      amount_out: trade.amount_out ?? null,
      status: trade.status,
      job_id: trade.job_id ?? null,
      tx_hash: trade.tx_hash ?? null,
      raw_response: trade.raw_response ?? null,
      agent_id: trade.agent_id ?? null,
      battle_id: trade.battle_id ?? null,
    })
    .select()
    .single();

  if (error) console.error("[db] Failed to insert trade:", error.message);
  return data;
}

export async function updateTrade(
  id: string,
  updates: { status?: string; amount_out?: string; tx_hash?: string; raw_response?: unknown }
) {
  const { error } = await db.from("trades").update(updates).eq("id", id);
  if (error) console.error("[db] Failed to update trade:", error.message);
}

export async function insertBalance(
  total_usd: number,
  breakdown: Record<string, number>,
  agent_id?: string,
  battle_id?: string
) {
  const { error } = await db
    .from("balances")
    .insert({ total_usd, breakdown, agent_id: agent_id ?? null, battle_id: battle_id ?? null });
  if (error) console.error("[db] Failed to insert balance:", error.message);
}

export async function getCurrentBalance(agentId: string, battleId: string): Promise<number | null> {
  try {
    const { data, error } = await db
      .from("balances")
      .select("total_usd")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[db] getCurrentBalance error:", error.message);
      return null;
    }
    return data?.total_usd ?? null;
  } catch (err) {
    console.error("[db] getCurrentBalance unexpected error:", err);
    return null;
  }
}

export async function getPreviousBalance(agentId: string, battleId: string): Promise<number | null> {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("balances")
      .select("total_usd")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .lte("created_at", fourHoursAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[db] getPreviousBalance error:", error.message);
      return null;
    }
    return data?.total_usd ?? null;
  } catch (err) {
    console.error("[db] getPreviousBalance unexpected error:", err);
    return null;
  }
}

export async function getOpenPositions(
  agentId: string,
  battleId: string
): Promise<{ token_out: string; amount_in: string; created_at: string }[]> {
  try {
    const { data, error } = await db
      .from("trades")
      .select("token_out, amount_in, created_at")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .eq("status", "pending");
    if (error) {
      console.error("[db] getOpenPositions error:", error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error("[db] getOpenPositions unexpected error:", err);
    return [];
  }
}

export async function getTokenHistory(
  agentId: string,
  battleId: string
): Promise<{ token_out: string; count: number; wins: number; losses: number }[]> {
  try {
    const { data, error } = await db
      .from("trades")
      .select("token_out, status")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .in("status", ["completed", "failed"]);
    if (error) {
      console.error("[db] getTokenHistory error:", error.message);
      return [];
    }
    if (!data || data.length === 0) return [];

    const map = new Map<string, { count: number; wins: number; losses: number }>();
    for (const row of data) {
      const entry = map.get(row.token_out) ?? { count: 0, wins: 0, losses: 0 };
      entry.count += 1;
      if (row.status === "completed") entry.wins += 1;
      if (row.status === "failed") entry.losses += 1;
      map.set(row.token_out, entry);
    }
    return Array.from(map.entries()).map(([token_out, stats]) => ({ token_out, ...stats }));
  } catch (err) {
    console.error("[db] getTokenHistory unexpected error:", err);
    return [];
  }
}

export async function getMarketContext(agentId: string, battleId: string): Promise<string[]> {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("agent_logs")
      .select("content")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .eq("type", "analysis")
      .gte("created_at", fourHoursAgo);
    if (error) {
      console.error("[db] getMarketContext error:", error.message);
      return [];
    }
    return data?.map((r) => r.content) ?? [];
  } catch (err) {
    console.error("[db] getMarketContext unexpected error:", err);
    return [];
  }
}

export async function getImprovementHistory(agentId: string, battleId: string): Promise<any[]> {
  try {
    const { data, error } = await db
      .from("self_improvement_log")
      .select(
        "cycle_number, agent_trade_amount, agent_cooldown_hours, agent_max_positions, agent_interval_ms, reasoning, created_at"
      )
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[db] getImprovementHistory error:", error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    console.error("[db] getImprovementHistory unexpected error:", err);
    return [];
  }
}

export async function getTradeCount(
  agentId: string,
  battleId: string
): Promise<{ completed: number; failed: number }> {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

    const { count: completedCount, error: completedError } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .eq("status", "completed")
      .gte("created_at", fourHoursAgo);

    if (completedError) {
      console.error("[db] getTradeCount completed query error:", completedError.message);
      return { completed: 0, failed: 0 };
    }

    const { count: failedCount, error: failedError } = await db
      .from("trades")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .eq("status", "failed")
      .gte("created_at", fourHoursAgo);

    if (failedError) {
      console.error("[db] getTradeCount failed query error:", failedError.message);
      return { completed: 0, failed: 0 };
    }

    return { completed: completedCount ?? 0, failed: failedCount ?? 0 };
  } catch (err) {
    console.error("[db] getTradeCount unexpected error:", err);
    return { completed: 0, failed: 0 };
  }
}

export async function getConsecutiveHolds(agentId: string, battleId: string): Promise<number> {
  try {
    const { data, error } = await db
      .from("self_improvement_log")
      .select("consecutive_holds")
      .eq("agent_id", agentId)
      .eq("battle_id", battleId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("[db] getConsecutiveHolds error:", error.message);
      return 0;
    }
    return data?.consecutive_holds ?? 0;
  } catch (err) {
    console.error("[db] getConsecutiveHolds unexpected error:", err);
    return 0;
  }
}

export async function getRankSignal(agentId: string, battleId: string): Promise<string> {
  const tiedSignal = "You are TIED with your opponent. A tie is a loss. Break it.";
  const winningSignal = "You are currently WINNING the battle. Protect your lead.";
  const losingSignal = "You are currently LOSING the battle. Your opponent is outperforming you.";

  try {
    const { data, error } = await db
      .from("balances")
      .select("agent_id, total_usd, created_at")
      .eq("battle_id", battleId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[db] getRankSignal error:", error.message);
      return tiedSignal;
    }

    if (!data || data.length === 0) return tiedSignal;

    const latestByAgent = new Map<string, number>();
    for (const row of data) {
      if (!latestByAgent.has(row.agent_id)) {
        latestByAgent.set(row.agent_id, row.total_usd);
      }
    }

    const myBalance = latestByAgent.get(agentId);
    const opponentBalance = Array.from(latestByAgent.entries()).find(
      ([candidateAgentId]) => candidateAgentId !== agentId
    )?.[1];

    if (myBalance == null || opponentBalance == null) return tiedSignal;
    if (myBalance > opponentBalance) return winningSignal;
    if (myBalance < opponentBalance) return losingSignal;
    return tiedSignal;
  } catch (err) {
    console.error("[db] getRankSignal unexpected error:", err);
    return tiedSignal;
  }
}

export async function insertSelfImprovementLog(entry: {
  agent_id: string;
  battle_id: string;
  cycle_number: number;
  consecutive_holds: number;
  agent_trade_amount: number;
  agent_cooldown_hours: number;
  agent_max_positions: number;
  agent_interval_ms: number;
  cycle_assessment: string;
  activity_status: string;
  hold: boolean;
  confidence: string;
  reasoning: string;
  troll_box: string;
  position_decision: string;
  tokens_to_watch: string[];
  raw_response: unknown;
}): Promise<void> {
  try {
    const { error } = await db.from("self_improvement_log").insert({
      agent_id: entry.agent_id,
      battle_id: entry.battle_id,
      cycle_number: entry.cycle_number,
      consecutive_holds: entry.consecutive_holds,
      agent_trade_amount: entry.agent_trade_amount,
      agent_cooldown_hours: entry.agent_cooldown_hours,
      agent_max_positions: entry.agent_max_positions,
      agent_interval_ms: entry.agent_interval_ms,
      cycle_assessment: entry.cycle_assessment,
      activity_status: entry.activity_status,
      hold: entry.hold,
      confidence: entry.confidence,
      reasoning: entry.reasoning,
      troll_box: entry.troll_box,
      position_decision: entry.position_decision,
      tokens_to_watch: entry.tokens_to_watch,
      raw_response: entry.raw_response,
    });
    if (error) {
      console.error("[db] insertSelfImprovementLog error:", error.message);
    }
  } catch (err) {
    console.error("[db] insertSelfImprovementLog unexpected error:", err);
  }
}
