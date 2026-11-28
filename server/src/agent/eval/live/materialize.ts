import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertInsideSandbox } from "../../../sandbox-manager.js";
import type { EvalFixture } from "./fixtures/index.js";

/**
 * Writes a fixture into an empty project directory. The path guard is not decoration: fixtures are
 * data, and a fixture with `..` in a path must fail loudly instead of writing outside the sandbox.
 */
export async function materializeFixture(root: string, fixture: EvalFixture): Promise<string[]> {
  const written: string[] = [];
  for (const [relative, content] of Object.entries(fixture.files)) {
    const target = path.join(root, relative);
    assertInsideSandbox(root, target);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relative);
  }
  return written.sort();
}
