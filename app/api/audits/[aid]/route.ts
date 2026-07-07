import { NextRequest, NextResponse } from "next/server";
import { readAudit } from "@/lib/audit";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ aid: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { aid } = await ctx.params;
  const audit = await readAudit(aid);
  if (!audit) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(audit);
}
