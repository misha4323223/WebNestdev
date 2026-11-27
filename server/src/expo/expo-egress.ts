import { egressAllowlist, hostAllowlisted } from "../egress/allowlist.js";
import { egressMode, type EgressMode } from "../egress/config.js";

/**
 * Доступ песочницы к Expo.
 *
 * `eas-cli` живёт в контейнере проекта, а контейнер в production выходит в интернет только через
 * прокси с allowlist (`EGRESS_MODE=allowlist`). Если домена Expo в списке нет, CLI получает 403 от
 * прокси на первом же запросе к `api.expo.dev`, и снаружи это выглядит как «сборку отправить
 * нельзя, у инструмента текстовое тело в 200 КБ». Модель тогда ищет обходной путь через
 * `net.request`, которого для сборки не существует.
 *
 * Поэтому доступ проверяется до запуска контейнера и до того, как модель начнёт объяснять
 * ограничение: причина называется прямо, вместе с тем, чего делать не нужно.
 */
export const EXPO_EGRESS_HOSTS = ["api.expo.dev", "expo.dev"] as const;

export type ExpoEgressReport = {
  /** Режим фильтра: `off` и `private-only` пропускают любой публичный адрес. */
  mode: EgressMode;
  /** Дойдёт ли EAS CLI до Expo из контейнера проекта. */
  expoAllowed: boolean;
  /** Готовое объяснение для модели или `null`. */
  problem: string | null;
};

export function expoEgressProblem(
  env: NodeJS.ProcessEnv = process.env,
  allowlist: string[] = egressAllowlist(env.EGRESS_ALLOWLIST),
): string | null {
  // В `private-only` и `off` фильтр не решает по домену: публичный api.expo.dev доступен.
  if (egressMode(env) !== "allowlist") return null;
  const missing = EXPO_EGRESS_HOSTS.filter(host => !hostAllowlisted(host, allowlist));
  if (!missing.length) return null;
  return (
    "Песочнице закрыт доступ к " +
    missing.join(", ") +
    ": фильтр исходящей сети платформы (EGRESS_MODE=allowlist) не пускает эти домены, поэтому EAS CLI " +
    "не может ни связать проект, ни загрузить архив, ни создать сборку. Это настройка платформы, а не проект, " +
    "не токен и не тариф. Создание сборки требует multipart-загрузки архива, у net.request тело текстовое — " +
    "через него сборку не запустить и пробовать не нужно. Сообщите пользователю, что домену Expo нужен доступ " +
    "из песочницы."
  );
}

export function expoEgressReport(env: NodeJS.ProcessEnv = process.env): ExpoEgressReport {
  const problem = expoEgressProblem(env);
  return { mode: egressMode(env), expoAllowed: problem === null, problem };
}
