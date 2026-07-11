import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type Purpose = "teacher" | "learner" | "audit" | "coach";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

/** 一次调用的 token 用量。字段直接来自 OpenAI/兼容端点的 usage 对象。 */
export type LLMUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type LLMOptions = {
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** 强制模型输出 JSON（OpenAI 兼容 response_format=json_object）。仅非流式生效。 */
  jsonMode?: boolean;
  /** 拿到 usage 时的回调（不是所有 provider 都会给；给了才调）。 */
  onUsage?: (u: LLMUsage) => void;
};

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`环境变量缺失：${key}（复制 .env.example 到 .env.local 并填入）`);
  return v;
}

export function pickModel(purpose: Purpose): string {
  if (purpose === "audit") {
    const auditModel = process.env.LLM_AUDIT_MODEL || process.env.LLM_MODEL_AUDIT;
    if (auditModel) return auditModel;
    return requireEnv("LLM_MODEL");
  }
  const override = process.env[`LLM_MODEL_${purpose.toUpperCase()}`];
  return override || requireEnv("LLM_MODEL");
}

const clientCache = new Map<string, OpenAI>();
export function getClient(purpose: Purpose): OpenAI {
  // audit 若配了独立端点，用独立 key + baseURL；否则回落共享
  const useAudit = purpose === "audit" && !!process.env.LLM_AUDIT_BASE_URL;
  const baseURL = useAudit
    ? requireEnv("LLM_AUDIT_BASE_URL")
    : requireEnv("LLM_BASE_URL");
  const apiKey = useAudit
    ? (process.env.LLM_AUDIT_API_KEY || requireEnv("LLM_API_KEY"))
    : requireEnv("LLM_API_KEY");
  const cached = clientCache.get(baseURL);
  if (cached) return cached;
  const client = new OpenAI({ apiKey, baseURL });
  clientCache.set(baseURL, client);
  return client;
}

function logCall(
  purpose: Purpose,
  model: string,
  msgCount: number,
  inputChars: number,
  outputChars: number,
  ms: number,
  usage?: LLMUsage,
): void {
  console.log(
    JSON.stringify({
      tag: "llm",
      purpose,
      model,
      msgCount,
      inputChars,
      outputChars,
      ms,
      ...(usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          }
        : {}),
    }),
  );
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
  const client = getClient(purpose);
  const model = pickModel(purpose);
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t0 = Date.now();

  const sdkMessages = messages as ChatCompletionMessageParam[];

  if (opts.stream) {
    return (async function* () {
      let outputChars = 0;
      let usage: LLMUsage | undefined;
      const stream = await client.chat.completions.create(
        {
          model,
          messages: sdkMessages,
          stream: true,
          // 让流的最后一个 chunk 带 usage（OpenAI 兼容参数）
          stream_options: { include_usage: true },
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
        },
        { signal: opts.signal },
      );
      try {
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            outputChars += delta.length;
            yield delta;
          }
          // 最后一个 chunk 通常 choices=[]，usage 在这里
          const u = chunk.usage;
          if (u) {
            usage = {
              promptTokens: u.prompt_tokens ?? 0,
              completionTokens: u.completion_tokens ?? 0,
              totalTokens: u.total_tokens ?? 0,
            };
          }
        }
      } finally {
        if (usage && opts.onUsage) opts.onUsage(usage);
        logCall(purpose, model, messages.length, inputChars, outputChars, Date.now() - t0, usage);
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
    let usage: LLMUsage | undefined;
    if (resp.usage) {
      usage = {
        promptTokens: resp.usage.prompt_tokens ?? 0,
        completionTokens: resp.usage.completion_tokens ?? 0,
        totalTokens: resp.usage.total_tokens ?? 0,
      };
      if (opts.onUsage) opts.onUsage(usage);
    }
    logCall(purpose, model, messages.length, inputChars, text.length, Date.now() - t0, usage);
    return text;
  })();
}
