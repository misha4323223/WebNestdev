/** The variable names a project normally reads, per database engine. */
export function envVariables(scheme: string, url: string): Record<string, string> {
  if (scheme === "mongodb" || scheme === "mongodb+srv") return { DATABASE_URL: url, MONGODB_URI: url };
  if (scheme === "redis" || scheme === "rediss") return { DATABASE_URL: url, REDIS_URL: url };
  if (scheme === "ydb" || scheme === "grpcs" || scheme === "grpc") return { DATABASE_URL: url, YDB_CONNECTION_STRING: url };
  return { DATABASE_URL: url };
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Закрыта ли кавычка, с которой начинается значение. У многострочного ключа (PEM, pretty-printed
 * JSON) кавычек внутри много, и конец значения — это последняя из них, поэтому считать нужно все
 * неэкранированные кавычки, а не искать первую после открывающей.
 */
function quoteIsClosed(value: string) {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return true;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && value[back] === "\\"; back -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count % 2 === 0;
}

/**
 * Строки файла без присваиваний перечисленным переменным. Пропускается всё присваивание целиком,
 * включая продолжение многострочного значения: иначе после замены ключа в файле остались бы
 * «хвосты» вроде второй половины PEM, и следующее чтение превратило бы их в мусорную переменную.
 */
function filterEnvLines(existing: string, names: Set<string>) {
  if (!existing) return [];
  const lines = existing.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(ASSIGNMENT);
    if (!match || !names.has(match[1])) {
      kept.push(line);
      continue;
    }
    let value = line.slice(line.indexOf("=") + 1).trimStart();
    if (value[0] === '"' || value[0] === "'") {
      while (!quoteIsClosed(value) && index + 1 < lines.length) {
        index += 1;
        value += "\n" + lines[index];
      }
    }
  }
  return kept;
}

/**
 * Replaces only our own keys so the rest of the file — including comments and unrelated
 * variables — stays exactly as the project wrote it.
 */
export function mergeEnvFile(existing: string, variables: Record<string, string>) {
  const keys = new Set(Object.keys(variables));
  const kept = filterEnvLines(existing, keys);
  const added = Object.entries(variables).map(([key, value]) => key + "=" + value);
  const lines = [...kept, ...added];
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** Удаляет только указанные переменные, сохраняя комментарии и остальные строки файла. */
export function removeEnvVariables(existing: string, names: Iterable<string>) {
  const kept = filterEnvLines(existing, new Set(names));
  return kept.length ? kept.join("\n") + "\n" : "";
}
