import test from "node:test";
import assert from "node:assert/strict";
import { commandMemoryClass, commandMemoryMb } from "./command-memory.js";

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("дешёвые команды получают лёгкий класс", () => {
  for (const command of [
    "ls",
    "ls -la",
    "pwd",
    "cat package.json",
    "git status --short",
    "git diff HEAD -- src/main.ts",
    "git log --oneline -20",
    "grep -rn TODO src",
    "rg \"useEffect\" src",
    "wc -l src/index.ts",
    "head -n 50 README.md",
    "test -f package.json && echo yes",
    "FOO=1 ls -la",
    "/usr/bin/ls -la",
  ]) {
    assert.equal(commandMemoryClass(command), "light", "ожидался лёгкий класс: " + command);
  }
});

test("сборки, установки и всё неизвестное остаются с обычным потолком", () => {
  for (const command of [
    "npm install",
    "npm run build",
    "npx tsc --noEmit",
    "node -e \"console.log(1)\"",
    "vite build",
    "next build",
    "./scripts/build.sh",
    "make -j4",
    "git clone https://example.com/repo.git",
    "git checkout -b feature",
    "sort -h big.log",
    "jq '.dependencies' package.json",
    "echo hi > out.txt",
  ]) {
    assert.equal(commandMemoryClass(command), "normal", "ожидался обычный класс: " + command);
  }
});

test("составная команда считается по самому тяжёлому куску", () => {
  assert.equal(commandMemoryClass("ls && npm test"), "normal");
  assert.equal(commandMemoryClass("cat package.json | grep name"), "light", "труба из дешёвых команд остаётся дешёвой");
  assert.equal(commandMemoryClass("ls; git status"), "light");
  assert.equal(commandMemoryClass("ls; ./unknown-binary"), "normal", "один неизвестный кусок отменяет лёгкий класс");
});

test("пустая команда — обычный класс, а не лёгкий по умолчанию", () => {
  assert.equal(commandMemoryClass(""), "normal");
  assert.equal(commandMemoryClass("   "), "normal");
});

test("лёгкий класс урезает потолок, но не выше базового и не ниже минимума", () => {
  withEnv({ SANDBOX_MEMORY: undefined, SANDBOX_MEMORY_LIGHT_MB: undefined, SANDBOX_COMMAND_MEMORY_CLASS: undefined }, () => {
    assert.equal(commandMemoryMb("ls -la", 1024), 256, "по умолчанию лёгкая команда получает 256 МБ");
    assert.equal(commandMemoryMb("ls -la", 512), 256);
    assert.equal(commandMemoryMb("ls -la", 128), 128, "потолок не поднимается выше базового");
    assert.equal(commandMemoryMb("npm run build", 1024), 1024, "сборка сохраняет обычный потолок");
  });
});

test("лёгкий потолок настраивается и не опускается ниже разумного минимума", () => {
  withEnv({ SANDBOX_MEMORY: undefined, SANDBOX_COMMAND_MEMORY_CLASS: undefined, SANDBOX_MEMORY_LIGHT_MB: "384" }, () => {
    assert.equal(commandMemoryMb("ls", 1024), 384);
  });
  withEnv({ SANDBOX_MEMORY: undefined, SANDBOX_COMMAND_MEMORY_CLASS: undefined, SANDBOX_MEMORY_LIGHT_MB: "8" }, () => {
    assert.equal(commandMemoryMb("ls", 1024), 64, "слишком маленькое значение не принимается");
  });
});

test("общий потолок из SANDBOX_MEMORY отключает деление: админ задал одно число", () => {
  withEnv({ SANDBOX_MEMORY: "1024m", SANDBOX_COMMAND_MEMORY_CLASS: undefined }, () => {
    assert.equal(commandMemoryMb("ls -la", 1024), 1024);
  });
});

test("деление можно выключить переменной окружения", () => {
  withEnv({ SANDBOX_MEMORY: undefined, SANDBOX_COMMAND_MEMORY_CLASS: "0" }, () => {
    assert.equal(commandMemoryClass("ls -la"), "normal");
    assert.equal(commandMemoryMb("ls -la", 1024), 1024);
  });
});
