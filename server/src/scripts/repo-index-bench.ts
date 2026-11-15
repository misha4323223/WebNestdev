/**
 * Synthetic benchmark for the repository index.
 *
 * It creates a throwaway project with a requested number of files and lines, measures a cold
 * build, a disk-cache hit and an incremental rebuild after one edit, then removes the project.
 * The benchmark is deliberately not part of `npm test`: it answers the stage 1 gate, not every
 * unit run.
 *
 * Пример:
 *   npm run agent:index-bench --workspace=server -- --files 1000 --lines 100
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepoIndex } from "../agent/repo-index/build.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const number = (name: string, fallback: number) => {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(name + " должен быть положительным целым");
  }
  return value;
};

const fileCount = number("--files", 1000);
const linesPerFile = number("--lines", 100);
const keep = args.includes("--keep");
const root = await mkdtemp(path.join(tmpdir(), "wnd-index-bench-"));

async function seed() {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "index-bench", private: true }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  for (let file = 0; file < fileCount; file++) {
    const lines = [
      ...(file > 0 ? ['import { value_' + (file - 1) + '_0 } from "./file' + (file - 1) + '";'] : []),
      "export type Row" + file + " = { id: number; name: string };",
    ];
    for (let line = 0; line < Math.max(1, linesPerFile - 2); line++) {
      lines.push("export const value_" + file + "_" + line + " = " + line + ";");
    }
    await writeFile(path.join(root, "src", "file" + file + ".ts"), lines.join("\n") + "\n");
  }
}

function ms(value: number) {
  return Math.round(value);
}

await seed();
try {
  const coldStart = performance.now();
  const cold = await buildRepoIndex(root, { useDiskCache: false, refresh: true });
  const coldMs = performance.now() - coldStart;

  const cacheStart = performance.now();
  const cached = await buildRepoIndex(root, { useDiskCache: true });
  const cacheMs = performance.now() - cacheStart;

  const changed = path.join(root, "src", "file0.ts");
  await writeFile(changed, (await readFile(changed, "utf8")) + "export const changed = true;\n");
  const incrementalStart = performance.now();
  const incremental = await buildRepoIndex(root, { useDiskCache: true });
  const incrementalMs = performance.now() - incrementalStart;

  console.log("REPO-INDEX-BENCH files=" + cold.files.length + " loc=" + (fileCount * linesPerFile));
  console.log("  cold=" + ms(coldMs) + "ms cache=" + ms(cacheMs) + "ms incremental=" + ms(incrementalMs) + "ms");
  console.log("  fingerprints: cold=" + cold.fingerprint.slice(0, 12) + " cached=" + cached.fingerprint.slice(0, 12) + " incremental=" + incremental.fingerprint.slice(0, 12));
  const ok = coldMs < 60_000 && cacheMs < 5_000 && incrementalMs < 5_000;
  console.log("REPO-INDEX-GATE=" + (ok ? "ok" : "slow"));
  if (!ok) process.exitCode = 1;
} finally {
  if (!keep) await rm(root, { recursive: true, force: true });
}
