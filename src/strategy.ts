import { submitPrompt, pollJob } from "@bankr/cli";
import { log, insertTrade, updateTrade, insertBalance, getEntryPrice } from "./db.js";
import { MAX_REACTION_PROMPT } from "./prompts.js";

const API_TIMEOUT_MS = 30_000;
const POLL_JOB_TIMEOUT_MS = 300_000;
export const MAX_TRADE_PCT = parseInt(process.env.AGENT_MAX_TRADE_PCT || "15", 10);
const AGENT_SLIPPAGE = process.env.AGENT_SLIPPAGE || "3";
const TAKE_PROFIT_PCT = parseFloat(process.env.AGENT_TAKE_PROFIT_PCT || "5");
const STOP_LOSS_PCT = parseFloat(process.env.AGENT_STOP_LOSS_PCT || "3");

const TOKEN_ADDRESSES: Record<string, string> = {
  MOLT: "0xb695559b26bb2c9703ef1935c37aeae9526bab07",
  NOOK: "0xb233bdffd437e60fa451f62c6c09d3804d285ba3",
  JUNO: "0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07",
  FELIX: "0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07",
  CLAWD: "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07",
  BNKR: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
};

let cachedPrices: Record<string, number> = {};
let pricesCachedAt = 0;
const PRICE_CACHE_TTL_MS = 60_000;

async function fetchAllTokenPrices(): Promise<Record<string, number>> {
  const now = Date.now();
  if (now - pricesCachedAt < PRICE_CACHE_TTL_MS && Object.keys(cachedPrices).length > 0) {
    return cachedPrices;
  }
  try {
    const addresses = Object.values(TOKEN_ADDRESSES).join(",");
    const url = `https://api.geckoterminal.com/api/v2/networks/base/tokens/multi/${addresses}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[price] GeckoTerminal fetch failed: ${res.status}`);
      return cachedPrices;
    }
    const json = await res.json();
    const prices: Record<string, number> = {};
    for (const item of json?.data ?? []) {
      const addr = item?.attributes?.address?.toLowerCase();
      const price = parseFloat(item?.attributes?.price_usd);
      if (addr && !isNaN(price) && price > 0) {
        const symbol = Object.entries(TOKEN_ADDRESSES).find(([, v]) => v.toLowerCase() === addr)?.[0];
        if (symbol) prices[symbol] = price;
      }
    }
    cachedPrices = prices;
    pricesCachedAt = now;
    console.log(`[price] fetched prices for: ${Object.keys(prices).join(", ")}`);
    return prices;
  } catch (err) {
    console.warn("[price] fetchAllTokenPrices failed:", err);
    return cachedPrices;
  }
}

async function getTokenPrice(token: string): Promise<number | null> {
  const prices = await fetchAllTokenPrices();
  return prices[token.toUpperCase()] ?? null;
}

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
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(
      "[BANKR_DIAGNOSTIC]",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        agent_id: process.env.AGENT_ID,
        event: "api_error",
        endpoint,
        error_type: error instanceof ApiTimeoutError ? "timeout" : "error",
        error_message: message,
        timeout_ms: timeoutMs,
        stack,
      })
    );
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
    "You are scanning a fixed universe of high-volatility Bankr ecosystem tokens on Base. The only tokens you may analyze and trade are: MOLT, NOOK, JUNO, FELIX, CLAWD, BNKR. Do not suggest or trade any tokens outside this list. Which of these tokens are showing strength or upward momentum right now? Look for tokens that are overbought, rising, or showing bullish signals — these are momentum buying opportunities. Give me your top 3 picks from this list only, with conviction levels. Format each as: TOKEN_SYMBOL - direction (up/down) - conviction (high/medium/low) - brief reason.";
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

export async function decideAndTrade(
  ctx: CycleContext,
  analysis: string,
  currentBalance: number,
  breakdown: Record<string, number>,
  amounts: Record<string, number>
): Promise<{ amountIn: string; tokenIn: string; tokenOut: string; entryPriceUsd?: number }[]> {
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

  const trades: { amountIn: string; tokenIn: string; tokenOut: string; entryPriceUsd?: number }[] = [];

  for (const [token, usdValue] of Object.entries(breakdown)) {
    const tokenUpper = token.toUpperCase();
    if (skip.has(tokenUpper) || usdValue <= 0.5) continue;
    const pick = picksByToken.get(tokenUpper);
    const entryPrice = await getEntryPrice(ctx.agentId!, ctx.battleId!, tokenUpper);
    const currentPrice = await getTokenPrice(tokenUpper);
    let shouldSell = false;
    if (entryPrice && currentPrice) {
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      if (pnlPct >= TAKE_PROFIT_PCT) {
        console.log(`[exit] ${tokenUpper} take profit triggered: +${pnlPct.toFixed(2)}%`);
        shouldSell = true;
      } else if (pnlPct <= -STOP_LOSS_PCT) {
        console.log(`[exit] ${tokenUpper} stop loss triggered: ${pnlPct.toFixed(2)}%`);
        shouldSell = true;
      } else {
        console.log(`[exit] ${tokenUpper} holding: ${pnlPct.toFixed(2)}% (tp: +${TAKE_PROFIT_PCT}% sl: -${STOP_LOSS_PCT}%)`);
      }
    } else {
      console.warn(`[exit] ${tokenUpper} no price data, defaulting to scan-based exit`);
      shouldSell = !pick || pick.direction === "down";
    }
    if (shouldSell) {
      trades.push({
        amountIn: `$${usdValue.toFixed(2)}`,
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
    const buyEntryPrice = await getTokenPrice(best.token);
    trades.push({ amountIn: buyAmount, tokenIn: "USDC", tokenOut: best.token, entryPriceUsd: buyEntryPrice ?? undefined });
  }

  return trades;
}

export async function executeTrade(
  ctx: CycleContext,
  trade: { amountIn: string; tokenIn: string; tokenOut: string; entryPriceUsd?: number }
) {
  await log("trade", "Executing swap: " + trade.amountIn + " " + trade.tokenIn + " to " + trade.tokenOut, {
    thread_id: ctx.threadId,
  });

  const tradeRow = await insertTrade({
    token_in: trade.tokenIn,
    token_out: trade.tokenOut,
    amount_in: trade.amountIn,
    entry_price_usd: trade.entryPriceUsd,
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
        " of " +
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
  const NAME_TO_SYMBOL: Record<string, string> = {
    "usd coin": "USDC", "usdc": "USDC",
    "ethereum": "ETH", "eth": "ETH",
    "moltbook": "MOLT", "molt": "MOLT",
    "nook": "NOOK",
    "juno": "JUNO",
    "felix": "FELIX",
    "clawd": "CLAWD",
    "bnkr": "BNKR", "bankr": "BNKR",
    "venice token": "VVV", "vvv": "VVV",
  };
  const skip = new Set(["ETH", "SOL", "SOLANA"]);
  const lines = result.response.split('\n');
  for (const line of lines) {
    const cleaned = line.replace(/^[•*\-\s]+/, '').trim();
    if (!cleaned) continue;
    if (cleaned.toLowerCase().includes('total') || cleaned.toLowerCase().includes('portfolio')) continue;
    const dollarParen = cleaned.match(/\(\$?([\d,]+(?:\.\d+)?)\)$/);
    const dollarEnd = cleaned.match(/\$(\d+(?:\.\d+)?)$/);
    const usdMatch = dollarParen ?? dollarEnd;
    if (!usdMatch) continue;
    const usdValue = parseFloat(usdMatch[1].replace(/,/g, ''));
    if (isNaN(usdValue) || usdValue <= 0.01 || usdValue >= 10000) continue;
    const firstPart = cleaned.split('-')[0].trim().toLowerCase();
    const tickerInLine = cleaned.match(/\b([A-Z][A-Z0-9]{1,9})\b/);
    const nameSymbol = NAME_TO_SYMBOL[firstPart];
    const tickerSymbol = tickerInLine ? NAME_TO_SYMBOL[tickerInLine[1].toLowerCase()] ?? (tickerInLine[1].length <= 6 ? tickerInLine[1] : null) : null;
    const symbol = nameSymbol ?? tickerSymbol ?? null;
    if (symbol && !skip.has(symbol)) {
      breakdown[symbol] = usdValue;
      totalUsd += usdValue;
    }
  }

  if (totalUsd === 0) {
    console.warn("[balance] parsed zero balance, skipping insert");
    return { totalUsd, breakdown, amounts };
  }

  await insertBalance(totalUsd, breakdown, ctx.agentId, ctx.battleId);
  await log("balance_update", "Balance: $" + totalUsd.toFixed(2), {
    raw_data: { total_usd: totalUsd, breakdown },
    thread_id: ctx.threadId,
  });

  return { totalUsd, breakdown, amounts };
}

export async function fireReaction(
  ctx: CycleContext,
  trade: { amountIn: string; tokenIn: string; tokenOut: string }
): Promise<void> {
  const prompt = MAX_REACTION_PROMPT(trade);
  try {
    const result = await promptAndPoll(prompt, undefined, "Firing post-trade reaction...");
    await log("taunt", result.response.trim(), {
      agent_id: ctx.agentId,
      battle_id: ctx.battleId,
      thread_id: ctx.threadId,
    });
  } catch (err) {
    console.warn("[reaction] Failed to fire reaction: " + String(err));
  }
}
