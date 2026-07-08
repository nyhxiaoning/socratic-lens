import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type Purpose = "teacher" | "learner" | "audit" | "coach";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

export type LLMOptions = {
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 强制模型输出 JSON（OpenAI 兼容 response_format=json_object）。仅非流式生效。 */
  jsonMode?: boolean;
};

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`环境变量缺失：${key}（复制 .env.example 到 .env.local 并填入）`);
  return v;
}

function pickModel(purpose: Purpose): string {
  const override = process.env[`LLM_MODEL_${purpose.toUpperCase()}`];
  return override || requireEnv("LLM_MODEL");
}

let clientCache: OpenAI | null = null;
function getClient(): OpenAI {
  if (clientCache) return clientCache;
  clientCache = new OpenAI({
    apiKey: requireEnv("LLM_API_KEY"),
    baseURL: requireEnv("LLM_BASE_URL"),
  });
  return clientCache;
}

function logCall(
  purpose: Purpose,
  model: string,
  msgCount: number,
  inputChars: number,
  outputChars: number,
  ms: number,
  usage?: { cacheHit?: number; cacheMiss?: number; promptTokens?: number } | null,
): void {
  const rec: Record<string, unknown> = {
    tag: "llm",
    purpose,
    model,
    msgCount,
    inputChars,
    outputChars,
    ms,
  };
  if (usage) {
    // DeepSeek 硬盘缓存命中情况：hit 计费约为 miss 的 1/10。命中率 = hit/(hit+miss)。
    if (usage.cacheHit !== undefined) rec.cacheHitTokens = usage.cacheHit;
    if (usage.cacheMiss !== undefined) rec.cacheMissTokens = usage.cacheMiss;
    if (usage.promptTokens !== undefined) rec.promptTokens = usage.promptTokens;
    const total = (usage.cacheHit ?? 0) + (usage.cacheMiss ?? 0);
    if (total > 0) rec.cacheHitRate = +((usage.cacheHit ?? 0) / total).toFixed(3);
  }
  console.log(JSON.stringify(rec));
}

/** 从 OpenAI 兼容 usage 字段里抽 DeepSeek 缓存命中数（字段可能不存在，非 DeepSeek provider 就没有）。 */
function extractUsage(
  usage: unknown,
): { cacheHit?: number; cacheMiss?: number; promptTokens?: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    cacheHit: num(u.prompt_cache_hit_tokens),
    cacheMiss: num(u.prompt_cache_miss_tokens),
    promptTokens: num(u.prompt_tokens),
  };
}

/**
 * 唯一 LLM 入口。参考 Socratopia 逆向报告 §2.1。
 *
 * stream=false → Promise<string>
 * stream=true  → AsyncIterable<string>（每个元素是一段增量文本）
 */
export function callLLM(
  purpose: Purpose,
  messages: LLMMessage[],
  opts: LLMOptions & { stream: true },
): AsyncIterable<string>;
export function callLLM(
  purpose: Purpose,
  messages: LLMMessage[],
  opts?: LLMOptions & { stream?: false },
): Promise<string>;
export function callLLM(
  purpose: Purpose,
  messages: LLMMessage[],
  opts: LLMOptions = {},
): Promise<string> | AsyncIterable<string> {
  const client = getClient();
  const model = pickModel(purpose);
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t0 = Date.now();

  const sdkMessages = messages as ChatCompletionMessageParam[];

  if (opts.stream) {
    return (async function* () {
      let outputChars = 0;
      let usage: unknown = null;
      const stream = await client.chat.completions.create(
        {
          model,
          messages: sdkMessages,
          stream: true,
          // 让流式响应在最后一个（空 choices）chunk 带上 usage，才能读到缓存命中数。
          stream_options: { include_usage: true },
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
        },
        { signal: opts.signal },
      );
      try {
        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            outputChars += delta.length;
            yield delta;
          }
        }
      } finally {
        logCall(
          purpose,
          model,
          messages.length,
          inputChars,
          outputChars,
          Date.now() - t0,
          extractUsage(usage),
        );
      }
    })();
  }

  return (async () => {
    const resp = await client.chat.completions.create(
      {
        model,
        messages: sdkMessages,
        stream: false,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        response_format: opts.jsonMode ? { type: "json_object" } : undefined,
      },
      { signal: opts.signal },
    );
    const text = resp.choices?.[0]?.message?.content ?? "";
    logCall(
      purpose,
      model,
      messages.length,
      inputChars,
      text.length,
      Date.now() - t0,
      extractUsage(resp.usage),
    );
    return text;
  })();
}
