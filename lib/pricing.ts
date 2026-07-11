/**
 * Token → 人民币的换算。
 *
 * 从环境变量读单价（每 1000 token）：
 *   LLM_PRICE_IN   输入价（默认 0）
 *   LLM_PRICE_OUT  输出价（默认 0）
 *
 * 也可以按 purpose 覆盖，例如：
 *   LLM_PRICE_IN_COACH / LLM_PRICE_OUT_COACH
 *   LLM_PRICE_IN_TEACHER / LLM_PRICE_OUT_TEACHER
 *   ...
 *
 * 不填就返回 0——不影响功能，只是成本累计显示为 0。
 */
import type { Purpose } from "./llm";

function num(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pickPrice(kind: "IN" | "OUT", purpose: Purpose): number {
  return num(`LLM_PRICE_${kind}_${purpose.toUpperCase()}`) ?? num(`LLM_PRICE_${kind}`) ?? 0;
}

/** 一次调用花多少钱（¥）。价格单位：每 1000 token。 */
export function estimateCost(
  purpose: Purpose,
  promptTokens: number,
  completionTokens: number,
): number {
  const pIn = pickPrice("IN", purpose);
  const pOut = pickPrice("OUT", purpose);
  return (promptTokens / 1000) * pIn + (completionTokens / 1000) * pOut;
}
