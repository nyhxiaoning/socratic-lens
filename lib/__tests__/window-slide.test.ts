import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate, locateQuotePages, type Page } from "../pagination";
import {
  assignPages,
  windowCoveredRatio,
  type CoverageItem,
} from "../coverage-tracker";

/** 造一个知识点覆盖项。 */
function item(id: string, sourceQuote: string, status: "uncovered" | "covered" = "uncovered"): CoverageItem {
  return { id, category: "knowledgePoint", name: id, sourceQuote, status };
}

test("locateQuotePages: 命中的引文归到对应页，重复出现归多页", () => {
  const pages: Page[] = [
    { page: 1, chars: 10, text: "第一页讲一般现在时的用法" },
    { page: 2, chars: 10, text: "第二页讲名词复数规则" },
    { page: 3, chars: 10, text: "第三页复习一般现在时并总结" },
  ];
  // 只在第 2 页出现
  assert.deepEqual(locateQuotePages(pages, "名词复数"), [2]);
  // 在第 1、3 页都出现（前后呼应）→ 归两页
  assert.deepEqual(locateQuotePages(pages, "一般现在时"), [1, 3]);
  // 正文里根本没有 → 空数组（无法定位）
  assert.deepEqual(locateQuotePages(pages, "虚拟语气条件句"), []);
});

test("assignPages: 给每个 item 填 pages", () => {
  const pages: Page[] = [
    { page: 1, chars: 10, text: "苹果和香蕉" },
    { page: 2, chars: 10, text: "橙子和西瓜" },
  ];
  const items = [item("a", "香蕉"), item("b", "西瓜"), item("c", "找不到的东西")];
  const assigned = assignPages(items, pages);
  assert.deepEqual(assigned[0].pages, [1]);
  assert.deepEqual(assigned[1].pages, [2]);
  assert.deepEqual(assigned[2].pages, []);
});

test("windowCoveredRatio: 只统计窗口内已定位项，重复讲不改变已 covered 占比", () => {
  const items: CoverageItem[] = [
    { ...item("a", "x", "covered"), pages: [1] },
    { ...item("b", "y", "uncovered"), pages: [1] },
    { ...item("c", "z", "covered"), pages: [2] }, // 窗口外
    { ...item("d", "w", "uncovered"), pages: [] }, // 无法定位
  ];
  const r = windowCoveredRatio(items, 1, 1);
  assert.equal(r.locatable, 2); // a、b 在窗口内且已定位；c 窗口外、d 未定位都排除
  assert.equal(r.covered, 1); // 只有 a
  assert.equal(r.ratio, 0.5);
});

test("windowCoveredRatio: 窗口内无可定位项时 ratio=0、locatable=0（触发降级）", () => {
  const items: CoverageItem[] = [{ ...item("a", "x", "covered"), pages: [] }];
  const r = windowCoveredRatio(items, 1, 3);
  assert.equal(r.locatable, 0);
  assert.equal(r.ratio, 0);
});

test("paginate + locateQuotePages 端到端：长文本切页后能定位", () => {
  const para = (n: number) => `这是第${n}段内容，`.repeat(120); // 每段够长，逼出多页
  const text = [para(1), para(2), para(3), para(4)].join("\n\n");
  const pages = paginate(text);
  assert.ok(pages.length >= 2, "长文本应被切成多页");
  const hits = locateQuotePages(pages, "这是第1段内容");
  assert.ok(hits.length >= 1 && hits[0] === 1, "第1段应归到第1页");
});
