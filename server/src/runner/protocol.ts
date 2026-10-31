import { z } from "zod";

/**
 * The wire contract between the API and an execution runner.
 *
 * Keep this file free of storage, auth stores and platform keys: the runner imports it, and a
 * runner must never be able to read the platform database or payment secrets. Everything the API
 * sends is a project-scoped command, a container operation from the preview/job code, or a preview
 * relay request; a runner does not accept arbitrary shell commands outside its sandbox.
 */
export const runnerRunOptionsSchema = z.object({
  network: z.enum(["none", "bridge"]).optional(),
  env: z.record(z.string().min(1).max(256), z.string().max(16_384)).optional(),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000).optional(),
  maskSecretEnvFiles: z.boolean().optional(),
  injectSecretEnvFile: z.boolean().optional(),
  extraMounts: z.array(z.string().max(8_192)).max(300).optional(),
}).strict();

export const runnerCommandSchema = z.object({
  // A project id becomes a path segment on the runner. `..` or a slash must never reach
  // `sandboxRootPath`, even if the bearer token leaks.
  projectId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Недопустимый id проекта"),
  command: z.string().min(1).max(120_000),
  /** Relative to the project workspace; the runner joins it to its own shared root. */
  cwd: z.string().max(4_096).default(""),
  options: runnerRunOptionsSchema.optional(),
}).strict();

export const runnerDockerSchema = z.object({
  args: z.array(z.string().max(40_000_000)).min(1).max(512),
  timeoutMs: z.number().int().min(500).max(5 * 60_000).optional(),
}).strict();

export const runnerRelaySchema = z.object({
  containerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "Недопустимый контейнер"),
  targetPort: z.number().int().min(1).max(65_535),
}).strict();

export type RunnerCommandRequest = z.infer<typeof runnerCommandSchema>;
export type RunnerDockerRequest = z.infer<typeof runnerDockerSchema>;
export type RunnerRelayRequest = z.infer<typeof runnerRelaySchema>;

export type RunnerMetrics = {
  memoryTotalMb: number;
  memoryUsedMb: number;
  containers: number;
};

export type RunnerStatus = {
  ok: true;
  nodeId: string;
  mode: string;
  available: boolean;
  reason?: string;
  detail?: string;
  dockerVersion?: string;
  metrics: RunnerMetrics;
  workspace: {
    root: string;
    hostRoot: string;
    shared: boolean;
  };
  previewNetwork: string;
  previewAttachNetworks: string[];
};

export type RunnerRelay = {
  host: string;
  port: number;
};

export type RunnerErrorBody = {
  error: string;
  code?: string;
};
