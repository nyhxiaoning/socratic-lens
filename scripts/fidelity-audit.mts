/**
 * Fidelity 审计 CLI（薄壳，逻辑全在 lib/fidelity.ts）。
 *
 * 用法：
 *   node --import tsx scripts/fidelity-audit.ts <sample-name>
 * 读 data/fidelity-samples/<name>/{source.md, synth.md}，出勾稽报告落盘。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runFidelity } from "../lib/fidelity";

const [, , sampleName] = process.argv;
if (!sampleName) {
  console.error("用法: node --import tsx scripts/fidelity-audit.ts <sample-name>");
  process.exit(1);
}

const CWD = process.cwd();
const sampleDir = path.join(CWD, "data", "fidelity-samples", sampleName);
const sourcePath = path.join(sampleDir, "source.md");
const synthPath = path.join(sampleDir, "synth.md");

async function readOrDie(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    console.error(`找不到文件：${p}`);
    process.exit(1);
  }
}

if (!process.env.LLM_AUDIT_BASE_URL) {
  console.warn(
    "\n⚠️  未配置独立审计端点（LLM_AUDIT_BASE_URL），正在用与生成器同源的模型自审——\n" +
      "   按交接文档 §2，同源自审的「通过」可信度存疑。出真结论前请配 LLM_AUDIT_* 换独立厂/端点。\n",
  );
}

const sourceText = await readOrDie(sourcePath);
const synthText = await readOrDie(synthPath);

console.log(`\n开始 Fidelity 审计：${sampleName}`);
console.log(`  源材料 ${sourceText.length} 字 · 合成节 ${synthText.length} 字\n`);

const ctrl = new AbortController();
try {
  const res = await runFidelity(sourceText, synthText, ctrl.signal, { sampleName });
  const c = res.coverage;
  console.log(`审计完成 fid=${res.fid}`);
  console.log(
    `  覆盖率：落地 ${c.landed}/${c.total}（${Math.round(c.coverageRate * 100)}%）· 变形 ${c.morphed} · 漏 ${c.dropped}`,
  );
  console.log(`  总评：${res.verdict}`);
  console.log(`\n产物目录：${res.dir}`);
  console.log(`  - checklist.json（源清单，请扫一眼验对不对）`);
  console.log(`  - report.md（勾稽报告）`);
} catch (err) {
  console.error(`\n审计失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
