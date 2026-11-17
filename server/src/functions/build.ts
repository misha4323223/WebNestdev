import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build as esbuildBuild } from "esbuild";
import { scanTextForSecrets } from "../hosting/security.js";
import type { FunctionManifest, FunctionManifestEntry, FunctionManifestJob } from "./manifest.js";

/**
 * Сборка функций в один неизменяемый артефакт на функцию.
 *
 * esbuild собирает Node/TS-обработчик вместе с его зависимостями в один ESM-файл. Это даёт
 * runtime ровно один файл для монтирования read-only и убирает необходимость тащить в релиз
 * весь `node_modules` проекта. Нативные аддоны, которые нельзя собрать в JS, отклоняются
 * понятной ошибкой сборки, а не падают в момент запроса.
 *
 * Секреты в бандл не подставляются: значения env остаются в окружении исполнителя. После
 * сборки текст ещё раз проверяется на точные значения секретов проекта.
 */

export type BuiltFunction = {
  name: string;
  path: string;
  methods: FunctionManifestEntry["methods"];
  handler: string;
  /** Путь к файлу внутри каталога функции; runtime монтирует этот каталог в /workspace. */
  file: "index.mjs";
  bytes: number;
  sha256: string;
  timeoutMs: number;
  memoryMb: number;
};

/** Фоновый обработчик: тот же артефакт, но без HTTP-маршрута и методов. */
export type BuiltJob = {
  name: string;
  handler: string;
  file: "index.mjs";
  bytes: number;
  sha256: string;
  timeoutMs: number;
  memoryMb: number;
};

export type FunctionReleaseManifest = {
  version: 1;
  runtime: "node";
  functions: BuiltFunction[];
  jobs?: BuiltJob[];
  bytes: number;
};

export type BuildFunctionsInput = {
  root: string;
  outDir: string;
  manifest: FunctionManifest;
  secretValues?: string[];
  /** Предел на один собранный файл; общий размер релиза проверяет хостинг. */
  maxFunctionBytes?: number;
};

export class FunctionBuildError extends Error {
  readonly code = "FUNCTIONS_BUILD_FAILED";
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "FunctionBuildError";
  }
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function splitHandler(handler: string) {
  const [file, exportName] = handler.split("#");
  if (!file || !exportName) throw new FunctionBuildError("Обработчик должен быть вида path#export: " + handler);
  return { file, exportName };
}

async function resolveHandler(root: string, handler: string) {
  const { file, exportName } = splitHandler(handler);
  const projectRoot = await realpath(root).catch(() => path.resolve(root));
  const target = path.resolve(projectRoot, file);
  if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
    throw new FunctionBuildError("Обработчик выходит за пределы проекта: " + file);
  }
  const real = await realpath(target).catch(() => null);
  if (!real || !(real === projectRoot || real.startsWith(projectRoot + path.sep))) {
    throw new FunctionBuildError("Обработчик выходит за пределы проекта: " + file);
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new FunctionBuildError("Файл обработчика не найден: " + file);
  return { file: real, exportName };
}

function esbuildMessage(error: unknown) {
  if (error && typeof error === "object" && Array.isArray((error as { errors?: unknown[] }).errors)) {
    const messages = (error as { errors: Array<{ text?: string; location?: { file?: string; line?: number } }> }).errors
      .map(item => (item.location?.file ? item.location.file + (item.location.line ? ":" + item.location.line : "") + " — " : "") + (item.text ?? "ошибка сборки"))
      .filter(Boolean);
    if (messages.length) return messages.slice(0, 3).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function buildFunctions(input: BuildFunctionsInput): Promise<FunctionReleaseManifest> {
  if (input.manifest.runtime !== "node") {
    throw new FunctionBuildError("Python-функции пока не поддерживаются: используйте runtime \"node\"");
  }
  const maxFunctionBytes = input.maxFunctionBytes ?? 10 * 1024 * 1024;
  await mkdir(input.outDir, { recursive: true, mode: 0o755 });
  const built: BuiltFunction[] = [];
  const builtJobs: BuiltJob[] = [];
  let total = 0;

  async function buildHandler(
    entry: FunctionManifestEntry | FunctionManifestJob,
    label: string,
  ): Promise<{ bytes: number; sha256: string }> {
    const handler = await resolveHandler(input.root, entry.handler);
    const functionDir = path.join(input.outDir, entry.name);
    const outfile = path.join(functionDir, "index.mjs");
    await mkdir(functionDir, { recursive: true, mode: 0o755 });

    try {
      await esbuildBuild({
        entryPoints: [handler.file],
        outfile,
        absWorkingDir: input.root,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        sourcemap: false,
        minify: false,
        legalComments: "none",
        logLevel: "silent",
        // Нативный мост pg не является обязательным; без него pg работает на чистом JS.
        external: ["pg-native"],
      });
    } catch (error) {
      throw new FunctionBuildError("Не удалось собрать " + label + " «" + entry.name + "»: " + esbuildMessage(error));
    }

    const output = await readFile(outfile).catch(() => null);
    if (!output || output.byteLength === 0) {
      throw new FunctionBuildError("Сборка " + label + " «" + entry.name + "» создала пустой файл");
    }
    if (output.byteLength > maxFunctionBytes) {
      throw new FunctionBuildError(
        (label === "функции" ? "Функция" : "Задание") + " «" + entry.name + "» больше " +
          Math.round(maxFunctionBytes / 1024 / 1024) + " МиБ",
      );
    }
    const text = output.includes(0) ? "" : output.toString("utf8");
    if (text) {
      const findings = scanTextForSecrets(text, input.secretValues ?? [], entry.name + "/index.mjs");
      if (findings.length) {
        throw new FunctionBuildError(
          "В собранной " + label + " «" + entry.name + "» найдены данные, похожие на секрет: " + findings[0]!.kind,
        );
      }
    }
    total += output.byteLength;
    return { bytes: output.byteLength, sha256: sha256(output) };
  }

  for (const entry of input.manifest.functions) {
    const output = await buildHandler(entry, "функции");
    built.push({
      name: entry.name,
      path: entry.path,
      methods: entry.methods,
      handler: input.manifest.runtime + ":" + entry.handler,
      file: "index.mjs",
      bytes: output.bytes,
      sha256: output.sha256,
      timeoutMs: entry.timeoutMs,
      memoryMb: entry.memoryMb,
    });
  }

  for (const entry of input.manifest.jobs) {
    const output = await buildHandler(entry, "задания");
    builtJobs.push({
      name: entry.name,
      handler: input.manifest.runtime + ":" + entry.handler,
      file: "index.mjs",
      bytes: output.bytes,
      sha256: output.sha256,
      timeoutMs: entry.timeoutMs,
      memoryMb: entry.memoryMb,
    });
  }

  const manifest: FunctionReleaseManifest = {
    version: 1,
    runtime: "node",
    functions: built,
    jobs: builtJobs,
    bytes: total,
  };
  await writeFile(path.join(input.outDir, "manifest.json"), JSON.stringify(manifest, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return manifest;
}
