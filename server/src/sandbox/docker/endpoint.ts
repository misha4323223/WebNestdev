import http from "node:http";

/**
 * Адрес Docker, которым пользуется сервер: прямой сокет демона или сокет брокера.
 *
 * Сервер не знает, что за сокетом стоит прокси: `docker` CLI читает `DOCKER_HOST` сам, поэтому
 * ни один вызов в коде не меняется. Здесь только две вещи, которых CLI не делает:
 *
 * 1. Проверка при старте. Контейнеры сервера и брокера поднимаются одновременно, и первые
 *    `docker run` (уборка заданий, проверка монтирования) могут опередить брокера. Поэтому старт
 *    ждёт `/_ping` до `WEBNESTDEV_DOCKER_BROKER_WAIT_MS` и, если брокер так и не ответил, убирает
 *    `DOCKER_HOST` — сервер продолжает работать через прямой сокет. Это не «тихий откат»: в лог
 *    уходит предупреждение, а `WEBNESTDEV_DOCKER_BROKER=0` выключает брокер осознанно.
 * 2. Список своих сетей. `preview-network.ts` раньше узнавал их, инспектируя собственный контейнер
 *    по hostname; брокер такой inspect запрещает (иначе через него видны метаданные чужих
 *    контейнеров). Вместо этого брокер отвечает `/_webnestdev/self` — он стоит в тех же сетях,
 *    что сервер, и знает свой hostname сам.
 */

/** Сокет брокера из `DOCKER_HOST`; `null` — брокер выключен или адрес не unix-сокет. */
export function dockerBrokerSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.WEBNESTDEV_DOCKER_BROKER ?? "").trim() === "0") return null;
  const host = (env.DOCKER_HOST ?? "").trim();
  if (!host.startsWith("unix://")) return null;
  const socket = host.slice("unix://".length).trim();
  return socket || null;
}

/** Строка для лога старта: по ней видно, куда именно ходит сервер. */
export function describeDockerEndpoint(): string {
  const socket = dockerBrokerSocket();
  if (socket) return "Docker через брокер: " + socket;
  if ((process.env.WEBNESTDEV_DOCKER_BROKER ?? "").trim() === "0") {
    return "Docker напрямую: /var/run/docker.sock (брокер выключен WEBNESTDEV_DOCKER_BROKER=0)";
  }
  return "Docker напрямую: /var/run/docker.sock (брокер не задан)";
}

/** Ответил ли брокер на `/_ping`. Таймаут короткий: это проверка на старте, а не запрос к БД. */
export function brokerPing(socket: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const request = http.request(
      { socketPath: socket, path: "/_ping", method: "GET", timeout: timeoutMs },
      response => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

/** Сети, в которых стоит брокер (он в тех же сетях, что сервер); `null` — брокер не активен. */
export function brokerSelfNetworks(timeoutMs = 2000): Promise<string[] | null> {
  const socket = dockerBrokerSocket();
  if (!socket) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = http.request(
      { socketPath: socket, path: "/_webnestdev/self", method: "GET", timeout: timeoutMs },
      response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { networks?: unknown };
            const networks = Array.isArray(parsed.networks)
              ? parsed.networks.filter((name): name is string => typeof name === "string" && name.length > 0)
              : [];
            resolve(networks.length ? networks : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

/**
 * Выбор адреса Docker на старте. Ошибка здесь не должна валить сервер: если брокер не поднялся,
 * платформа обязана работать как раньше, а не превращать выкатку в простой.
 */
export async function configureDockerEndpoint(): Promise<void> {
  const disabled = (process.env.WEBNESTDEV_DOCKER_BROKER ?? "").trim() === "0";
  if (disabled) {
    delete process.env.DOCKER_HOST;
    console.warn("[docker] брокер выключен (WEBNESTDEV_DOCKER_BROKER=0): работаю через /var/run/docker.sock");
    return;
  }
  const socket = dockerBrokerSocket();
  if (!socket) {
    const host = (process.env.DOCKER_HOST ?? "").trim();
    if (host) console.warn("[docker] DOCKER_HOST не является unix-сокетом и будет проигнорирован: " + host);
    return;
  }

  const rawWait = Number(process.env.WEBNESTDEV_DOCKER_BROKER_WAIT_MS ?? 10_000);
  const waitMs = Number.isFinite(rawWait) && rawWait >= 0 ? rawWait : 10_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await brokerPing(socket)) {
      console.log("[docker] работаю через Docker-брокер: " + socket);
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  delete process.env.DOCKER_HOST;
  console.warn(
    "[docker] брокер " + socket + " не ответил за " + Math.round(waitMs / 1000) +
    " с: убираю DOCKER_HOST и пробую /var/run/docker.sock. В контейнере сервера этого сокета нет" +
    " (docs/DOCKER_BROKER.md), поэтому песочницы и предпросмотр работать не будут: проверьте" +
    " `docker compose ps docker-broker` и `docker compose logs docker-broker`",
  );
}
