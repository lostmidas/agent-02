import "./env.js";
import { validateApiKey, getUserInfo } from "@bankr/cli";
import { log, getLatestTokensToWatch } from "./db.js";
import {
  scanTrends,
  decideAndTrade,
  executeTrade,
  checkBalance,
  fireReaction,
  MAX_TRADE_PCT,
} from "./strategy.js";
import { startSelfImprovementCron } from "./cron/index.js";

const INTERVAL_MS = parseInt(process.env.AGENT_INTERVAL_MS || "180000", 10);
const AGENT_DRY_RUN = /^(1|true|yes)$/i.test(process.env.AGENT_DRY_RUN || "false");
const API_TIMEOUT_MS = 30_000;
const AGENT_ID = process.env.AGENT_ID;
const BATTLE_ID = process.env.BATTLE_ID;

let running = true;
let completedTradeCount = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ApiTimeoutError extends Error {
  endpoint: string;
  constructor(endpoint: string) {
    super(`Timeout after ${API_TIMEOUT_MS}ms: ${endpoint}`);
    this.name = "ApiTimeoutError";
    this.endpoint = endpoint;
  }
}

async function callBankrApi<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new ApiTimeoutError(endpoint)), API_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([fn(), timeoutPromise]);
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

async function init() {
  try {
    console.log("[agent] Starting Momentum Trading Agent...");
    console.log("[agent] Init step: validate API key");
    const valid = await callBankrApi("bankr.validateApiKey", () => validateApiKey());
    if (!valid) {
      console.error("[agent] Invalid Bankr API key. Set BANKR_API_KEY env var.");
      process.exit(1);
    }
    await log("system", "Agent starting up — validating API key...", {
      agent_id: AGENT_ID,
      battle_id: BATTLE_ID,
    });
    console.log("[agent] Init step: fetch user info");
    const userInfo = await callBankrApi("bankr.getUserInfo", () => getUserInfo());
    const wallet = userInfo.wallets?.find((w: { chain: string }) => w.chain === "base") ?? userInfo.wallets?.[0];
    await log(
      "system",
      `Connected: ${wallet?.address?.slice(0, 6)}...${wallet?.address?.slice(-4)} on ${wallet?.chain ?? "unknown"}`,
      { raw_data: userInfo, agent_id: AGENT_ID, battle_id: BATTLE_ID }
    );
    console.log(`[agent] Wallet: ${wallet?.address}`);
    console.log(`[agent] Cycle interval: ${INTERVAL_MS}ms`);
    console.log("[agent] Init complete");
    return userInfo;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[agent] ERROR: " + message);
    if (stack) console.error(stack);
    throw err;
  }
}

async function cycle() {
  const ctx: { threadId?: string; agentId?: string; battleId?: string } = {
    agentId: AGENT_ID,
    battleId: BATTLE_ID,
  };
  try {
    await log("scanning", "Starting new momentum scan cycle...", {
      agent_id: AGENT_ID,
      battle_id: BATTLE_ID,
    });
    const tokensToWatch =
      AGENT_ID && BATTLE_ID ? await getLatestTokensToWatch(AGENT_ID, BATTLE_ID) : [];
    const analysis = await scanTrends(ctx, tokensToWatch);
    const { totalUsd, breakdown, amounts } = await checkBalance(ctx);
    const trades = decideAndTrade(ctx, analysis, totalUsd, breakdown, amounts);
    const sells = trades.filter((t) => t.tokenIn !== "USDC");
    const buy = trades.find((t) => t.tokenIn === "USDC");

    if (AGENT_DRY_RUN) {
      for (const t of trades) {
        await log(
          "trade",
          `[DRY RUN] Would trade ${t.amountIn} ${t.tokenIn} → ${t.tokenOut} — skipping.`,
          { agent_id: AGENT_ID, battle_id: BATTLE_ID }
        );
      }
    } else {
      for (const t of sells) {
        await executeTrade(ctx, t);
        completedTradeCount++;
        if (completedTradeCount % 3 === 0) void fireReaction(ctx, t);
      }
      if (buy) {
        const { totalUsd: newTotalUsd, breakdown: newBreakdown } = await checkBalance(ctx);
        const buyAmount = Math.max(0.50, (newTotalUsd * MAX_TRADE_PCT) / 100).toFixed(2);
        const usdcBalance = newBreakdown["USDC"] ?? 0;
        if (usdcBalance >= parseFloat(buyAmount)) {
          const buyTrade = { amountIn: buyAmount, tokenIn: "USDC", tokenOut: buy.tokenOut };
          await executeTrade(ctx, buyTrade);
          completedTradeCount++;
          if (completedTradeCount % 3 === 0) void fireReaction(ctx, buyTrade);
        }
      }
    }
    await checkBalance(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[agent] ERROR: " + message);
    if (stack) console.error(stack);
    await log("error", `Cycle error: ${message}`, {
      raw_data: { error: message },
      thread_id: ctx.threadId,
      agent_id: AGENT_ID,
      battle_id: BATTLE_ID,
    });
  }
}

async function main() {
  await init();
  startSelfImprovementCron();
  while (running) {
    await cycle();
    console.log(`[agent] Sleeping ${INTERVAL_MS / 1000}s until next cycle...`);
    await sleep(INTERVAL_MS);
  }
}

process.on("SIGINT", () => {
  running = false;
  log("system", "Agent shutting down (SIGINT)", {
    agent_id: AGENT_ID,
    battle_id: BATTLE_ID,
  }).then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  running = false;
  log("system", "Agent shutting down (SIGTERM)", {
    agent_id: AGENT_ID,
    battle_id: BATTLE_ID,
  }).then(() => process.exit(0));
});

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error("[agent] ERROR: " + message);
  if (stack) console.error(stack);
  process.exit(1);
});
