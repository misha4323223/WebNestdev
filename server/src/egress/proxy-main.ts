import http from "node:http";
import { internalToken } from "../preview/door-token.js";
import { checkEgress, egressAllowlist } from "./allowlist.js";
import { createProjectResolver, whoisLookup } from "./attribution.js";
import { describeEgress, egressHealthPort, egressMode, egressProxyPort, EGRESS_WHOIS_PURPOSE } from "./config.js";
import { startEgressProxy } from "./proxy.js";

/**
 * Процесс egress-прокси (пункт 5.1 плана масштабирования).
 *
 * Вынесен из API по той же причине, что и дверь предпросмотра в 6.1: прокси держит соединения
 * чужих приложений и разговоры с реестрами пакетов, и это не должно занимать память и файловые
 * дескрипторы процесса, который обслуживает панель. Запускает его супервизор контейнера
 * (server/preview-door-run.sh), режим — `EGRESS_MODE` (egress/config.ts).
 *
 * Health-слушатель отдельный и только на 127.0.0.1: наружу он не нужен, а выкатка читает его
 * внутри контейнера (`docker compose exec … curl 127.0.0.1:8790/__health`). В нём — режим, размер
 * allowlist, текущие соединения и счётчики отказов: именно это отвечает на «почему установка
 * пакетов перестала работать» без захода на ВМ.
 */

export type EgressProxyDeps = {
  apiBase: string;
  token: string | null;
};

export function egressProxyDeps(env: NodeJS.ProcessEnv = process.env): EgressProxyDeps {
  return {
    apiBase: (env.EGRESS_PROXY_API_URL ?? "").trim() || "http://127.0.0.1:" + (env.PORT ?? "8787"),
    token: internalToken(EGRESS_WHOIS_PURPOSE, (env.WEBNESTDEV_ENCRYPTION_KEY ?? "").trim() || null),
  };
}

async function main() {
  const mode = egressMode();
  if (mode === "off") {
    // Код 0 — штатный выход: супервизор такой процесс больше не перезапускает.
    console.log("[egress] фильтр исходящей сети выключен (EGRESS_MODE=off) — прокси не запускаю");
    process.exit(0);
  }
  const port = egressProxyPort();
  const healthPort = egressHealthPort();
  const allowlist = egressAllowlist();
  const deps = egressProxyDeps();
  const identify = createProjectResolver({ lookup: whoisLookup(deps.apiBase, deps.token) });

  const proxy = startEgressProxy({
    check: (host, targetPort, address) => checkEgress(host, targetPort, address, { mode, allowlist }),
    identify,
    onDeny: entry => {
      // Одна строка на отказ: домен, проект и причина. Содержимое трафика не пишется никогда —
      // HTTPS идёт туннелем, и читать его прокси не умеет по устройству.
      console.warn("[egress] отказ: " + JSON.stringify(entry));
    },
  });

  await new Promise<void>((ready, fail) => {
    proxy.server.once("error", fail);
    proxy.server.listen(port, "0.0.0.0", () => ready());
  });
  console.log(
    "[egress] " + describeEgress() + "; доменов в allowlist: " + String(allowlist.length) + ", слушаю 0.0.0.0:" + String(port),
  );
  if (!deps.token) {
    console.warn("[egress] токен внутреннего канала не выведен (нет WEBNESTDEV_ENCRYPTION_KEY) — отказы будут без проекта");
  }

  const health = http.createServer((request, response) => {
    if (request.method !== "GET" || !(request.url ?? "").startsWith("/__health")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"ok":false,"error":"not found"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "egress-proxy",
        mode,
        port,
        allowlist: allowlist.length,
        connections: proxy.connections(),
        uptimeSeconds: Math.max(0, Math.round((Date.now() - proxy.stats.startedAt) / 1000)),
        stats: proxy.stats,
      }),
    );
  });

  const stop = () => {
    console.log("[egress] остановка: закрываю соединения и слушатели");
    void proxy.close().then(() => {
      health.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  await new Promise<void>((ready, fail) => {
    health.once("error", fail);
    health.listen(healthPort, "127.0.0.1", () => ready());
  });
}

void main().catch(error => {
  console.error("[egress] прокси не запустился: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
