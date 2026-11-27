import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Если описание говорит «Input: {…}», у инструмента должна быть схема. Иначе модель видит
 * инструмент без параметров и либо не передаёт нужное поле, либо угадывает его имя — оба варианта
 * стоят шага. Схемой считается и объект `parameters: {…}`, и константа (`PLAN_UPDATE_PARAMETERS`).
 */
const dir = path.dirname(fileURLToPath(import.meta.url));

function blocks(text: string) {
  const result: string[] = [];
  let at = 0;
  while ((at = text.indexOf("registerTool({", at)) !== -1) {
    let index = at + "registerTool(".length;
    let depth = 0;
    for (; index < text.length; index++) {
      const char = text[index];
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          index++;
          break;
        }
      }
    }
    result.push(text.slice(at, index));
    at = index;
  }
  return result;
}

test("каждый инструмент, обещающий Input:, объявляет схему параметров", async () => {
  const files = (await readdir(dir)).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const missing: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    for (const block of blocks(text)) {
      const name = block.match(/name:\s*"([^"]+)"/)?.[1] ?? file;
      if (!/Input:/.test(block)) continue;
      if (!/parameters:\s*(\{|[A-Za-z_$][\w$]*)/.test(block)) missing.push(name);
    }
  }
  assert.deepEqual(missing, [], "без схемы остались: " + missing.join(", "));
});
