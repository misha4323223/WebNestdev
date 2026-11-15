import { createHash } from "node:crypto";
import path from "node:path";
import { readFileInside, writeFileInside } from "../../sandbox/path-guard.js";
import { scanTextForSecrets } from "../../hosting/security.js";
import { unifiedPatch } from "../../changes/diff.js";
import { MEMORY_FILES, type MemoryFileName } from "./read.js";

/**
 * Memory writes are a compare-and-swap, not a blind replace:
 *   diff → show the patch and hashes → write with expectedHash.
 * The path is a fixed whitelist, the content is scanned for credentials, and the write is refused
 * if the document changed after the diff was shown.
 */
const MAX_CONTENT_CHARS = 24_000;
const SHA256 = /^[a-f0-9]{64}$/;

export type MemoryPreview = {
  path: MemoryFileName;
  exists: boolean;
  currentHash: string;
  nextHash: string;
  patch: string;
  truncated: boolean;
  changed: boolean;
};

export type MemoryWriteResult = MemoryPreview & { bytes: number };

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function memoryPath(name: string): MemoryFileName {
  if (!(MEMORY_FILES as readonly string[]).includes(name)) {
    throw new Error("Можно обновлять только " + MEMORY_FILES.join(", ") + "; файл «" + name + "» не входит в память.");
  }
  return name as MemoryFileName;
}

function validateContent(name: MemoryFileName, content: string) {
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(name + ": максимум " + MAX_CONTENT_CHARS + " символов, получено " + content.length + ". Сократите документ.");
  }
  const findings = scanTextForSecrets(content, [], name);
  if (findings.length) {
    throw new Error(name + ": в документе найден секрет (" + findings.map(item => item.kind).join(", ") + "). Память не может содержать ключи и значения секретов.");
  }
}

async function readCurrent(root: string, name: MemoryFileName) {
  try {
    const content = await readFileInside(root, path.join(root, name));
    return { content, hash: sha256(content), exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", hash: sha256(""), exists: false };
    }
    throw error;
  }
}

export async function previewMemoryChange(root: string, name: string, content: string): Promise<MemoryPreview> {
  const safeName = memoryPath(name);
  validateContent(safeName, content);
  const current = await readCurrent(root, safeName);
  const patch = unifiedPatch(safeName, current.content, content);
  return {
    path: safeName,
    exists: current.exists,
    currentHash: current.hash,
    nextHash: sha256(content),
    patch: patch.patch,
    truncated: patch.truncated,
    changed: current.content !== content,
  };
}

export async function writeMemoryFile(
  root: string,
  name: string,
  content: string,
  expectedHash: string,
): Promise<MemoryWriteResult> {
  if (!SHA256.test(expectedHash)) throw new Error("expectedHash должен быть sha256 в hex");
  const preview = await previewMemoryChange(root, name, content);
  if (preview.truncated) throw new Error("diff слишком большой для проверки; сократите документ");
  if (!preview.changed) {
    return { ...preview, bytes: Buffer.byteLength(content, "utf8") };
  }
  if (preview.currentHash !== expectedHash) {
    throw new Error("Файл изменился после diff: ожидался " + expectedHash.slice(0, 12) + "…, сейчас " + preview.currentHash.slice(0, 12) + "…. Сделайте diff заново и подтвердите запись.");
  }
  // Narrow the race between the preview and the write. There is still no filesystem transaction,
  // but a document changed by another writer between these two reads is refused, not overwritten.
  const immediatelyBefore = await readCurrent(root, preview.path);
  if (immediatelyBefore.hash !== expectedHash) {
    throw new Error("Файл изменился между проверкой и записью; сделайте diff заново.");
  }
  await writeFileInside(root, path.join(root, preview.path), content);
  return { ...preview, bytes: Buffer.byteLength(content, "utf8") };
}
