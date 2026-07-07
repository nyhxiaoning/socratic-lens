/**
 * 参照 Socratopia §5.4 的分页与自适应翻页。
 * 我们的 section 已经是切好的教学单元；这里把 section 内部再切成"页"，
 * 让教师每轮只看当前窗口，节省 context。
 */

export type Page = {
  page: number;
  chars: number;
  text: string;
};

/** 超过这个字符数的 section 才启用分页；短 section 直接全塞。 */
export const PAGINATION_THRESHOLD = 12_000;

/** 目标页大小；按段落边界切，允许上下浮动。 */
const TARGET_PAGE_CHARS = 1800;

/** 教师看到的窗口默认预算（字符数）。 */
export const WINDOW_BUDGET_CHARS = 8_000;

/** 滑窗时旧窗保留的页数（作重叠，保证话题连续）。 */
const OVERLAP_PAGES_ON_SLIDE = 2;

/**
 * 把一段 markdown 按段落（`\n\n`）切分，凑成目标大小的页。
 * 单个段落如果超过 2 * TARGET，会被强行按句号切开。
 */
export function paginate(text: string): Page[] {
  // 段落切分：`\n\n` 为分隔
  const paragraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // 超长段落强行按 "。" 切
  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= TARGET_PAGE_CHARS * 2) {
      chunks.push(para);
      continue;
    }
    // 按 "。" 切
    const sentences = para.split(/(?<=。)/g);
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length > TARGET_PAGE_CHARS && buf.length > 0) {
        chunks.push(buf);
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf.length > 0) chunks.push(buf);
  }

  // 累积成页
  const pages: Page[] = [];
  let buf: string[] = [];
  let bufChars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join("\n\n");
    pages.push({ page: pages.length + 1, chars: text.length, text });
    buf = [];
    bufChars = 0;
  };

  for (const c of chunks) {
    if (bufChars > 0 && bufChars + c.length > TARGET_PAGE_CHARS * 1.4) {
      flush();
    }
    buf.push(c);
    bufChars += c.length + 2;
  }
  flush();

  return pages;
}

/**
 * 从 Page[] 中取 [startPage, endPage] 段拼成"当前窗口"文本，含 `--- 第 N 页 ---` 分隔。
 * page 号从 1 开始，闭区间。
 */
export function renderWindow(pages: Page[], startPage: number, endPage: number): string {
  const parts: string[] = [];
  const start = Math.max(1, startPage);
  const end = Math.min(pages.length, endPage);
  for (let i = start; i <= end; i++) {
    const p = pages[i - 1];
    if (!p) continue;
    parts.push(`--- 第 ${p.page} 页 ---\n${p.text}`);
  }
  return parts.join("\n\n");
}

/** 从头开始，累计 ≤ budget 字符的最大页数。 */
export function initialWindow(pages: Page[], budget: number = WINDOW_BUDGET_CHARS): {
  startPage: number;
  endPage: number;
} {
  if (pages.length === 0) return { startPage: 1, endPage: 0 };
  let end = 0;
  let chars = 0;
  for (const p of pages) {
    if (end > 0 && chars + p.chars > budget) break;
    end = p.page;
    chars += p.chars;
  }
  return { startPage: 1, endPage: end };
}

/**
 * 计算滑窗后的新范围。
 * 算法（参照 Socratopia §5.4 `xC`）：
 *   - 保留当前窗的后 OVERLAP_PAGES_ON_SLIDE 页（重叠，保证话题连续）
 *   - 从当前 endPage + 1 起，追加新页直至新窗 ≤ budget
 *   - 若剩余页数不足半个新增空间，则一次吃到末尾（末页守恒）
 *
 * 返回 null 表示已经到末尾，无法再滑。
 */
export function slideWindow(
  pages: Page[],
  cur: { startPage: number; endPage: number },
  budget: number = WINDOW_BUDGET_CHARS,
): { startPage: number; endPage: number } | null {
  if (cur.endPage >= pages.length) return null; // 已到末尾

  // 新起点：当前窗末端 - overlap + 1
  const newStart = Math.max(cur.endPage - OVERLAP_PAGES_ON_SLIDE + 1, cur.startPage + 1);
  let newEnd = newStart;
  let chars = 0;

  for (let i = newStart; i <= pages.length; i++) {
    const p = pages[i - 1];
    if (!p) break;
    if (newEnd >= newStart && i > newStart && chars + p.chars > budget) break;
    newEnd = i;
    chars += p.chars;
  }

  // 末页守恒：若剩余 < 新增预算的一半，一次吃完
  if (pages.length - newEnd < Math.max(1, Math.floor(OVERLAP_PAGES_ON_SLIDE / 2))) {
    newEnd = pages.length;
  }

  // 如果滑完窗和原窗一样，说明滑不动（不该发生但保守）
  if (newStart === cur.startPage && newEnd === cur.endPage) return null;

  return { startPage: newStart, endPage: newEnd };
}
