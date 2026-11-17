import { readFile } from "node:fs/promises";
import type { FunctionReleaseManifest } from "./build.js";

/** Читает `manifest.json` релиза. Битый или чужой файл — это null, а не падение двери. */
export async function readReleaseManifest(file: string): Promise<FunctionReleaseManifest | null> {
  const text = await readFile(file, "utf8").catch(() => "");
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as FunctionReleaseManifest;
    return parsed?.version === 1 && Array.isArray(parsed.functions) ? parsed : null;
  } catch {
    return null;
  }
}
