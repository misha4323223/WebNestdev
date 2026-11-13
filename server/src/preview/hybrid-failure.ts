/**
 * Why a hybrid start failed.
 *
 * `transient` means the project may be perfectly compatible, but the environment failed:
 * network, npm registry, Docker daemon or a container address. Falling back to a dev container
 * would not repair that and would hide the real problem.
 *
 * `incompatible` means the hybrid contract did not fit this project: no static output, a backend
 * that cannot be reached directly, or a build that failed for project-specific reasons. A normal
 * container preview is the safer fallback there.
 */
export type HybridFailureKind = "transient" | "incompatible";

/** Network and dependency-install markers that must never trigger a silent mode downgrade. */
const TRANSIENT_BUILD_FAILURE =
  /\b(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_SOCKET|TS7016|ERR_MODULE_NOT_FOUND)\b|Could not find a declaration file|Cannot find module|fetch failed|socket hang up|network (?:error|request)|registry\.npmjs|npm ERR! code E(?:AI|NOTFOUND|TIMEDOUT|CONNRESET|CONNREFUSED)|(?:^|\s)(?:vite|tsc|tsx|npm|npx|yarn|pnpm): not found|sh: .*not found/i;

/** Docker/infrastructure failures also cannot be fixed by starting another preview mode. */
const TRANSIENT_START_FAILURE =
  /Docker недоступен|Cannot connect to the Docker daemon|permission denied|no such host|no such container|Контейнер предпросмотра исчез|Адрес контейнера предпросмотра|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i;

/**
 * Build output is the only evidence we have when `npm run build` exits non-zero. Network and
 * incomplete-install failures are transient; other build failures are treated as incompatible
 * so the ordinary dev preview can still be attempted.
 */
export function classifyBuildFailure(log: string): HybridFailureKind {
  return TRANSIENT_BUILD_FAILURE.test(log) ? "transient" : "incompatible";
}

/**
 * A backend container that could not start or answer is usually an architecture/runtime
 * mismatch; only Docker itself and address allocation are infrastructure failures.
 */
export function classifyStartFailure(message: string): HybridFailureKind {
  return TRANSIENT_START_FAILURE.test(message) ? "transient" : "incompatible";
}
