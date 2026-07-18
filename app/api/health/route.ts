import { NextResponse } from "next/server";
import { connectionStatus } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/health —— 连接是否配齐（不发起网络请求）。页面加载时用。 */
export async function GET() {
  const status = await connectionStatus();
  return NextResponse.json(status);
}
