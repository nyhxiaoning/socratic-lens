/**
 * 运行时连接配置层。
 *
 * 设计目标：让用户在页面里就能填 LLM 连接（BASE_URL / KEY / MODEL），
 * 不必手动去改 .env.local 再重启进程。
 *
 * 优先级：`data/config.json`（运行时写入）> 环境变量（.env.local）。
 * 读某个字段时，只要运行时配置里有非空值就用它，否则回落环境变量。
 *
 * 这个文件是唯一解析「用哪个 baseURL / key / model / 价格」的地方。
 * lib/llm.ts 与 lib/pricing.ts 都从这里取值。
 */
import path from "node:path";
import { DATA_ROOT, exists, readJson, writeAtomic } from "./storage";
import type { Purpose } from "./llm";

const CONFIG_PATH = path.join(DATA_ROOT, "config.json");

/** 运行时可覆盖的连接字段。所有字段都可选——缺失就回落到同名环境变量。 */
export type RuntimeConfig = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  modelTeacher?: string;
  modelLearner?: string;
  modelAudit?: string;
  auditBaseUrl?: string;
  auditApiKey?: string;
  auditModel?: string;
  priceIn?: number;
  priceOut?: number;
};

// 进程内缓存，避免每次调用都读盘。写入时刷新。
let cache: RuntimeConfig | null = null;

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}
function cleanNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function load(): Promise<RuntimeConfig> {
  if (cache) return cache;
  if (await exists(CONFIG_PATH)) {
    try {
      const raw = await readJson<Record<string, unknown>>(CONFIG_PATH);
      cache = {
        baseUrl: clean(raw.baseUrl),
        apiKey: clean(raw.apiKey),
        model: clean(raw.model),
        modelTeacher: clean(raw.modelTeacher),
        modelLearner: clean(raw.modelLearner),
        modelAudit: clean(raw.modelAudit),
        auditBaseUrl: clean(raw.auditBaseUrl),
        auditApiKey: clean(raw.auditApiKey),
        auditModel: clean(raw.auditModel),
        priceIn: cleanNum(raw.priceIn),
        priceOut: cleanNum(raw.priceOut),
      };
    } catch {
      cache = {};
    }
  } else {
    cache = {};
  }
  return cache;
}

/** 读运行时配置（不含回落）。UI 用来回显已保存的值。 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  return { ...(await load()) };
}

/** 覆盖写入运行时配置。传入的字段整体替换文件内容（UI 每次提交都是完整表单）。 */
export async function setRuntimeConfig(next: RuntimeConfig): Promise<RuntimeConfig> {
  const merged: RuntimeConfig = {
    baseUrl: clean(next.baseUrl),
    apiKey: clean(next.apiKey),
    model: clean(next.model),
    modelTeacher: clean(next.modelTeacher),
    modelLearner: clean(next.modelLearner),
    modelAudit: clean(next.modelAudit),
    auditBaseUrl: clean(next.auditBaseUrl),
    auditApiKey: clean(next.auditApiKey),
    auditModel: clean(next.auditModel),
    priceIn: cleanNum(next.priceIn),
    priceOut: cleanNum(next.priceOut),
  };
  await writeAtomic(CONFIG_PATH, JSON.stringify(merged, null, 2));
  cache = merged;
  return merged;
}

/** 强制下次 load 重新读盘（写入后调用，让 llm 客户端缓存也失效）。 */
export function invalidateConfigCache(): void {
  cache = null;
}

// ---- 解析函数：给定 purpose，算出该用哪个 baseURL / key / model ----

function envModelForPurpose(purpose: Purpose): string | undefined {
  return clean(process.env[`LLM_MODEL_${purpose.toUpperCase()}`]);
}

/** 该 purpose 是否走独立审计端点（配了 auditBaseUrl 才走）。 */
export async function usesAuditEndpoint(purpose: Purpose): Promise<boolean> {
  if (purpose !== "audit") return false;
  const c = await load();
  return Boolean(c.auditBaseUrl || clean(process.env.LLM_AUDIT_BASE_URL));
}

/** 解析连接（baseURL + apiKey）。缺失抛错，错误信息告诉用户去哪填。 */
export async function resolveConnection(
  purpose: Purpose,
): Promise<{ baseUrl: string; apiKey: string }> {
  const c = await load();
  const useAudit = await usesAuditEndpoint(purpose);
  if (useAudit) {
    const baseUrl = c.auditBaseUrl || clean(process.env.LLM_AUDIT_BASE_URL);
    const apiKey =
      c.auditApiKey ||
      clean(process.env.LLM_AUDIT_API_KEY) ||
      c.apiKey ||
      clean(process.env.LLM_API_KEY);
    if (!baseUrl) throw new Error("缺少审计端点 BASE_URL（在「连接设置」里填，或设 LLM_AUDIT_BASE_URL）");
    if (!apiKey) throw new Error("缺少 API Key（在「连接设置」里填，或设 LLM_API_KEY）");
    return { baseUrl, apiKey };
  }
  const baseUrl = c.baseUrl || clean(process.env.LLM_BASE_URL);
  const apiKey = c.apiKey || clean(process.env.LLM_API_KEY);
  if (!baseUrl) throw new Error("缺少 BASE_URL（在页面右上角「连接设置」里填，或设环境变量 LLM_BASE_URL）");
  if (!apiKey) throw new Error("缺少 API Key（在页面右上角「连接设置」里填，或设环境变量 LLM_API_KEY）");
  return { baseUrl, apiKey };
}

/** 解析该 purpose 用哪个模型。缺失抛错。 */
export async function resolveModel(purpose: Purpose): Promise<string> {
  const c = await load();
  if (purpose === "audit") {
    const m =
      c.auditModel || clean(process.env.LLM_AUDIT_MODEL) || c.modelAudit || envModelForPurpose("audit");
    if (m) return m;
  } else {
    const perPurpose =
      purpose === "teacher" ? c.modelTeacher : purpose === "learner" ? c.modelLearner : undefined;
    const m = perPurpose || envModelForPurpose(purpose);
    if (m) return m;
  }
  const base = c.model || clean(process.env.LLM_MODEL);
  if (!base) throw new Error("缺少模型名 MODEL（在页面右上角「连接设置」里填，或设环境变量 LLM_MODEL）");
  return base;
}

/** 单价（每 1000 token，¥）。运行时配置优先，回落 env，缺省 0。 */
export async function resolvePrice(kind: "IN" | "OUT", purpose: Purpose): Promise<number> {
  const c = await load();
  const runtime = kind === "IN" ? c.priceIn : c.priceOut;
  if (runtime !== undefined) return runtime;
  const byPurpose = cleanNum(process.env[`LLM_PRICE_${kind}_${purpose.toUpperCase()}`]);
  if (byPurpose !== undefined) return byPurpose;
  const generic = cleanNum(process.env[`LLM_PRICE_${kind}`]);
  return generic ?? 0;
}

/** 健康检查用：连接与模型是否齐备（不发起网络请求）。 */
export async function connectionStatus(): Promise<{
  configured: boolean;
  hasBaseUrl: boolean;
  hasApiKey: boolean;
  hasModel: boolean;
  source: "runtime" | "env" | "none";
}> {
  const c = await load();
  const hasBaseUrl = Boolean(c.baseUrl || clean(process.env.LLM_BASE_URL));
  const hasApiKey = Boolean(c.apiKey || clean(process.env.LLM_API_KEY));
  const hasModel = Boolean(c.model || clean(process.env.LLM_MODEL));
  const anyRuntime = Boolean(c.baseUrl || c.apiKey || c.model);
  const source: "runtime" | "env" | "none" = anyRuntime
    ? "runtime"
    : hasBaseUrl || hasApiKey || hasModel
      ? "env"
      : "none";
  return {
    configured: hasBaseUrl && hasApiKey && hasModel,
    hasBaseUrl,
    hasApiKey,
    hasModel,
    source,
  };
}

/**
 * 给定一份「表单值」，按 表单 > 已存运行时 > env 的优先级解析出用于测试的连接三元组。
 * 纯计算，不写盘。用于「测试连接」——测试不该有副作用。
 */
export async function resolveForTest(form: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  apiKeyChanged?: boolean;
}): Promise<{ baseUrl?: string; apiKey?: string; model?: string }> {
  const saved = await load();
  const baseUrl = clean(form.baseUrl) || saved.baseUrl || clean(process.env.LLM_BASE_URL);
  const apiKey =
    (form.apiKeyChanged ? clean(form.apiKey) : undefined) ||
    saved.apiKey ||
    clean(process.env.LLM_API_KEY);
  const model = clean(form.model) || saved.model || clean(process.env.LLM_MODEL);
  return { baseUrl, apiKey, model };
}
