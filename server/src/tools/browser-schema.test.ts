import test from "node:test";
import assert from "node:assert/strict";
import "./browser-tools.js";
import { getTool } from "../tool-registry.js";

/**
 * `browser.open` и `browser.inspect` читают `input.path`, но схемы не объявляли: модель видела
 * инструмент без параметров и проверяла только главную. Тест фиксирует, что путь виден модели.
 */
for (const name of ["browser.open", "browser.inspect"]) {
  test(name + " объявляет path в схеме", () => {
    const tool = getTool(name);
    assert.ok(tool, "инструмент зарегистрирован");
    const schema = tool.parameters as {
      type?: string;
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    } | undefined;
    assert.equal(schema?.type, "object");
    assert.equal(schema?.additionalProperties, false);
    assert.ok(schema?.properties?.path, "path виден модели");
    assert.match(tool.description, /Input: \{path\?:string\}/);
  });
}
