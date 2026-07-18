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
import { resolvePrice } from "./config";

const PURPOSES: Purpose[] = ["teacher", "learner", "audit", "coach"];

/** 一次调用花多少钱（¥）。价格单位：每 1000 token。 */
export type CostEstimator = (
  purpose: Purpose,
  promptTokens: number,
  completionTokens: number,
) => number;

/**
 * 预解析一张价格表（运行时配置优先，回落 env），返回同步换算函数。
 *
 * 为什么预解析：usage 回调是同步的（llm.ts 的 onUsage），而价格来源
 * 走 config 层是异步读盘。会话开始前解析一次，循环内同步用即可。
 */
export async function makeCostEstimator(): Promise<CostEstimator> {
  const table = new Map<Purpose, { in: number; out: number }>();
  await Promise.all(
    PURPOSES.map(async (p) => {
      const [pin, pout] = await Promise.all([resolvePrice("IN", p), resolvePrice("OUT", p)]);
      table.set(p, { in: pin, out: pout });
    }),
  );
  return (purpose, promptTokens, completionTokens) => {
    const price = table.get(purpose) ?? { in: 0, out: 0 };
    return (promptTokens / 1000) * price.in + (completionTokens / 1000) * price.out;
  };
}
