import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { resolveConnection, resolveModel, usesAuditEndpoint } from "./config";

export type Purpose = "teacher" | "learner" | "audit" | "coach";

export type LLMMessage = { role: "system" | "user" | "assistant"; content: string };

/** 一次调用的 token 用量。字段直接来自 OpenAI/兼容端点的 usage 对象。 */
export type LLMUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** DeepSeek 上下文硬盘缓存命中 token 数 */
  cacheHitTokens?: number;
  /** DeepSeek 上下文硬盘缓存未命中 token 数 */
  cacheMissTokens?: number;
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

/**
 * 强制 tool calling 的定义。传入后 callLLMWithTool 使用 tools + tool_choice=required，
 * 比 jsonMode 稳定得多（几乎所有模型都支持 tool calling，包括 DeepSeek）。
 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

/** 该 purpose 该用哪个模型（运行时配置优先，回落环境变量）。 */
export async function pickModel(purpose: Purpose): Promise<string> {
  return resolveModel(purpose);
}

// 客户端按 baseURL+apiKey 组合缓存；配置一改就要失效（见 resetClientCache）。
const clientCache = new Map<string, OpenAI>();
export async function getClient(purpose: Purpose): Promise<OpenAI> {
  const { baseUrl, apiKey } = await resolveConnection(purpose);
  const key = `${baseUrl}\u0000${apiKey}`;
  const cached = clientCache.get(key);
  if (cached) return cached;
  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  clientCache.set(key, client);
  return client;
}

/** 连接配置变更后调用：丢掉带旧 key/baseURL 的客户端缓存。 */
export function resetClientCache(): void {
  clientCache.clear();
}

/**
 * 用「显式给定」的连接参数发一个极小请求，验证能否连通。
 * 不经过 config.json、不写盘、不污染已保存配置——纯探活。
 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  try {
    const client = new OpenAI({ apiKey, baseURL: baseUrl });
    const extraBody: Record<string, unknown> = /deepseek/i.test(model)
      ? { thinking: { type: "disabled" } }
      : {};
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "ping，只回复 pong" }],
      max_tokens: 8,
      temperature: 0,
      ...extraBody,
    });
    const reply = resp.choices?.[0]?.message?.content ?? "";
    return { ok: true, reply: (reply || "").slice(0, 40) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 从 OpenAI 兼容 usage 对象提取用量（含 DeepSeek 缓存命中字段）。 */
function extractUsage(u: Record<string, unknown> | undefined): LLMUsage | undefined {
  if (!u) return undefined;
  const promptTokens = (u.prompt_tokens as number) ?? 0;
  const completionTokens = (u.completion_tokens as number) ?? 0;
  const totalTokens = (u.total_tokens as number) ?? 0;
  const cacheHitTokens = u.prompt_cache_hit_tokens as number | undefined;
  const cacheMissTokens = u.prompt_cache_miss_tokens as number | undefined;
  return { promptTokens, completionTokens, totalTokens, cacheHitTokens, cacheMissTokens };
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
            ...(usage.cacheHitTokens != null ? { cacheHitTokens: usage.cacheHitTokens } : {}),
            ...(usage.cacheMissTokens != null ? { cacheMissTokens: usage.cacheMissTokens } : {}),
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
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t0 = Date.now();

  const sdkMessages = messages as ChatCompletionMessageParam[];

  if (opts.stream) {
    return (async function* () {
      const client = await getClient(purpose);
      const model = await pickModel(purpose);
      // DeepSeek 模型默认关闭 thinking（教学/审计场景不需要扩展推理，浪费 token 且破坏结构化输出）
      const extraBody: Record<string, unknown> = /deepseek/i.test(model)
        ? { thinking: { type: "disabled" } }
        : {};
      let outputChars = 0;
      let usage: LLMUsage | undefined;
      const stream = await client.chat.completions.create(
        {
          model,
          messages: sdkMessages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          ...extraBody,
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
          if (u) usage = extractUsage(u as unknown as Record<string, unknown>);
        }
      } finally {
        if (usage && opts.onUsage) opts.onUsage(usage);
        logCall(purpose, model, messages.length, inputChars, outputChars, Date.now() - t0, usage);
      }
    })();
  }

  return (async () => {
    const client = await getClient(purpose);
    const model = await pickModel(purpose);
    const extraBody: Record<string, unknown> = /deepseek/i.test(model)
      ? { thinking: { type: "disabled" } }
      : {};
    // 一些模型（如 DeepSeek v4 flash）的 json_object mode 返回空内容。
    // 检测到已知不兼容的模型时跳过 response_format，靠 prompt 约束保 JSON 输出。
    const skipJsonResp = opts.jsonMode && /deepseek/i.test(model);
    const resp = await client.chat.completions.create(
      {
        model,
        messages: sdkMessages,
        stream: false,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        response_format: opts.jsonMode && !skipJsonResp ? { type: "json_object" } : undefined,
        ...extraBody,
      },
      { signal: opts.signal },
    );
    const text = resp.choices?.[0]?.message?.content ?? "";
    const usage = extractUsage(resp.usage as unknown as Record<string, unknown> | undefined);
    if (usage && opts.onUsage) opts.onUsage(usage);
    logCall(purpose, model, messages.length, inputChars, text.length, Date.now() - t0, usage);
    return text;
  })();
}

/**
 * 使用 tool calling 强制结构化输出。
 * 比 jsonMode 稳定：几乎所有 OpenAI 兼容模型都支持 tool calling（包括 DeepSeek），
 * 且 tool_choice=required 强制模型调用函数，返回的 arguments 天然是合法 JSON。
 *
 * 自动回退：如果模型不支持 tool_choice=required（如 DeepSeek 的 thinking mode），
 * 降级为无 tool_choice 的 tools；再失败则走 jsonMode 兜底。
 *
 * 返回解析后的 arguments 对象（已 JSON.parse）。失败抛错。
 */
export async function callLLMWithTool(
  purpose: Purpose,
  messages: LLMMessage[],
  tool: ToolDef,
  opts: LLMOptions = {},
): Promise<Record<string, unknown>> {
  const client = await getClient(purpose);
  const model = await pickModel(purpose);
  const inputChars = messages.reduce((s, m) => s + m.content.length, 0);
  const t0 = Date.now();

  const toolDef = {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  };

  const extraBody: Record<string, unknown> = /deepseek/i.test(model)
    ? { thinking: { type: "disabled" } }
    : {};

  // 尝试顺序：
  // Tier 1: tool_choice="required"（最可靠，但 thinking mode 不支持）
  // Tier 2: 只有 tools，无 tool_choice（靠 prompt 和 schema 引导）
  // Tier 3: jsonMode 纯文本（DeepSeek flash 也可能失败，但已走 parseJsonLoose）
  const tiers: Array<{ tool_choice?: "required"; tools?: typeof toolDef[] }> = [
    { tool_choice: "required", tools: [toolDef] },
    { tools: [toolDef] },                         // 无 tool_choice 降级
    {},                                            // jsonMode 兜底
  ];

  let lastErr: unknown;
  for (const tier of tiers) {
    try {
      const resp = await client.chat.completions.create(
        {
          model,
          messages: messages as ChatCompletionMessageParam[],
          stream: false,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          ...(tier.tools ? { tools: tier.tools } : {}),
          ...(tier.tool_choice ? { tool_choice: tier.tool_choice } : {}),
          ...(tier.tools === undefined
            ? { response_format: /deepseek/i.test(model) ? undefined : { type: "json_object" as const } }
            : {}),
          ...extraBody,
        },
        { signal: opts.signal },
      );

      const choice = resp.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];
      const content = choice?.message?.content ?? "";
      const rawArgs = toolCall?.function?.arguments ?? "";

      const usage = extractUsage(resp.usage as unknown as Record<string, unknown> | undefined);
      if (usage && opts.onUsage) opts.onUsage(usage);
      logCall(purpose, model, messages.length, inputChars, rawArgs.length, Date.now() - t0, usage);

      // 优先解析 tool call arguments
      if (rawArgs) {
        try {
          return JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          // arguments 解析失败，继续尝试 content
        }
      }

      // 降级：从 message content 解析 JSON
      if (content) {
        // 复用 parseJsonLoose 的容错逻辑
        try {
          return JSON.parse(content) as Record<string, unknown>;
        } catch { /* fallthrough */ }
        // 剥 <think> 和 ```json``` 围栏
        let s = content.trim();
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const first = s.indexOf("{");
        const last = s.lastIndexOf("}");
        if (first !== -1 && last > first) s = s.slice(first, last + 1);
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch { /* fallthrough */ }
      }

      throw new Error("无可用输出");
    } catch (e) {
      lastErr = e;
      // 400 错误跳过当前 tier（模型不支持），其他错误直接抛
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("400") && msg.includes("tool_choice")) continue;
      // 非 400 的其他服务端错误也尝试降级
      if (msg.includes("400") || msg.includes("500") || msg.includes("503")) continue;
      throw e;
    }
  }

  throw new Error(
    `callLLMWithTool 全部降级失败（模型 "${model}"）：` +
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
