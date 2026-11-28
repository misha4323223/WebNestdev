import assert from "node:assert/strict";
import test from "node:test";
import { getTool, toolNames } from "../tool-registry.js";
import "./register.js";

test("регистрация даёт полный каталог инструментов", () => {
  assert.ok(toolNames().length >= 50, "инструментов слишком мало: " + toolNames().length);
  for (const name of ["fs.read", "fs.write", "terminal.exec", "seo.check", "database.status", "project.verify"]) {
    assert.ok(getTool(name), "нет инструмента " + name);
  }
});

test("у каждого инструмента есть описание", () => {
  for (const name of toolNames()) {
    assert.ok(getTool(name)?.description?.trim(), "у " + name + " нет описания");
  }
});
