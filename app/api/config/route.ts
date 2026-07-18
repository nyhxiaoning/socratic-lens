import { NextRequest, NextResponse } from "next/server";
import {
  getRuntimeConfig,
  invalidateConfigCache,
  resolveForTest,
  setRuntimeConfig,
  type RuntimeConfig,
} from "@/lib/config";
import { resetClientCache, testConnection } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** key 打码：只留前 4 后 4，中间用 … 代替。UI 回显用。 */
function maskKey(key?: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** GET /api/config —— 回显已保存的运行时配置（key 打码，不回传明文）。 */
export async function GET() {
  const c = await getRuntimeConfig();
  return NextResponse.json({
    baseUrl: c.baseUrl ?? "",
    model: c.model ?? "",
    modelTeacher: c.modelTeacher ?? "",
    modelLearner: c.modelLearner ?? "",
    modelAudit: c.modelAudit ?? "",
    auditBaseUrl: c.auditBaseUrl ?? "",
    auditModel: c.auditModel ?? "",
    priceIn: c.priceIn ?? null,
    priceOut: c.priceOut ?? null,
    hasApiKey: Boolean(c.apiKey),
    apiKeyMasked: maskKey(c.apiKey),
    hasAuditApiKey: Boolean(c.auditApiKey),
    auditApiKeyMasked: maskKey(c.auditApiKey),
    // 环境变量也算一种来源，提示用户「已有 env 配置」
    envBaseUrl: (process.env.LLM_BASE_URL ?? "").trim() ? true : false,
    envApiKey: (process.env.LLM_API_KEY ?? "").trim() ? true : false,
    envModel: (process.env.LLM_MODEL ?? "").trim() ? true : false,
  });
}

type SaveBody = RuntimeConfig & {
  /** true 时不保存，只做一次真实连通测试。 */
  testOnly?: boolean;
  /** 前端若没改 key（保持打码占位）就传 false，让后端保留原 key。 */
  apiKeyChanged?: boolean;
  auditApiKeyChanged?: boolean;
};

/**
 * POST /api/config
 *  - body.testOnly=true：用「传入的（或已保存的）」配置发一次极小的真实请求，验证能否连通。
 *  - 否则：保存到 data/config.json，并重置客户端缓存。
 */
export async function POST(req: NextRequest) {
  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const existing = await getRuntimeConfig();

  if (body.testOnly) {
    // 探活：用「表单 > 已存 > env」解析出连接三元组，直接测，不写盘、不污染已保存配置。
    const resolved = await resolveForTest({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      model: body.model,
      apiKeyChanged: body.apiKeyChanged,
    });
    if (!resolved.baseUrl || !resolved.apiKey || !resolved.model) {
      const missing = [
        !resolved.baseUrl && "BASE_URL",
        !resolved.apiKey && "API Key",
        !resolved.model && "MODEL",
      ]
        .filter(Boolean)
        .join(" / ");
      return NextResponse.json({ ok: false, error: `还缺：${missing}` }, { status: 200 });
    }
    const result = await testConnection(resolved.baseUrl, resolved.apiKey, resolved.model);
    return NextResponse.json(result, { status: 200 });
  }

  // key 处理：前端只有在用户真正改了 key 时才传新值；否则保留已存的。
  const apiKey = body.apiKeyChanged ? body.apiKey : existing.apiKey;
  const auditApiKey = body.auditApiKeyChanged ? body.auditApiKey : existing.auditApiKey;

  const nextConfig: RuntimeConfig = {
    baseUrl: body.baseUrl,
    apiKey,
    model: body.model,
    modelTeacher: body.modelTeacher,
    modelLearner: body.modelLearner,
    modelAudit: body.modelAudit,
    auditBaseUrl: body.auditBaseUrl,
    auditApiKey,
    auditModel: body.auditModel,
    priceIn: body.priceIn,
    priceOut: body.priceOut,
  };

  await setRuntimeConfig(nextConfig);
  invalidateConfigCache();
  resetClientCache();
  return NextResponse.json({ ok: true });
}
