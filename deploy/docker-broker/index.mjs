/**
 * Вход Docker-брокера.
 *
 * Запускается тем же образом, что и сервер, но другой командой (см. docker-compose.yml). Слушает
 * unix-сокет в общем томе, к которому сервер имеет доступ; настоящий `/var/run/docker.sock` видит
 * только этот процесс. Никаких зависимостей: образ уже содержит Node, а лишний пакет в
 * привилегированном компоненте — лишняя поверхность.
 *
 * Переменные:
 *   BROKER_SOCKET      — где слушать (по умолчанию /run/webnestdev-docker/docker.sock);
 *   BROKER_UPSTREAM    — настоящий сокет демона (по умолчанию /var/run/docker.sock);
 *   BROKER_SANDBOX_ROOT— каталог, внутри которого разрешены монтирования;
 *   BROKER_IMAGE       — единственный образ, который разрешено запускать;
 *   BROKER_RUNTIME      — единственный разрешённый HostConfig.Runtime (docker|runsc);
 *   PREVIEW_NETWORK    — явно заданная сеть предпросмотра (если имя не кончается на preview);
 *   BROKER_SOCKET_MODE — права на сокет (по умолчанию 0660);
 *   BROKER_SOCKET_GID  — группа сокета, чтобы сервер мог ходить в него не от root.
 */
import fs from "node:fs";
import path from "node:path";
import { createBrokerServer } from "./proxy.mjs";

const socketPath = process.env.BROKER_SOCKET?.trim() || "/run/webnestdev-docker/docker.sock";
const upstreamPath = process.env.BROKER_UPSTREAM?.trim() || "/var/run/docker.sock";
const sandboxRoot = path.posix.resolve(process.env.BROKER_SANDBOX_ROOT?.trim() || "/var/lib/webnestdev/sandboxes");
const image = (process.env.BROKER_IMAGE?.trim() || process.env.SANDBOX_IMAGE?.trim() || "node:22-bookworm");
const previewNetwork = process.env.PREVIEW_NETWORK?.trim() || "";
const runtime = (process.env.BROKER_RUNTIME?.trim() || process.env.SANDBOX_RUNTIME?.trim() || "docker").toLowerCase();
// Политика умеет только эти два значения. Опечатка должна остановить брокер с понятной
// причиной, а не оставить его с runtime, который не разрешит ни один create.
if (runtime !== "docker" && runtime !== "runsc") {
  console.error("[broker] BROKER_RUNTIME=" + runtime + " не поддерживается: используйте docker или runsc");
  process.exit(1);
}
const socketMode = Number.parseInt(process.env.BROKER_SOCKET_MODE?.trim() || "0660", 8);
const socketGid = Number.parseInt(process.env.BROKER_SOCKET_GID?.trim() || "1000", 10);

// Каталог песочниц смонтирован в брокер только на чтение (docker-compose.yml): по нему
// разрешаются символические ссылки в путях монтирования. Без этого `link -> /` внутри проекта
// обошёл бы строковую проверку префикса.
function realRootOf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

const policy = {
  image,
  runtime,
  sandboxRoot,
  realRoot: realRootOf(sandboxRoot),
  realpath: source => fs.realpathSync(source),
  // То же правило, что у сервера (preview/preview-network.ts): явное имя оператора или сеть,
  // имя которой кончается на preview. Сеть базы (`…db`) под это правило не подходит.
  isPreviewNetwork: name =>
    name === previewNetwork || /(^|[-_])preview$/i.test(String(name ?? "")),
};

const socketDir = path.dirname(socketPath);
fs.mkdirSync(socketDir, { recursive: true });
// Сервер работает от uid 1000 и должен пройти в каталог, чтобы открыть сокет. Обычный umask
// даёт 0755, но при umask 077 каталог остался бы root-only и сокет был бы недоступен даже с
// правильной группой. chmod принадлежащего root каталога не требует capabilities.
if (socketDir !== "/") {
  try {
    fs.chmodSync(socketDir, 0o755);
  } catch (error) {
    console.warn("[broker] не удалось открыть каталог сокета " + socketDir + ": " + error.message);
  }
}
try {
  fs.unlinkSync(socketPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const server = createBrokerServer({ socketPath, upstreamPath, policy });

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, Number.isFinite(socketMode) ? socketMode : 0o660);
  // Сервер после этапа 2.2 работает от uid 1000, а брокер остаётся root: сокет должен быть
  // доступен группе сервера. Compose запускает брокер с первичной группой 1000, поэтому сокет
  // обычно уже создан с нужной группой; chown нужен только при другом gid. Без CAP_CHOWN
  // (cap_drop ALL) он не сработает, поэтому лишний вызов не делаем, а ошибку показываем.
  if (Number.isFinite(socketGid) && socketGid >= 0) {
    try {
      const stat = fs.statSync(socketPath);
      if (stat.uid !== 0 || stat.gid !== socketGid) {
        fs.chownSync(socketPath, 0, socketGid);
      }
    } catch (error) {
      console.warn("[broker] не удалось выставить группу сокета " + socketGid + ": " + error.message);
    }
  }
  console.log(
    "[broker] сокет " + socketPath + " (" + (Number.isFinite(socketMode) ? socketMode.toString(8) : "660") +
    ", gid " + (Number.isFinite(socketGid) ? socketGid : "1000") + ")" +
    ", демон " + upstreamPath + ", образ " + image + ", песочницы " + sandboxRoot +
    ", runtime " + runtime +
    (previewNetwork ? ", сеть предпросмотра " + previewNetwork : ""),
  );
});

server.on("error", error => {
  console.error("[broker] не удалось открыть сокет: " + error.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log("[broker] " + signal + ": закрываю сокет");
  server.close(() => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Сокета уже нет — процесс всё равно завершается.
    }
    process.exit(0);
  });
  // Открытые hijack-сессии не должны держать процесс: через две секунды выходим принудительно.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
