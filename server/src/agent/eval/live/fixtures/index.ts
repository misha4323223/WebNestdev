/**
 * Fixture registry for the live eval adapter.
 *
 * The catalog in `../tasks.ts` names repositories as `eval://<name>`; this module is the only place
 * that knows what those names contain. Tasks whose repository has no fixture are not run by the
 * live adapter and are reported as missing coverage instead of silently passing.
 */
import { EVAL_TASKS } from "../../tasks.js";
import type { EvalTask } from "../../types.js";
import { LANDING_FIXTURES } from "./landing.js";
import { MVP_FIXTURES } from "./mvp.js";
import { LARGE_FIXTURES } from "./large.js";
import type { EvalFixture } from "./types.js";

export type { EvalFixture } from "./types.js";

export const EVAL_FIXTURES: Record<string, EvalFixture> = {
  ...LANDING_FIXTURES,
  ...MVP_FIXTURES,
  ...LARGE_FIXTURES,
};

/** `eval://landing-basic` → `landing-basic`; anything else is not ours. */
export function fixtureName(repo: string | undefined): string | null {
  if (!repo) return null;
  const match = /^eval:\/\/([a-z0-9-]+)$/i.exec(repo.trim());
  return match ? match[1] : null;
}

export function fixtureForRepo(repo: string | undefined): EvalFixture | null {
  const name = fixtureName(repo);
  return name ? EVAL_FIXTURES[name] ?? null : null;
}

/** Tasks the live adapter can actually run, in catalog order. */
export function tasksWithFixtures(tasks: EvalTask[] = EVAL_TASKS): EvalTask[] {
  return tasks.filter(task => fixtureForRepo(task.repo) !== null);
}

/** Tasks that belong to the catalog but have no repository yet — reported, never hidden. */
export function tasksWithoutFixtures(tasks: EvalTask[] = EVAL_TASKS): EvalTask[] {
  return tasks.filter(task => fixtureForRepo(task.repo) === null);
}

/**
 * Problems that make a fixture unusable. Paths are checked rather than trusted: a fixture is
 * written into a real project directory, so `..` or an absolute path would escape it.
 */
export function fixtureProblems(fixtures: Record<string, EvalFixture> = EVAL_FIXTURES): string[] {
  const problems: string[] = [];
  for (const [name, fixture] of Object.entries(fixtures)) {
    const files = Object.entries(fixture.files);
    if (!files.length) problems.push(name + ": пустая фикстура");
    if (!fixture.files["package.json"]) problems.push(name + ": нет package.json (проверки не запустятся)");
    for (const [file, source] of files) {
      if (!file.trim()) problems.push(name + ": пустой путь файла");
      if (file.startsWith("/") || file.split("/").includes("..")) {
        problems.push(name + ": путь выходит за пределы проекта: " + file);
      }
      if (!source.trim()) problems.push(name + ": пустой файл " + file);
    }
  }
  return problems;
}
