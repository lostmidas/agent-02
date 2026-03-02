import { submitPrompt, pollJob } from "@bankr/cli";
import { log, insertTrade, updateTrade, insertBalance } from "./db.js";

const API_TIMEOUT_MS = 30_000;
const POLL_JOB_TIMEOUT_MS = 120_000;
const MAX_TRADE_PCT = parseInt(process.env.AGENT_MAX_TRADE_PCT || "15", 10);
const AGENT_SLIPPAGE = process.env.AGENT_SLIPPAGE || "3";
const AGENT_COOLDOWN_HOURS = parseInt(process.env.AGENT_COOLDOWN_HOURS || "4", 10);
const AGENT_MAX_POSITIONS = parseInt(process.env.AGENT_MAX_POSITIONS || "3", 10);
const AGENT_MAX_DAILY_LOSS_PCT = parseFloat(process.env.AGENT_MAX_DAILY_LOSS_PCT || "20");
const tradeCooldownMap = new Map<string, number>();
const openPositions = new Set<string>();
let startOfDayBalance: number | null = null;
let currentBalance = 0;
let balanceDay: string | null = null;
let dailyLimitHit = false;

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

export function isTokenInCooldown(token: string): boolean {
  const lastTradeAt = tradeCooldownMap.get(token.toUpperCase());
  if (!lastTradeAt) return false;
  const cooldownMs = AGENT_COOLDOWN_HOURS * 60 * 60 * 1000;
  return Date.now() - lastTradeAt < cooldownMs;
}

export function updateTokenCooldown(token: string): void {
  tradeCooldownMap.set(token.toUpperCase(), Date.now());
}

export function hasReachedMaxPositions(): boolean {
  return openPositions.size >= AGENT_MAX_POSITIONS;
}

export function addOpenPosition(token: string): void {
  openPositions.add(token.toUpperCase());
}

export function removeOpenPosition(token: string): void {
  openPositions.delete(token.toUpperCase());
}

export function isDailyLimitHit(): boolean {
  return dailyLimitHit;
}

function getDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function updateDailyLossTracking(totalUsd: number): void {
  const dayKey = getDayKey();
  currentBalance = totalUsd;

  if (balanceDay !== dayKey || startOfDayBalance === null) {
    balanceDay = dayKey;
    startOfDayBalance = totalUsd;
    dailyLimitHit = false;
    return;
  }

  if (startOfDayBalance <= 0) return;
  const lossPct = ((startOfDayBalance - currentBalance) / startOfDayBalance) * 100;
  if (lossPct >= AGENT_MAX_DAILY_LOSS_PCT) {
    dailyLimitHit = true;
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

export function calculateRSI(prices: number[], period = 14): number {
  if (prices.length < period + 1) throw new Error("Not enough prices to calculate RSI");
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export async function scanTrends(ctx: CycleContext): Promise<string[]> {
  await log("scanning", "Scanning trending tokens on Base...");
  const result = await promptAndPoll(
    "What tokens are trending on Base right now? Give me your top 3 picks. Format each as: TOKEN_SYMBOL - direction (up/down) - conviction (high/medium/low) - brief reason.",
    ctx.threadId,
    "Scanning trending tokens on Base..."
  );
  ctx.threadId = result.threadId;
  const tokens: string[] = [];
  const skip = new Set(["USDC", "USDT", "DAI", "USD", "WETH"]);
  const regex = /\b([A-Z][A-Z0-9]{1,9})\b\s*[-]\s*(up|down)/gi;
  let match;
  while ((match = regex.exec(result.response)) !== null) {
    const token = match[1].toUpperCase();
    if (!skip.has(token)) tokens.push(token);
  }
  await log("analysis", "Trending tokens found: " + tokens.join(", "), {
    raw_data: { tokens },
    thread_id: ctx.threadId,
  });
  return tokens;
}

export async function getRSIForToken(
  ctx: CycleContext,
  token: string
): Promise<{ rsi: number; signal: "BUY" | "SELL" | "HOLD" }> {
  const result = await promptAndPoll(
    "Give me the last 15 hourly closing prices for " + token + " in USD. Respond with ONLY a JSON array of numbers, oldest first. Example: [2100.50, 2105.20, 2098.75] No explanation, just the array.",
    ctx.threadId,
    "Fetching " + token + " prices..."
  );
  ctx.threadId = result.threadId;
  let prices: number[] = [];
  const arrayMatch = result.response.match(/\[[\d\s.,]+\]/);
  if (arrayMatch) {
    try {
      prices = JSON.parse(arrayMatch[0]) as number[];
    } catch {
      prices = [];
    }
  }

  if (prices.length === 0) {
    const lineValues = result.response
      .split(/\r?\n/)
      .map((line) => {
        const numberMatch = line.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
        if (!numberMatch) return NaN;
        return parseFloat(numberMatch[0].replace(/,/g, ""));
      })
      .filter((value) => Number.isFinite(value));
    prices = lineValues;
  }

  if (prices.length < 15) {
    await log("error", "Could not parse prices for " + token, {
      thread_id: ctx.threadId,
      raw_data: { response: result.response },
    });
    return { rsi: 50, signal: "HOLD" };
  }

  const rsi = calculateRSI(prices);
  let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (rsi < 30) signal = "BUY";
  else if (rsi > 70) signal = "SELL";
  await log("analysis", token + " RSI: " + rsi.toFixed(2) + " => " + signal, {
    raw_data: { token, rsi, signal, prices },
    thread_id: ctx.threadId,
  });
  console.log("[agent] " + token + " RSI: " + rsi.toFixed(2) + " | Signal: " + signal);
  return { rsi, signal };
}

export async function getUSDCBalance(ctx: CycleContext): Promise<number> {
  const result = await promptAndPoll(
    "What is my current USDC balance? Respond with only the numeric amount.",
    ctx.threadId,
    "Fetching USDC balance..."
  );
  ctx.threadId = result.threadId;
  const match = result.response.match(/[\d,.]+/);
  if (!match) return 0;
  const balance = parseFloat(match[0].replace(/,/g, ""));
  return Number.isFinite(balance) ? balance : 0;
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
  });
  try {
    const usdcBalance = await getUSDCBalance(ctx);
    const amountIn = parseFloat(trade.amountIn);
    if (usdcBalance < amountIn) {
      console.error("Insufficient USDC balance");
      if (tradeRow) {
        await updateTrade(tradeRow.id, {
          status: "failed",
          raw_response: { error: "Insufficient USDC balance", usdc_balance: usdcBalance, amount_in: trade.amountIn },
        });
      }
      return;
    }
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
    console.log("[trade] Swap prompt completed. Job ID: " + result.jobId);
    ctx.threadId = result.threadId;
    const txMatch = result.response.match(/0x[a-fA-F0-9]{64}/);
    const txHash = txMatch ? txMatch[0] : null;
    if (tradeRow) {
      await updateTrade(tradeRow.id, {
        status: "completed",
        tx_hash: txHash ?? undefined,
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
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[agent] ERROR: " + message);
    if (stack) console.error(stack);
    if (tradeRow) await updateTrade(tradeRow.id, { status: "failed", raw_response: { error: String(err) } });
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
  const lineRegex = /^([\d,.]+)\s+([A-Za-z0-9$._-]+)\s+\(\$([\d,.]+)\)/gm;
  let balMatch;
  while ((balMatch = lineRegex.exec(result.response)) !== null) {
    const name = balMatch[2].trim();
    const usdValue = parseFloat(balMatch[3].replace(/,/g, ""));
    if (!isNaN(usdValue) && usdValue > 0) {
      breakdown[name] = usdValue;
      totalUsd += usdValue;
    }
  }
  updateDailyLossTracking(totalUsd);
  await insertBalance(totalUsd, breakdown, ctx.agentId, ctx.battleId);
  await log("balance_update", "Balance: $" + totalUsd.toFixed(2), {
    raw_data: { total_usd: totalUsd, breakdown },
    thread_id: ctx.threadId,
  });
  return { totalUsd, breakdown };
}
