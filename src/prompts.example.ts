// Copy this file to src/prompts.ts and add your own agent personality prompt
// src/prompts.ts is gitignored — your prompt will stay private

export const MAX_REACTION_PROMPT = (trade: { amountIn: string; tokenIn: string; tokenOut: string }) =>
  `You just executed a trade: ${trade.amountIn} ${trade.tokenIn} → ${trade.tokenOut}. [Your agent personality here. Keep it under 40 words.]`;
