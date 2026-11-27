import { readdir } from "node:fs/promises";
import path from "node:path";
import { inspectExpoProject, type ExpoProject } from "./expo-api.js";

/**
 * Где в проекте лежит Expo-приложение.
 *
 * Корень проекта часто занят обычным веб-приложением, а мобильное живёт в подкаталоге
 * (`admin-app`, `mobile`, `apps/app`). Набор инструментов запуска собирался по корню, поэтому
 * `expo.build` в такой проект не попадал вовсе — и модель искала «способ создать сборку» в
 * HTTP-инструменте, где его нет. Поиск на два уровня ниже корня закрывает этот случай.
 */

/** Каталоги, внутри которых Expo-приложения не бывает: зависимости, артефакты, нативная сборка. */
const SKIP_DIRECTORIES = new Set([
  "node_modules", "vendor", "dist", "build", "out", "coverage",
  "ios", "android", "Pods", ".expo", ".webnestdev",
]);

/** Потолок обхода: большой монорепозиторий не должен превращать старт запуска в обход диска. */
const MAX_SCAN_DIRECTORIES = 200;

/**
 * Относительные пути Expo-приложений, начиная с корня (`""` — корень проекта).
 *
 * Найденное приложение не просматривается дальше: вложенный Expo-проект внутри Expo-проекта —
 * это уже другой случай, и выбирать из него автоматически нечего.
 */
export async function findExpoApps(root: string, maxDepth = 2): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;

  const walk = async (relative: string, depth: number): Promise<void> => {
    if (visited >= MAX_SCAN_DIRECTORIES) return;
    visited++;
    const project = await inspectExpoProject(root, relative).catch(() => null);
    if (project?.isExpo) {
      found.push(relative);
      return;
    }
    if (depth >= maxDepth) return;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= MAX_SCAN_DIRECTORIES) return;
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(relative, entry.name), depth + 1);
    }
  };

  await walk("", 0);
  return found;
}

export type ExpoAppLocation =
  | { ok: true; cwd: string; project: ExpoProject; auto: boolean }
  | { ok: false; problem: string; candidates: string[] };

const NOT_AN_EXPO_APP =
  "В проекте нет приложения Expo: искал package.json с зависимостью expo и app.json/app.config.* в корне и на два уровня ниже.";

/**
 * Каталог, с которым должны работать `expo.*`.
 *
 * Явный `cwd` не переопределяется: если человек или модель назвали каталог, ответ должен быть про
 * него, а не про найденный рядом. Без `cwd` единственное приложение подставляется само, а при
 * нескольких — возвращается список, чтобы модель спросила, а не выбрала наугад.
 */
export async function locateExpoApp(root: string, cwd = ""): Promise<ExpoAppLocation> {
  if (cwd) {
    const project = await inspectExpoProject(root, cwd);
    if (project.isExpo) return { ok: true, cwd, project, auto: false };
    return {
      ok: false,
      problem: "В каталоге «" + cwd + "» нет проекта Expo. Нужен package.json с зависимостью expo и app.json/app.config.*.",
      candidates: [],
    };
  }

  const project = await inspectExpoProject(root, "");
  if (project.isExpo) return { ok: true, cwd: "", project, auto: false };

  const apps = await findExpoApps(root);
  if (apps.length === 1) {
    const only = apps[0];
    return { ok: true, cwd: only, project: await inspectExpoProject(root, only), auto: true };
  }
  if (apps.length > 1) {
    return {
      ok: false,
      problem:
        "Expo-приложений в проекте несколько: " + apps.join(", ") + ". Передайте cwd с каталогом нужного приложения.",
      candidates: apps,
    };
  }
  return { ok: false, problem: NOT_AN_EXPO_APP, candidates: [] };
}
