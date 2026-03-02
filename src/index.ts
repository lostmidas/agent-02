import "./env.js";
import { validateApiKey, getUserInfo } from "@bankr/cli";
import { log } from "./db.js";
import {
  scanTrends,
  getRSIForToken,
  executeTrade,
  checkBalance,
  isTokenInCooldown,
  updateTokenCooldown,
  hasReachedMaxPositions,
  addOpenPosition,
  removeOpenPosition,
  isDailyLimitHit,
} from "./strategy.js";

const INTERVAL_MS = parseInt(process.env.AGENT_INTERVAL_MS || "180000", 10);
const AGENT_DRY_RUN = /^(1|true|yes)$/i.test(process.env.AGENT_DRY_RUN || "false");
const AGENT_TRADE_AMOUNT = process.env.AGENT_TRADE_AMOUNT || "10";
const API_TIMEOUT_MS = 30_000;
const AGENT_ID = process.env.AGENT_ID;
const BATTLE_ID = process.env.BATTLE_ID;

let running = true;

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
    console.log("[agent] Starting RSI Trading Agent...");
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
    if (isDailyLimitHit()) {
      await log("trade", "Daily loss limit hit, pausing trading", {
        agent_id: AGENT_ID,
        battle_id: BATTLE_ID,
      });
      return;
    }
    await log("scanning", "Starting new RSI scan cycle...", {
      agent_id: AGENT_ID,
      battle_id: BATTLE_ID,
    });
    const tokens = await scanTrends(ctx);
    if (tokens.length === 0) {
      await log("analysis", "No trending tokens found, skipping cycle.", {
        agent_id: AGENT_ID,
        battle_id: BATTLE_ID,
      });
      return;
    }
    for (const token of tokens) {
      const { signal, rsi } = await getRSIForToken(ctx, token);
      if (signal === "BUY") {
        if (isTokenInCooldown(token)) {
          await log("trade", `${token} in cooldown, skipping`, {
            agent_id: AGENT_ID,
            battle_id: BATTLE_ID,
          });
          continue;
        }
        if (AGENT_DRY_RUN) {
          await log(
            "trade",
            `[DRY RUN] BUY signal for ${token} at RSI ${rsi.toFixed(2)} — skipping trade.`,
            { agent_id: AGENT_ID, battle_id: BATTLE_ID }
          );
        } else {
          if (hasReachedMaxPositions()) {
            await log("trade", `Max positions reached, skipping BUY for ${token}`, {
              agent_id: AGENT_ID,
              battle_id: BATTLE_ID,
            });
            continue;
          }
          const result = await executeTrade(ctx, { amountIn: AGENT_TRADE_AMOUNT, tokenIn: "USDC", tokenOut: token });
          if (result) {
            updateTokenCooldown(token);
            addOpenPosition(token);
          }
        }
      } else if (signal === "SELL") {
        if (isTokenInCooldown(token)) {
          await log("trade", `${token} in cooldown, skipping`, {
            agent_id: AGENT_ID,
            battle_id: BATTLE_ID,
          });
          continue;
        }
        if (AGENT_DRY_RUN) {
          await log(
            "trade",
            `[DRY RUN] SELL signal for ${token} at RSI ${rsi.toFixed(2)} — skipping trade.`,
            { agent_id: AGENT_ID, battle_id: BATTLE_ID }
          );
        } else {
          const result = await executeTrade(ctx, { amountIn: AGENT_TRADE_AMOUNT, tokenIn: token, tokenOut: "USDC" });
          if (result) {
            updateTokenCooldown(token);
            removeOpenPosition(token);
          }
        }
      } else {
        await log("analysis", `${token} RSI ${rsi.toFixed(2)} — holding, no trade.`, {
          agent_id: AGENT_ID,
          battle_id: BATTLE_ID,
        });
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
