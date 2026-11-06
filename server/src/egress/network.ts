import { previewNetwork } from "../preview/preview-network.js";
import { egressProxyEnabled } from "./config.js";

/**
 * Сеть для контейнера, которому нужен интернет (`npm install`, `pip`, EAS CLI).
 *
 * Вызовы просят `bridge` — это и было «наружу» до фильтра. Но прокси живёт в контейнере сервера,
 * а сервер стоит в сети предпросмотра, а не в bridge: из bridge до него не достать, и установка
 * пакетов упала бы на неразрешённом имени прокси. Поэтому при включённом фильтре сетевые
 * установки идут в сеть предпросмотра — туда же, где живёт предпросмотр и где имя сервиса
 * резолвится встроенным DNS Docker.
 *
 * Отказ поиска сети — не ошибка установки: возвращается bridge, контейнер получает интернет
 * напрямую (как раньше), а переменные прокси ему не передаются (см. sandbox/docker/args.ts).
 */
export async function sandboxNetwork(requested: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (requested !== "bridge" || !egressProxyEnabled(env)) return requested;
  const network = await previewNetwork().catch(() => "");
  return network || "bridge";
}

/**
 * Может ли контейнер в этой сети дойти до прокси. `none` — сети нет вовсе, `bridge` — другая
 * сеть без нашего прокси (там же оказываются и удалённые runner'ы). Переменные прокси в таких
 * контейнерах не «вредны», а вредны: установка пойдёт по адресу, которого нет.
 */
export function proxyReachableFrom(network: string | undefined): boolean {
  const value = (network ?? "").trim();
  return value !== "" && value !== "none" && value !== "bridge" && value !== "default";
}
