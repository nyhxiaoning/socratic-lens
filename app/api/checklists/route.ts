import { NextRequest, NextResponse } from "next/server";
import { getBook, getSection, getSectionTitle } from "@/lib/book";
import { generateChecklist, listExistingChecklists, getChecklist } from "@/lib/checklist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/checklists?bookSlug=xxx
 * → { checklists: { sectionId: string; title: string; exists: boolean; itemCount?: number }[] }
 *
 * 返回某本书每节的知识点清单状态（是否存在缓存）。
 */
export async function GET(req: NextRequest) {
  const bookSlug = req.nextUrl.searchParams.get("bookSlug");
  if (!bookSlug) {
    return NextResponse.json({ error: "需要 bookSlug" }, { status: 400 });
  }

  try {
    const book = await getBook(bookSlug);
    const existing = await listExistingChecklists(bookSlug);
    const results = await Promise.all(
      book.sections.map(async (s) => {
        if (existing.has(s.id)) {
          const cl = await getChecklist(bookSlug, s.id);
          const total =
            (cl?.knowledgePoints.length ?? 0) +
            (cl?.assessmentCriteria.length ?? 0) +
            (cl?.exercises.length ?? 0) +
            (cl?.errorSpots.length ?? 0);
          return { sectionId: s.id, title: s.title, exists: true, itemCount: total };
        }
        return { sectionId: s.id, title: s.title, exists: false };
      }),
    );
    return NextResponse.json({ checklists: results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/checklists { bookSlug, sectionId }
 * → { checklist: Checklist, itemCount: number }
 *
 * 为某节生成知识点清单并缓存。同步（非流式），一般几秒返回。
 */
export async function POST(req: NextRequest) {
  let body: { bookSlug?: string; sectionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { bookSlug, sectionId } = body;
  if (!bookSlug || !sectionId) {
    return NextResponse.json({ error: "需要 bookSlug 和 sectionId" }, { status: 400 });
  }

  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  try {
    const sectionText = await getSection(bookSlug, sectionId);
    const sectionTitle = getSectionTitle(await getBook(bookSlug), sectionId);
    const checklist = await generateChecklist(bookSlug, sectionId, sectionText, abortCtrl.signal);
    const total =
      checklist.knowledgePoints.length +
      checklist.assessmentCriteria.length +
      checklist.exercises.length +
      checklist.errorSpots.length;
    return NextResponse.json({
      checklist,
      itemCount: total,
      sectionId,
      sectionTitle,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
