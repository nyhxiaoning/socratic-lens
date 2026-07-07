import { NextRequest, NextResponse } from "next/server";
import { getBook, getSection } from "@/lib/book";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { slug } = await ctx.params;
  try {
    const book = await getBook(slug);
    const sectionId = req.nextUrl.searchParams.get("section");
    if (sectionId) {
      const text = await getSection(slug, sectionId);
      return NextResponse.json({ slug, sectionId, text });
    }
    return NextResponse.json({ slug, ...book });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}
