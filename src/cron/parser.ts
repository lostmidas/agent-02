export type ParsedResponse = {
  parameters: {
    AGENT_TRADE_AMOUNT: number;
    AGENT_COOLDOWN_HOURS: number;
    AGENT_MAX_POSITIONS: number;
    AGENT_INTERVAL_MS: number;
  };
  cycle_assessment: string;
  activity_status: string;
  position_decision: string;
  reasoning: string;
  tokens_to_watch: string[];
  troll_box: string;
  confidence: string;
  hold: boolean;
};

const PARAMETER_BOUNDS = {
  AGENT_TRADE_AMOUNT: { min: 1, max: 10 },
  AGENT_COOLDOWN_HOURS: { min: 0.5, max: 2 },
  AGENT_MAX_POSITIONS: { min: 2, max: 4 },
  AGENT_INTERVAL_MS: { min: 120000, max: 600000 },
} as const;

const REQUIRED_TOP_LEVEL_FIELDS = [
  "parameters",
  "cycle_assessment",
  "activity_status",
  "position_decision",
  "reasoning",
  "tokens_to_watch",
  "troll_box",
  "confidence",
  "hold",
] as const;

type ParameterName = keyof ParsedResponse["parameters"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasField(obj: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, field) && obj[field] !== undefined;
}

function clampParameter(name: ParameterName, value: number, agentId: string): number {
  const bounds = PARAMETER_BOUNDS[name];
  const clamped = Math.min(bounds.max, Math.max(bounds.min, value));

  if (clamped !== value) {
    console.warn(`CRON WARNING: Parameter ${name} clamped to ${clamped} for ${agentId}`);
  }

  return clamped;
}

function stripMarkdownCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function parseResponse(raw: string): ParsedResponse {
  const agentId = process.env.AGENT_ID ?? "unknown";
  const cleaned = stripMarkdownCodeFences(raw);

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CRON ERROR: Malformed JSON response for ${agentId} — ${message}`);
    throw error;
  }

  if (!isRecord(parsed)) {
    console.error(`CRON ERROR: Missing fields in response for ${agentId}`);
    throw new Error("Missing required fields in response");
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const missingTopLevelFields = REQUIRED_TOP_LEVEL_FIELDS.filter((field) => !hasField(parsedRecord, field));
  const parameters = parsedRecord.parameters;
  const hasParametersRecord = isRecord(parameters);
  const parametersRecord = parameters as Record<string, unknown>;
  const requiredParameterFields: ParameterName[] = [
    "AGENT_TRADE_AMOUNT",
    "AGENT_COOLDOWN_HOURS",
    "AGENT_MAX_POSITIONS",
    "AGENT_INTERVAL_MS",
  ];
  const missingParameterFields = hasParametersRecord
    ? requiredParameterFields.filter((field) => !hasField(parametersRecord, field))
    : requiredParameterFields;

  if (missingTopLevelFields.length > 0 || missingParameterFields.length > 0) {
    console.error(`CRON ERROR: Missing fields in response for ${agentId}`);
    throw new Error("Missing required fields in response");
  }

  const tradeAmount = Number(parametersRecord.AGENT_TRADE_AMOUNT);
  const cooldownHours = Number(parametersRecord.AGENT_COOLDOWN_HOURS);
  const maxPositions = Number(parametersRecord.AGENT_MAX_POSITIONS);
  const intervalMs = Number(parametersRecord.AGENT_INTERVAL_MS);
  const hasInvalidParameterValue =
    !Number.isFinite(tradeAmount) ||
    !Number.isFinite(cooldownHours) ||
    !Number.isFinite(maxPositions) ||
    !Number.isFinite(intervalMs);
  const hasInvalidTopLevelType =
    typeof parsedRecord.cycle_assessment !== "string" ||
    typeof parsedRecord.activity_status !== "string" ||
    typeof parsedRecord.position_decision !== "string" ||
    typeof parsedRecord.reasoning !== "string" ||
    !Array.isArray(parsedRecord.tokens_to_watch) ||
    !parsedRecord.tokens_to_watch.every((token) => typeof token === "string") ||
    typeof parsedRecord.troll_box !== "string" ||
    typeof parsedRecord.confidence !== "string" ||
    typeof parsedRecord.hold !== "boolean";

  if (hasInvalidParameterValue || hasInvalidTopLevelType) {
    console.error(`CRON ERROR: Missing fields in response for ${agentId}`);
    throw new Error("Missing required fields in response");
  }

  return {
    parameters: {
      AGENT_TRADE_AMOUNT: clampParameter("AGENT_TRADE_AMOUNT", tradeAmount, agentId),
      AGENT_COOLDOWN_HOURS: clampParameter("AGENT_COOLDOWN_HOURS", cooldownHours, agentId),
      AGENT_MAX_POSITIONS: clampParameter("AGENT_MAX_POSITIONS", maxPositions, agentId),
      AGENT_INTERVAL_MS: clampParameter("AGENT_INTERVAL_MS", intervalMs, agentId),
    },
    cycle_assessment: parsedRecord.cycle_assessment as string,
    activity_status: parsedRecord.activity_status as string,
    position_decision: parsedRecord.position_decision as string,
    reasoning: parsedRecord.reasoning as string,
    tokens_to_watch: parsedRecord.tokens_to_watch as string[],
    troll_box: parsedRecord.troll_box as string,
    confidence: parsedRecord.confidence as string,
    hold: parsedRecord.hold as boolean,
  };
}
