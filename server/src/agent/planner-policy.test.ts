import test from "node:test";
import assert from "node:assert/strict";
import { changesSomething } from "../agent-runtime.js";

/** Planner mode must be read-only by construction, not only by instruction. */
test("every tool that writes is refused in planner mode", () => {
  for (const name of ["fs.write", "fs.edit", "fs.rename", "fs.delete", "npm.install", "pip.install", "net.download", "git.add", "git.commit", "git.pull", "database.env", "secrets.request", "preview.start", "preview.stop", "image.generate"]) {
    assert.equal(changesSomething(name, {}), true, name + " must be refused");
  }
});

test("reading the project stays possible", () => {
  for (const name of ["fs.list", "fs.read", "git.status", "git.diff", "git.log", "project.verify", "browser.runtime", "browser.scenario", "plan.update", "database.status"]) {
    assert.equal(changesSomething(name, {}), false, name + " must be allowed");
  }
});

test("terminal.exec is allowed only for inspection commands", () => {
  for (const command of ["ls -la", "cat src/index.ts", "grep -rn provider src", "grep -o provider src/app.ts", "git status --short", "git diff", "git log --oneline -5", "git branch --list", "git tag -l", "git remote -v", "git config --get user.name", "git stash list", "npm ls", "find . -name '*.ts'"]) {
    assert.equal(changesSomething("terminal.exec", { command }), false, command + " must be allowed");
  }
  for (const command of [
    "npm install",
    "npm run build",
    "rm -rf src",
    "echo hacked > src/index.ts",
    "cat a.ts | tee b.ts",
    "git commit -m wip",
    "git add -A",
    "git pull",
    "git fetch origin",
    "cat src/index.ts && rm src/index.ts",
    "mv src/a.ts src/b.ts",
    "python -c 'open(\"a\",\"w\")'",
    "curl https://example.com",
    "find . -delete",
    "find . -exec rm {} \\;",
    "git branch -D main",
    "git tag -d v1",
    "git config user.name x",
    "git remote add origin https://example.com/x.git",
    "git stash push",
    "git diff --output=patch.txt",
    "sort -o sorted.txt src/app.ts",
    "grep --pre 'cat' pattern src",
    "cat src/index.ts\nrm -rf src",
  ]) {
    assert.equal(changesSomething("terminal.exec", { command }), true, command + " must be refused");
  }
});

test("net.request may read an API but not change it in planner mode", () => {
  assert.equal(changesSomething("net.request", { method: "GET", url: "https://example.com" }), false);
  assert.equal(changesSomething("net.request", { method: "HEAD", url: "https://example.com" }), false);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(changesSomething("net.request", { method, url: "https://example.com" }), true, method + " must be refused");
  }
});

test("yandex.request reads but never writes the external account", () => {
  assert.equal(changesSomething("yandex.request", { method: "GET", path: "/x" }), false);
  assert.equal(changesSomething("yandex.request", { method: "HEAD", path: "/x" }), false);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.equal(changesSomething("yandex.request", { method, path: "/x" }), true, method + " must be refused");
  }
});
