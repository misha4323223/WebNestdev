import { createServer, connect, type Server, type Socket } from "node:net";
import { runDockerCli } from "../sandbox/docker/cli.js";
import type { RunnerRelay } from "./protocol.js";

/**
 * A preview container lives on the runner's Docker bridge. The API on another VM cannot route
 * to that bridge, so the runner exposes one private TCP relay per preview. A raw TCP relay is
 * what makes HMR WebSockets work too: HTTP is not enough for a dev server.
 *
 * The relay is bound to the runner's private interface (never the public one by default) and is
 * only used by the API's preview proxy and Chromium checks. The preview ticket/domain remains the
 * public authorization boundary.
 */
export type PreviewRelayManager = {
  open(containerId: string, targetPort: number): Promise<RunnerRelay>;
  close(containerId: string): Promise<void>;
  closeAll(): Promise<void>;
};

type Entry = {
  containerId: string;
  targetPort: number;
  host: string;
  port: number;
  server: Server;
  sockets: Set<Socket>;
};

const MAX_CONNECTIONS_PER_RELAY = 128;

function addressTemplate() {
  return "{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}";
}

function nonEmptyLines(value: string) {
  return value.split("\n").map(line => line.trim()).filter(Boolean);
}

function resolveAdvertisedHost(bind: string) {
  const configured = process.env.RUNNER_PREVIEW_HOST?.trim() || process.env.WEBNESTDEV_NODE_ADDRESS?.trim() || "";
  if (configured) {
    try {
      return new URL(configured.includes("://") ? configured : "tcp://" + configured).hostname;
    } catch {
      return configured.split(":")[0] ?? configured;
    }
  }
  if (bind !== "0.0.0.0" && bind !== "::" && bind !== "") return bind;
  throw new Error(
    "RUNNER_PREVIEW_HOST не задан: для relay на 0.0.0.0 укажите приватный адрес runner, " +
      "по которому API сможет открыть TCP-соединение",
  );
}

export function createPreviewRelayManager(options: {
  bind?: string;
  docker?: typeof runDockerCli;
  maxConnections?: number;
} = {}): PreviewRelayManager {
  const bind = options.bind ?? process.env.RUNNER_PREVIEW_BIND?.trim() ?? "127.0.0.1";
  const docker = options.docker ?? runDockerCli;
  const advertisedHost = resolveAdvertisedHost(bind);
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS_PER_RELAY;
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry>>();

  async function containerAddress(containerId: string): Promise<string> {
    const inspected = await docker(["inspect", "-f", addressTemplate(), containerId], 5_000).catch(() => null);
    if (!inspected || inspected.code !== 0) throw new Error("Не удалось прочитать адрес контейнера предпросмотра");
    const address = nonEmptyLines(inspected.stdout)[0];
    if (!address) throw new Error("У контейнера предпросмотра нет сетевого адреса для relay");
    return address;
  }

  async function create(containerId: string, targetPort: number): Promise<Entry> {
    const upstreamHost = await containerAddress(containerId);
    const sockets = new Set<Socket>();
    const server = createServer(client => {
      if (sockets.size >= maxConnections) {
        client.destroy();
        return;
      }
      const upstream = connect({ host: upstreamHost, port: targetPort });
      sockets.add(client);
      sockets.add(upstream);
      const stop = () => {
        sockets.delete(client);
        sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", stop);
      upstream.on("error", stop);
      client.on("close", stop);
      upstream.on("close", stop);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: bind === "" ? undefined : bind, port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Relay предпросмотра не получил TCP-порт");
    }
    const entry: Entry = {
      containerId,
      targetPort,
      host: advertisedHost,
      port: address.port,
      server,
      sockets,
    };
    entries.set(containerId + ":" + targetPort, entry);
    server.on("close", () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (entries.get(containerId + ":" + targetPort) === entry) {
        entries.delete(containerId + ":" + targetPort);
      }
    });
    return entry;
  }

  async function open(containerId: string, targetPort: number): Promise<RunnerRelay> {
    const key = containerId + ":" + targetPort;
    const existing = entries.get(key);
    if (existing) return { host: existing.host, port: existing.port };
    const inFlight = pending.get(key);
    if (inFlight) {
      const entry = await inFlight;
      return { host: entry.host, port: entry.port };
    }
    const promise = create(containerId, targetPort);
    pending.set(key, promise);
    try {
      const entry = await promise;
      return { host: entry.host, port: entry.port };
    } finally {
      pending.delete(key);
    }
  }

  async function close(containerId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [key, entry] of entries) {
      if (entry.containerId !== containerId) continue;
      entries.delete(key);
      closing.push(new Promise<void>(resolve => entry.server.close(() => resolve())));
      for (const socket of entry.sockets) socket.destroy();
    }
    await Promise.all(closing);
  }

  async function closeAll(): Promise<void> {
    const ids = [...new Set([...entries.values()].map(entry => entry.containerId))];
    await Promise.all(ids.map(close));
  }

  return { open, close, closeAll };
}
