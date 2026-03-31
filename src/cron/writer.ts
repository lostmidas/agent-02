import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParsedResponse } from "./parser.ts";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
const TEMP_ENV_PATH = path.resolve(process.cwd(), ".env.local.tmp");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replaceParameterLine(
  source: string,
  key: keyof ParsedResponse["parameters"],
  value: number,
): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return source.replace(pattern, `${key}=${value}`);
}

export async function writeBackAndRestart(
  params: ParsedResponse["parameters"],
): Promise<void> {
  const agentId = process.env.AGENT_ID ?? "unknown";
  const currentEnv = await readFile(ENV_PATH, "utf-8");

  let updatedEnv = currentEnv;
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_TRADE_AMOUNT", params.AGENT_TRADE_AMOUNT);
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_COOLDOWN_HOURS", params.AGENT_COOLDOWN_HOURS);
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_MAX_POSITIONS", params.AGENT_MAX_POSITIONS);
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_INTERVAL_MS", params.AGENT_INTERVAL_MS);
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_TAKE_PROFIT_PCT", params.AGENT_TAKE_PROFIT_PCT);
  updatedEnv = replaceParameterLine(updatedEnv, "AGENT_STOP_LOSS_PCT", params.AGENT_STOP_LOSS_PCT);

  try {
    await writeFile(TEMP_ENV_PATH, updatedEnv, "utf-8");
  } catch (error) {
    const message = toErrorMessage(error);
    console.error(`CRON ERROR: Failed to write parameters for ${agentId} — ${message}`);
    throw error;
  }

  try {
    await rename(TEMP_ENV_PATH, ENV_PATH);
  } catch (error) {
    const message = toErrorMessage(error);
    console.error(`CRON ERROR: Failed to rename temp file for ${agentId} — ${message}`);
    throw error;
  }

  console.log("[writer] Parameters written. Restarting agent...");
  process.exit(0);
}
