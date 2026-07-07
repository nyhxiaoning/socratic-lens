import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type Purpose = "teacher" | "learner" | "audit";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

export type LLMOptions = {
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
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
): void {
  console.log(
    JSON.stringify({ tag: "llm", purpose, model, msgCount, inputChars, outputChars, ms }),
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
  const client = getClient();
  const model = pickModel(purpose);
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t0 = Date.now();

  const sdkMessages = messages as ChatCompletionMessageParam[];

  if (opts.stream) {
    return (async function* () {
      let outputChars = 0;
      const stream = await client.chat.completions.create(
        {
          model,
          messages: sdkMessages,
          stream: true,
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
        }
      } finally {
        logCall(purpose, model, messages.length, inputChars, outputChars, Date.now() - t0);
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
      },
      { signal: opts.signal },
    );
    const text = resp.choices?.[0]?.message?.content ?? "";
    logCall(purpose, model, messages.length, inputChars, text.length, Date.now() - t0);
    return text;
  })();
}
