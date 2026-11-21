/**
 * Сеть serverless-функций.
 *
 * Отдельная user-defined bridge-сеть нужна, чтобы функция не оказалась в одной сети с API,
 * PostgreSQL или чужими preview. Docker-брокер разрешает ровно это имя; правила хоста
 * (`deploy/scripts/egress-firewall.sh`) пропускают из неё публичный интернет и отклоняют
 * private/link-local/metadata.
 *
 * Имя можно переопределить для нестандартной установки, но значение обязано быть Docker-именем:
 * подставлять произвольную строку в `--network` нельзя.
 */
export const DEFAULT_FUNCTIONS_NETWORK = "webnestdev-functions";

const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESERVED = new Set(["bridge", "host", "none", "default"]);

export function functionsNetwork(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FUNCTIONS_DOCKER_NETWORK?.trim();
  if (!configured) return DEFAULT_FUNCTIONS_NETWORK;
  if (!NETWORK_NAME.test(configured)) {
    throw new Error(
      "FUNCTIONS_DOCKER_NETWORK должен быть именем Docker-сети (латиница, цифры, точка, дефис)",
    );
  }
  // Встроенные сети не изолируют функцию от хоста/других контейнеров. Ошибка конфигурации
  // должна остановить вызов, а не тихо запустить чужой код в bridge или host.
  if (RESERVED.has(configured.toLowerCase())) {
    throw new Error("FUNCTIONS_DOCKER_NETWORK не может быть встроенной сетью Docker");
  }
  // Сеть предпросмотра узнаётся по тому же суффиксу, что и в preview-network.ts. Функция в ней
  // получила бы доступ к чужим предпросмотрам, а не только к публичному интернету.
  if (/(^|[-_])preview$/i.test(configured) ||
      (env.PREVIEW_NETWORK?.trim() && env.PREVIEW_NETWORK.trim() === configured)) {
    throw new Error("FUNCTIONS_DOCKER_NETWORK не может быть сетью предпросмотра");
  }
  return configured;
}
