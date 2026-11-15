/**
 * Feature flags for the gradual upgrade of the agent.
 *
 * Every flag is off unless its environment variable is explicitly set to a true value. That is
 * deliberate: an unfinished stage must never change the behaviour of a normal run. The same flag
 * is the kill switch — setting it to `0` returns the old path immediately, without a deploy.
 *
 * The names and their stages are documented in `docs/AI_AGENT_CAPABILITY_PLAN.md`.
 */
export const AGENT_FEATURE_ENV = {
  repoMap: "AGENT_REPO_MAP",
  testRunner: "AGENT_TEST_RUNNER",
  archMemory: "AGENT_ARCH_MEMORY",
  milestones: "AGENT_MILESTONES",
  reviewer: "AGENT_REVIEWER",
  multiWriter: "AGENT_MULTI_WRITER",
  modelRouter: "AGENT_MODEL_ROUTER",
} as const;

export type AgentFeature = keyof typeof AGENT_FEATURE_ENV;
export type AgentFeatureSnapshot = Record<AgentFeature, boolean>;
export type AgentEnv = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** A missing or non-true value keeps the experimental path off. */
export function agentFeatureEnabled(feature: AgentFeature, env: AgentEnv = process.env): boolean {
  const raw = env[AGENT_FEATURE_ENV[feature]];
  return typeof raw === "string" && TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function agentFeatureSnapshot(env: AgentEnv = process.env): AgentFeatureSnapshot {
  const snapshot = {} as AgentFeatureSnapshot;
  for (const feature of Object.keys(AGENT_FEATURE_ENV) as AgentFeature[]) {
    snapshot[feature] = agentFeatureEnabled(feature, env);
  }
  return snapshot;
}

/** Printed once at startup so an operator can see which experimental paths are active. */
export function describeAgentFeatures(env: AgentEnv = process.env): string {
  const enabled = (Object.keys(AGENT_FEATURE_ENV) as AgentFeature[])
    .filter(feature => agentFeatureEnabled(feature, env))
    .map(feature => AGENT_FEATURE_ENV[feature]);
  return enabled.length
    ? "экспериментальные возможности включены: " + enabled.join(", ")
    : "экспериментальные возможности выключены (все AGENT_* флаги = 0)";
}
