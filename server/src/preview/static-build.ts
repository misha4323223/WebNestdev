import type { SandboxConfig } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import type { DockerCommandResult } from "../sandbox/docker/types.js";

/** One build's output is the whole log; the panel shows it instead of dev-server output. */
export const MAX_STATIC_BUILD_LOG_CHARS = 8000;
export const DEFAULT_STATIC_BUILD_SCRIPT = "build";

/** The build command as it appears in the panel and in the container. */
export function staticBuildCommand(script = DEFAULT_STATIC_BUILD_SCRIPT) {
  return "npm run " + script;
}

export async function runStaticBuild(config: SandboxConfig, script = DEFAULT_STATIC_BUILD_SCRIPT): Promise<DockerCommandResult | { reason: string }> {
  try {
    // The build needs the same env files as the dev server: they are mounted from encrypted
    // storage only for this command and removed immediately afterwards.
    return await runInSandbox(config, staticBuildCommand(script), config.root, { injectSecretEnvFile: true });
  } catch (error) {
    return { reason: "сборка не запустилась: " + (error instanceof Error ? error.message : String(error)) };
  }
}

/** The tail of the build output plus the failure line: enough to fix the project from the log. */
export function staticBuildLog(result: DockerCommandResult, script = DEFAULT_STATIC_BUILD_SCRIPT) {
  const output = [result.stdout, result.stderr].map(value => value.replace(/\r/g, "").trim()).filter(Boolean).join("\n");
  const head = "$ " + staticBuildCommand(script) + (result.ok ? "" : failureLine(result));
  const body = output.length > MAX_STATIC_BUILD_LOG_CHARS ? output.slice(-MAX_STATIC_BUILD_LOG_CHARS) : output;
  return body ? head + "\n" + body : head;
}

function failureLine(result: DockerCommandResult) {
  const failed = result.stderr.split("\n").map(line => line.trim()).filter(Boolean).at(-1);
  return " → " + (failed ?? ("код выхода " + result.exitCode));
}
