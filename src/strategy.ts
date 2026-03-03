import { submitPrompt, pollJob } from "@bankr/cli";
import { log, insertTrade, updateTrade, insertBalance } from "./db.js";

const API_TIMEOUT_MS = 30_000;
const POLL_JOB_TIMEOUT_MS = 300_000;
export const MAX_TRADE_PCT = parseInt(process.env.AGENT_MAX_TRADE_PCT || "15", 10);
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

export async function scanTrends(
  ctx: CycleContext,
  tokensToWatch?: string[]
): Promise<string> {
  await log("scanning", "Scanning trending tokens on Base...");

  let prompt =
    "What tokens are trending on Base right now? Analyze the top movers, their momentum, and any notable signals. Give me your top 3 picks with conviction levels (high/medium/low). Format each as: TOKEN_SYMBOL - direction (up/down) - conviction (high/medium/low) - brief reason.";
  if (tokensToWatch && tokensToWatch.length > 0) {
    prompt += ` Pay special attention to these tokens from your previous analysis: ${tokensToWatch.join(", ")}. Include them in your assessment if they show relevant signals.`;
  }

  const result = await promptAndPoll(
    prompt,
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

export function decideAndTrade(
  ctx: CycleContext,
  analysis: string,
  currentBalance: number,
  breakdown: Record<string, number>,
  amounts: Record<string, number>
): { amountIn: string; tokenIn: string; tokenOut: string }[] {
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
  const picksByToken = new Map(picks.map((p) => [p.token, p]));

  const trades: { amountIn: string; tokenIn: string; tokenOut: string }[] = [];

  for (const [token, usdValue] of Object.entries(breakdown)) {
    const tokenUpper = token.toUpperCase();
    if (skip.has(tokenUpper) || usdValue <= 0.5) continue;
    const pick = picksByToken.get(tokenUpper);
    const shouldSell = !pick || pick.direction === "down";
    if (shouldSell) {
      const tokenAmount = amounts[tokenUpper] ?? usdValue;
      const sellUsd = Math.max(0.50, (usdValue * MAX_TRADE_PCT) / 100);
      const sellTokenAmount = (sellUsd / usdValue) * tokenAmount;
      trades.push({
        amountIn: sellTokenAmount.toFixed(6),
        tokenIn: tokenUpper,
        tokenOut: "USDC",
      });
    }
  }

  const buyCandidates = picks.filter(
    (p) => p.direction === "up" && (p.conviction === "high" || p.conviction === "medium") && !skip.has(p.token)
  );
  if (buyCandidates.length > 0) {
    const best = buyCandidates.find((c) => c.conviction === "high") || buyCandidates[0];
    const buyAmount = Math.max(0.50, (currentBalance * MAX_TRADE_PCT) / 100).toFixed(2);
    trades.push({ amountIn: buyAmount, tokenIn: "USDC", tokenOut: best.token });
  }

  return trades;
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
    console.log(
      "[trade] Submitting swap prompt: " +
        trade.amountIn +
        " " +
        trade.tokenIn +
        " -> " +
        trade.tokenOut +
        " (slippage: " +
        AGENT_SLIPPAGE +
        "%)"
    );
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

    try {
      await checkBalance(ctx);
    } catch (balanceErr) {
      console.warn("[trade] Post-trade balance check failed: " + String(balanceErr));
    }
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
  const amounts: Record<string, number> = {};
  let totalUsd = 0;
  const lineRegex = /([\d,.]+) (\w+) \(\$([\d,.]+)\)/g;
  let balMatch;
  while ((balMatch = lineRegex.exec(result.response)) !== null) {
    const amount = parseFloat(balMatch[1].replace(/,/g, ""));
    const symbol = balMatch[2].toUpperCase();
    const usdValue = parseFloat(balMatch[3].replace(/,/g, ""));
    if (!isNaN(usdValue) && usdValue > 0) {
      totalUsd += usdValue;
      breakdown[symbol] = usdValue;
      amounts[symbol] = amount;
    }
  }

  await insertBalance(totalUsd, breakdown, ctx.agentId, ctx.battleId);
  await log("balance_update", "Balance: $" + totalUsd.toFixed(2), {
    raw_data: { total_usd: totalUsd, breakdown },
    thread_id: ctx.threadId,
  });

  return { totalUsd, breakdown, amounts };
}
