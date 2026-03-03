import { submitPrompt, pollJob } from "@bankr/cli";
import { log, insertTrade, updateTrade, insertBalance } from "./db.js";

const API_TIMEOUT_MS = 30_000;
const POLL_JOB_TIMEOUT_MS = 300_000;
const MAX_TRADE_PCT = parseInt(process.env.AGENT_MAX_TRADE_PCT || "15", 10);
const AGENT_SLIPPAGE = process.env.AGENT_SLIPPAGE || "3";

interface CycleContext {
  threadId?: string;
  agentId?: string;
  battleId?: string;
}

class ApiTimeoutError extends Error {
  endpoint: string;
  constructor(endpoint: string, timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms: ${endpoint}`);
    this.name = "ApiTimeoutError";
    this.endpoint = endpoint;
  }
}

async function callBankrApi<T>(endpoint: string, fn: () => Promise<T>, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new ApiTimeoutError(endpoint, timeoutMs)), timeoutMs);
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    console.log(`[agent] Calling complete: ${endpoint}`);
    return result as T;
  } catch (error) {
    if (error instanceof ApiTimeoutError) {
      console.error(`[agent] TIMEOUT: ${error.endpoint}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[agent] ERROR: ${message}`);
    if (stack) console.error(stack);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function promptAndPoll(
  prompt: string,
  threadId?: string,
  label?: string
): Promise<{ response: string; jobId: string; threadId?: string }> {
  await log("prompt", label || prompt.slice(0, 80) + "...", { raw_data: { prompt } });
  const submitted = await callBankrApi("bankr.submitPrompt", () => submitPrompt(prompt, threadId));
  if (!submitted.success) throw new Error("submitPrompt failed: " + submitted.message);
  const result = await callBankrApi("bankr.pollJob", () =>
    pollJob(submitted.jobId, {
      interval: 3000,
      maxAttempts: 100,
      onStatus: (s: { status: string }) => {
        if (s.status === "processing")
          log("system", "Job " + submitted.jobId + " processing...", {
            job_id: submitted.jobId,
            thread_id: submitted.threadId,
          });
      },
    }),
    POLL_JOB_TIMEOUT_MS
  );
  if (result.status === "failed") throw new Error("Job failed: " + (result.error || "unknown"));
  const response = result.response || "";
  await log("response", response.slice(0, 500), {
    raw_data: result,
    job_id: submitted.jobId,
    thread_id: submitted.threadId,
  });
  return { response, jobId: submitted.jobId, threadId: submitted.threadId };
}

export async function scanTrends(ctx: CycleContext): Promise<string> {
  await log("scanning", "Scanning trending tokens on Base...");

  const result = await promptAndPoll(
    "What tokens are trending on Base right now? Analyze the top movers, their momentum, and any notable signals. Give me your top 3 picks with conviction levels (high/medium/low). Format each as: TOKEN_SYMBOL - direction (up/down) - conviction (high/medium/low) - brief reason.",
    ctx.threadId,
    "Scanning trending tokens on Base..."
  );

  ctx.threadId = result.threadId;

  await log("analysis", "Trend analysis complete", {
    raw_data: { response: result.response },
    thread_id: ctx.threadId,
  });

  return result.response;
}

export async function decideAndTrade(
  ctx: CycleContext,
  analysis: string,
  currentBalance: number
): Promise<{ amountIn: string; tokenIn: string; tokenOut: string } | null> {
  const picks: { token: string; direction: string; conviction: string }[] = [];
  const pickRegex = /\b([A-Z][A-Z0-9]{1,9})\b\s*[-–—]\s*(up|down)\s*[-–—]\s*(high|medium|low)/gi;
  let match;
  while ((match = pickRegex.exec(analysis)) !== null) {
    picks.push({
      token: match[1].toUpperCase(),
      direction: match[2].toLowerCase(),
      conviction: match[3].toLowerCase(),
    });
  }

  const skip = new Set(["USDC", "USDT", "DAI", "USD", "ETH", "WETH"]);
  const candidates = picks.filter(
    (p) => p.direction === "up" && (p.conviction === "high" || p.conviction === "medium") && !skip.has(p.token)
  );

  if (candidates.length === 0) {
    await log("analysis", "No high/medium conviction 'up' picks found, skipping trade", {
      raw_data: { picks },
      thread_id: ctx.threadId,
    });
    return null;
  }

  const best = candidates.find((c) => c.conviction === "high") || candidates[0];
  const amountIn = Math.max(0.5, (currentBalance * MAX_TRADE_PCT) / 100).toFixed(2);

  await log("analysis", `Picked ${best.token} (${best.conviction} conviction, trending ${best.direction}). Trading ${amountIn} USDC.`, {
    raw_data: { best, candidates, amountIn },
    thread_id: ctx.threadId,
  });

  return { amountIn, tokenIn: "USDC", tokenOut: best.token };
}

export async function executeTrade(
  ctx: CycleContext,
  trade: { amountIn: string; tokenIn: string; tokenOut: string }
) {
  await log("trade", "Executing swap: " + trade.amountIn + " " + trade.tokenIn + " to " + trade.tokenOut, {
    thread_id: ctx.threadId,
  });

  const tradeRow = await insertTrade({
    token_in: trade.tokenIn,
    token_out: trade.tokenOut,
    amount_in: trade.amountIn,
    status: "pending",
    agent_id: ctx.agentId,
    battle_id: ctx.battleId,
  });

  try {
    const result = await promptAndPoll(
      "swap " +
        trade.amountIn +
        " " +
        trade.tokenIn +
        " to " +
        trade.tokenOut +
        " on base with " +
        AGENT_SLIPPAGE +
        "% slippage",
      ctx.threadId,
      "Swapping " + trade.amountIn + " " + trade.tokenIn + " to " + trade.tokenOut
    );

    ctx.threadId = result.threadId;

    const txMatch = result.response.match(/0x[a-fA-F0-9]{64}/);
    const txHash = txMatch ? txMatch[0] : null;
    const amountOutMatch = result.response.match(
      /(\d+(?:\.\d+)?)\s*(?:tokens?|units?)?\s*(?:of\s+)?(?:\w+)/i
    );

    if (tradeRow) {
      await updateTrade(tradeRow.id, {
        status: "completed",
        tx_hash: txHash ?? undefined,
        amount_out: amountOutMatch ? amountOutMatch[1] : undefined,
        raw_response: result,
      });
    }

    await log("trade", "Swap complete: " + trade.amountIn + " " + trade.tokenIn + " to " + trade.tokenOut + (txHash ? " (tx: " + txHash.slice(0, 10) + "...)" : ""), {
      raw_data: result,
      job_id: result.jobId,
      thread_id: ctx.threadId,
    });

    return result;
  } catch (err) {
    if (tradeRow) {
      await updateTrade(tradeRow.id, {
        status: "failed",
        raw_response: { error: String(err) },
      });
    }
    throw err;
  }
}

export async function checkBalance(ctx: CycleContext) {
  const result = await promptAndPoll(
    "What is my current wallet balance? Show all tokens and their USD values.",
    ctx.threadId,
    "Checking wallet balance..."
  );

  ctx.threadId = result.threadId;

  const breakdown: Record<string, number> = {};
  let totalUsd = 0;
  const lineRegex = /^(.+?)\s*[-–—]\s*[\d,.]+\s+\w+\s+\$([\d,.]+)/gm;
  let balMatch;
  while ((balMatch = lineRegex.exec(result.response)) !== null) {
    const name = balMatch[1].trim();
    const usdValue = parseFloat(balMatch[2].replace(/,/g, ""));
    if (!isNaN(usdValue) && usdValue > 0) {
      breakdown[name] = usdValue;
      totalUsd += usdValue;
    }
  }
  if (totalUsd === 0) {
    const fallbackRegex = /^(.+?)\s*[-–—]\s*[\d,.]+\s+\$([\d,.]+)/gm;
    let fbMatch;
    while ((fbMatch = fallbackRegex.exec(result.response)) !== null) {
      const name = fbMatch[1].trim();
      const usdValue = parseFloat(fbMatch[2].replace(/,/g, ""));
      if (!isNaN(usdValue) && usdValue > 0) {
        breakdown[name] = usdValue;
        totalUsd += usdValue;
      }
    }
  }
  if (totalUsd === 0) {
    const altRegex = /^([\d,.]+)\s+([A-Za-z0-9$._-]+)\s+\(\$([\d,.]+)\)/gm;
    while ((balMatch = altRegex.exec(result.response)) !== null) {
      const name = balMatch[2].trim();
      const usdValue = parseFloat(balMatch[3].replace(/,/g, ""));
      if (!isNaN(usdValue) && usdValue > 0) {
        breakdown[name] = usdValue;
        totalUsd += usdValue;
      }
    }
  }

  await insertBalance(totalUsd, breakdown, ctx.agentId, ctx.battleId);
  await log("balance_update", "Balance: $" + totalUsd.toFixed(2), {
    raw_data: { total_usd: totalUsd, breakdown },
    thread_id: ctx.threadId,
  });

  return { totalUsd, breakdown };
}
