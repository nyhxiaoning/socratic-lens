import { NextRequest, NextResponse } from "next/server";
import { listBooks } from "@/lib/book";
import { bookExists, parseMarkdownToBook, writeBook } from "@/lib/import-book";

export const runtime = "nodejs";

export async function GET() {
  const books = await listBooks();
  return NextResponse.json({ books });
}

type UploadBody = {
  slug?: string;
  title?: string;
  author?: string;
  markdown?: string;
};

/** POST /api/books —— 上传整本 md，自动切节入库。 */
export async function POST(req: NextRequest) {
  let body: UploadBody;
  try {
    body = (await req.json()) as UploadBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const slug = (body.slug ?? "").trim();
  const markdown = body.markdown ?? "";

  if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
    return NextResponse.json(
      { error: "slug 只能用小写字母、数字、连字符（1-64 字符）" },
      { status: 400 },
    );
  }
  if (markdown.trim().length === 0) {
    return NextResponse.json({ error: "markdown 内容为空" }, { status: 400 });
  }
  if (await bookExists(slug)) {
    return NextResponse.json({ error: `slug「${slug}」已存在，请换一个` }, { status: 409 });
  }

  const parsed = parseMarkdownToBook(markdown);
  if (parsed.sections.length === 0) {
    return NextResponse.json(
      { error: "没找到任何 ## 导论 / ## 第X章 / ## 第X节 边界，切不出节" },
      { status: 400 },
    );
  }

  const title = (body.title ?? "").trim() || parsed.suggestedTitle || slug;
  const author = (body.author ?? "").trim() || undefined;

  try {
    await writeBook(slug, title, author, parsed.sections);
  } catch (e) {
    return NextResponse.json(
      { error: `写盘失败：${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    slug,
    title,
    author,
    sectionCount: parsed.sections.length,
    sections: parsed.sections.map((s) => ({ id: s.id, title: s.title, chars: s.body.length })),
  });
}
