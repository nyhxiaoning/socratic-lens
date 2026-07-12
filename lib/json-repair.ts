/**
 * LLM JSON 输出的健壮解析。参考 Socratopia `chunks/65705:f()` 的思路，
 * 但砍到我们真正需要的档位（DeepSeek 一般稳，不做 50 轮位置探测）。
 *
 * 逐级尝试：
 *   1. 剥 <think> / markdown 围栏 → 取首个 { 到末个 }
 *   2. 直接 JSON.parse
 *   3. 常见小病修复（尾逗号、裸控制字符、中文引号）后 parse
 *   4. 括号不平衡时补齐缺失的 } 后 parse（处理被 maxTokens 截断的输出）
 *
 * 全失败返回 null，由调用方决定降级行为。
 */
export function parseLenientJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;

  const candidate = extractJsonBody(raw);
  if (!candidate) return null;

  // 尝试 1：原样
  const direct = tryParse<T>(candidate);
  if (direct !== undefined) return direct;

  // 尝试 2：修常见小病
  const repaired = repairCommonIssues(candidate);
  const afterRepair = tryParse<T>(repaired);
  if (afterRepair !== undefined) return afterRepair;

  // 尝试 3：补齐被截断的右括号
  const balanced = balanceBraces(repaired);
  if (balanced !== repaired) {
    const afterBalance = tryParse<T>(balanced);
    if (afterBalance !== undefined) return afterBalance;
  }

  return null;
}

function tryParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/** 剥 <think> / 代码围栏 / 前后解释，取首个 { 到末个 }（或 [ ... ]）。 */
function extractJsonBody(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) s = fence[1].trim();

  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  let closeCh = "}";
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    closeCh = "}";
  } else if (firstArr !== -1) {
    start = firstArr;
    closeCh = "]";
  }
  if (start === -1) return null;

  const last = s.lastIndexOf(closeCh);
  if (last > start) return s.slice(start, last + 1);
  // 没有闭合括号——保留从 start 到末尾，交给 balanceBraces 补
  return s.slice(start);
}

/** 修 LLM 常犯的小病：尾逗号、裸控制字符、中文全角引号。 */
function repairCommonIssues(s: string): string {
  let out = s;
  // 尾逗号： ,}  或  ,]
  out = out.replace(/,\s*([}\]])/g, "$1");
  // 裸控制字符（除合法空白）逐字符过滤——避免正则里嵌字面控制符
  out = stripBareControlChars(out);
  // 中文全角引号 → 英文引号
  out = out.replace(/[“”]/g, '"');
  return out;
}

/** 删掉 JSON 里不该出现的裸控制字符（保留 \t \n \r）。 */
function stripBareControlChars(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) continue;
    if (code === 0x7f) continue;
    out += s[i];
  }
  return out;
}

/** 补齐被截断的右括号：统计未闭合的 { 和 [，在末尾补上对应闭合符。 */
function balanceBraces(s: string): string {
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (const ch of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let tail = "";
  if (inStr) tail += '"'; // 字符串没闭合先补引号
  for (let i = stack.length - 1; i >= 0; i--) {
    tail += stack[i] === "{" ? "}" : "]";
  }
  return s + tail;
}
