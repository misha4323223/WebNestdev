import type { RepoIndex } from "../repo-index/types.js";

/**
 * A skeleton is deliberately generated from metadata only. It gives the project a place for
 * decisions and invariants without inventing architecture the code does not show; every section
 * that needs human judgement starts as a short TODO.
 */
export function architectureSkeleton(index: RepoIndex): string {
  const packages = index.packages.length
    ? index.packages
        .slice(0, 40)
        .map(pkg => "- `" + pkg.name + "` — `" + (pkg.dir || ".") + "`" + (pkg.entry ? ", entry `" + pkg.entry + "`" : ""))
        .join("\n")
    : "- (пакеты не обнаружены)";
  const entryPoints = index.entryPoints.length
    ? index.entryPoints.slice(0, 20).map(item => "- `" + item + "`").join("\n")
    : "- (точки входа не обнаружены)";
  const tests = index.tests.length
    ? index.tests.slice(0, 30).map(item => "- `" + item + "`").join("\n") + (index.tests.length > 30 ? "\n- … ещё " + (index.tests.length - 30) : "")
    : "- (тесты не обнаружены)";

  return [
    "# Architecture",
    "",
    "> Generated from the repository index; review before using it as a contract.",
    "> Index fingerprint: `" + index.fingerprint + "`; files: " + index.stats.files + ".",
    "",
    "## Modules and packages",
    "",
    packages,
    "",
    "## Entry points",
    "",
    entryPoints,
    "",
    "## Boundaries",
    "",
    "- TODO: какие модули могут зависеть друг от друга, а какие обязаны оставаться изолированными.",
    "- TODO: где заканчивается доверенная зона и начинаются внешние данные.",
    "",
    "## Data flows",
    "",
    "- TODO: путь запроса/события от входа до хранения и обратно.",
    "- TODO: какие данные считаются пользовательскими, а какие служебными.",
    "",
    "## Invariants",
    "",
    "- TODO: что нельзя нарушать даже при рефакторинге.",
    "- TODO: какие проверки подтверждают каждый инвариант.",
    "",
    "## Tests",
    "",
    tests,
  ].join("\n");
}
