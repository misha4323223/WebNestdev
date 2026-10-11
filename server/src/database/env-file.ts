/** The variable names a project normally reads, per database engine. */
export function envVariables(scheme: string, url: string): Record<string, string> {
  if (scheme === "mongodb" || scheme === "mongodb+srv") return { DATABASE_URL: url, MONGODB_URI: url };
  if (scheme === "redis" || scheme === "rediss") return { DATABASE_URL: url, REDIS_URL: url };
  if (scheme === "ydb" || scheme === "grpcs" || scheme === "grpc") return { DATABASE_URL: url, YDB_CONNECTION_STRING: url };
  return { DATABASE_URL: url };
}

/**
 * Replaces only our own keys so the rest of the file — including comments and unrelated
 * variables — stays exactly as the project wrote it.
 */
export function mergeEnvFile(existing: string, variables: Record<string, string>) {
  const keys = new Set(Object.keys(variables));
  const lines = existing.length ? existing.replace(/\n$/, "").split("\n") : [];
  const kept = lines.filter(line => {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return !key || !keys.has(key);
  });
  const added = Object.entries(variables).map(([key, value]) => key + "=" + value);
  return [...kept, ...added].join("\n") + "\n";
}
