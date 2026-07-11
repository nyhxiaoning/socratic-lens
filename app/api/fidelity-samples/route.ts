import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAMPLES_ROOT = path.join(process.cwd(), "data", "fidelity-samples");

/** GET /api/fidelity-samples → 列出所有可用 Fidelity 审计样本。 */
export async function GET() {
  try {
    const entries = await fs.readdir(SAMPLES_ROOT, { withFileTypes: true });
    const samples: { name: string; hasSource: boolean; hasSynth: boolean }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(SAMPLES_ROOT, e.name);
      const files = await fs.readdir(dir);
      samples.push({
        name: e.name,
        hasSource: files.includes("source.md"),
        hasSynth: files.includes("synth.md"),
      });
    }
    return NextResponse.json({ samples });
  } catch {
    return NextResponse.json({ samples: [] });
  }
}
