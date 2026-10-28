/**
 * Политика Docker-брокера: что можно, что нельзя и почему.
 *
 * Здесь нет ни сокетов, ни процессов — только разбор запроса Engine API и проверка тела
 * `containers/create`. Это сделано намеренно: политика должна проверяться тестами без Docker,
 * потому что в среде сборки демона нет. Прокси (proxy.mjs) вызывает эти функции и только потом
 * что-то пересылает.
 *
 * Правило по умолчанию — отказ. Серверу нужно ровно то, что перечислено в classify(); всё
 * остальное (образы, тома, секреты, swarm, build) закрыто, даже если когда-нибудь появится в
 * клиенте: новая операция должна быть добавлена здесь осознанно.
 */

export const MANAGED_LABEL = "webnestdev.managed";

const VERSION_PREFIX = /^\/v\d+\.\d+(?=\/|$)/;

const EMPTY = value =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);

const isObject = value => typeof value === "object" && value !== null && !Array.isArray(value);

/** Поля Config, которые сервер действительно присылает; остальные с непустым значением — отказ. */
const CONFIG_KEYS = new Set([
  "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr", "Tty",
  "OpenStdin", "StdinOnce", "Env", "Cmd", "Healthcheck", "ArgsEscaped", "Image", "Volumes",
  "WorkingDir", "Entrypoint", "OnBuild", "Labels", "StopSignal", "StopTimeout", "Shell",
  "HostConfig", "NetworkDisabled", "MacAddress", "ExposedPorts", "NetworkingConfig", "PortSpecs",
  "ConsoleSize",
]);

/** Поля HostConfig: либо проверяются ниже, либо должны быть пустыми. */
const HOST_KEYS = new Set([
  "Binds", "NetworkMode", "CapAdd", "CapDrop", "SecurityOpt", "ReadonlyRootfs", "Tmpfs",
  "Memory", "MemorySwap", "MemoryReservation", "NanoCpus", "CpuShares", "CpuQuota", "CpuPeriod",
  "PidsLimit", "ShmSize", "Init", "AutoRemove", "OomKillDisable", "ConsoleSize",
  "MaskedPaths", "ReadonlyPaths", "Privileged", "PidMode", "IpcMode", "UTSMode", "UsernsMode",
  "CgroupnsMode", "CgroupParent", "Devices", "DeviceRequests", "DeviceCgroupRules", "PortBindings",
  "PublishAllPorts", "RestartPolicy", "Runtime", "VolumesFrom", "Links", "ExtraHosts", "Dns",
  "DnsOptions", "DnsSearch", "Sysctls", "Ulimits", "GroupAdd", "Isolation", "CpuRealtimeRuntime",
  "CpuRealtimePeriod", "CpusetCpus", "CpusetMems", "BlkioWeight", "BlkioWeightDevice",
  "BlkioDeviceReadBps", "BlkioDeviceWriteBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps",
  "Mounts", "LogConfig",
]);

/** Поля, которые обязаны быть пустыми: с ними контейнер выходит за пределы песочницы. */
const FORBIDDEN_HOST_FIELDS = [
  "PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode", "CgroupParent", "Runtime",
  "VolumesFrom", "Links", "ExtraHosts", "Dns", "DnsOptions", "DnsSearch", "Sysctls", "Ulimits",
  "GroupAdd", "MaskedPaths", "ReadonlyPaths", "Isolation", "CpusetCpus", "CpusetMems",
  "Devices", "DeviceRequests", "DeviceCgroupRules", "CpuRealtimeRuntime", "CpuRealtimePeriod",
  "BlkioWeight", "BlkioWeightDevice", "BlkioDeviceReadBps", "BlkioDeviceWriteBps",
  "BlkioDeviceReadIOps", "BlkioDeviceWriteIOps",
];

const MAX_MEMORY = 4 * 1024 * 1024 * 1024;
const MAX_SWAP = 8 * 1024 * 1024 * 1024;
const MAX_NANO_CPUS = 4_000_000_000;
const MAX_PIDS = 512;
const MAX_SHM = 256 * 1024 * 1024;

/** Снимает префикс версии API (`/v1.45/containers/...`): CLI добавляет его после согласования. */
export function stripVersion(pathname) {
  return pathname.replace(VERSION_PREFIX, "") || "/";
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Разбор запроса в одно из действий. Ничего не пересылает и не ждёт: решение о конкретном
 * контейнере (свой или чужой) принимает proxy.mjs, потому что для этого нужен ответ демона.
 */
export function classify(method, rawUrl) {
  const upper = String(method ?? "").toUpperCase();
  const [pathname, search = ""] = String(rawUrl ?? "/").split("?");
  const parts = stripVersion(pathname).split("/").filter(Boolean).map(decode);
  if (parts.some(part => part === null)) return deny(400, "Некорректный путь запроса");
  const query = new URLSearchParams(search);

  if ((upper === "GET" || upper === "HEAD") && parts.length === 1 && parts[0] === "_ping") {
    return { kind: "proxy" };
  }
  if (upper === "GET" && parts.length === 1 && parts[0] === "version") return { kind: "proxy" };
  if (upper === "GET" && parts.join("/") === "_webnestdev/self") return { kind: "self" };
  if (upper === "GET" && parts.join("/") === "containers/json") return { kind: "containers-list" };
  if (upper === "POST" && parts.join("/") === "containers/create") {
    return { kind: "container-create", name: query.get("name") ?? "" };
  }
  if (upper === "GET" && parts.join("/") === "images/json") return { kind: "images-list" };
  if (upper === "GET" && parts.join("/") === "networks") return { kind: "networks-list" };
  if (upper === "GET" && parts.join("/") === "system/df") return { kind: "system-df" };
  if (upper === "POST" && parts.join("/") === "build/prune") return { kind: "prune" };
  if (upper === "POST" && parts.join("/") === "images/prune") return { kind: "prune" };

  if (parts[0] === "containers" && parts.length >= 2) {
    const id = parts[1];
    if (parts.length === 2 && upper === "DELETE") return { kind: "container", action: "delete", id };
    if (parts.length === 3) {
      const action = parts[2];
      if (upper === "GET" && action === "json") return { kind: "container", action: "inspect", id };
      if (upper === "POST" && action === "start") return { kind: "container", action: "start", id };
      if (upper === "POST" && action === "attach") return { kind: "container", action: "attach", id };
      if (upper === "POST" && action === "exec") return { kind: "container", action: "exec", id };
      if (upper === "GET" && action === "logs") return { kind: "container", action: "logs", id };
      if (upper === "POST" && action === "wait") return { kind: "container", action: "wait", id };
    }
    return deny(403, "Операция с контейнером запрещена политикой брокера: " + upper + " " + pathname);
  }

  if (parts[0] === "exec" && parts.length === 3 && parts[2] === "start" && upper === "POST") {
    return { kind: "exec-start", id: parts[1] };
  }

  if (parts[0] === "networks" && parts.length >= 2) {
    const id = parts[1];
    if (parts.length === 2 && upper === "GET") return { kind: "network", action: "inspect", id };
    if (parts.length === 3 && parts[2] === "connect" && upper === "POST") {
      return { kind: "network", action: "connect", id };
    }
    return deny(403, "Операция с сетью запрещена политикой брокера: " + upper + " " + pathname);
  }

  // `GET /images/{name}/json` — проверка наличия образа локально (`--pull=never` и `docker run`).
  // Имя может содержать слеши, поэтому берётся всё между images/ и /json.
  if (parts[0] === "images" && parts.length >= 3 && upper === "GET" && parts.at(-1) === "json") {
    return { kind: "image", name: parts.slice(1, -1).join("/") };
  }

  return deny(403, "Эндпоинт Docker запрещён политикой брокера: " + upper + " " + pathname);
}

function deny(status, message) {
  return { kind: "deny", status, message };
}

function fail(message) {
  return { ok: false, message };
}

function isInside(root, candidate) {
  const normalized = String(candidate).replace(/\/+$/, "");
  const normalizedRoot = String(root).replace(/\/+$/, "");
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + "/");
}

/**
 * Проверка одного монтирования. Кроме строкового префикса сверяется настоящий путь (`realpath`):
 * иначе символическая ссылка внутри проекта (`link -> /`) обошла бы проверку — Docker монтирует то,
 * на что она указывает. Каталог песочниц смонтирован в брокер только на чтение, поэтому реальный
 * путь он может разрешить, не открывая хосту лишнего.
 */
function checkBind(policy, source, target, readOnly) {
  if (typeof source !== "string" || !source.startsWith("/")) {
    return "монтирование должно быть абсолютным путём: " + String(source);
  }
  const normalizedSource = source.replace(/\/+$/, "");
  if (normalizedSource.includes("/../") || normalizedSource.endsWith("/..")) {
    return "монтирование с «..» запрещено: " + source;
  }
  if (!isInside(policy.sandboxRoot, normalizedSource)) {
    return "монтировать можно только каталог песочниц, а не " + source;
  }
  let real = normalizedSource;
  if (typeof policy.realpath === "function") {
    try {
      real = String(policy.realpath(normalizedSource)).replace(/\/+$/, "");
    } catch {
      // Источники платформы всегда существуют до запуска (каталог проекта, файл маски, секреты).
      // Если путь не открывается — это либо ошибка, либо попытка дать Docker создать каталог.
      return "источник монтирования не существует: " + source;
    }
  }
  if (!isInside(policy.realRoot ?? policy.sandboxRoot, real)) {
    return "источник монтирования ведёт за пределы каталога песочниц: " + source;
  }
  if (typeof target !== "string" || !(target === "/workspace" || target.startsWith("/workspace/"))) {
    return "точка монтирования должна быть внутри /workspace: " + String(target);
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") return "неверный флаг read-only";
  // Открытый текст секретов предпросмотра живёт в `.secret-runtime` рядом с проектом. Он нужен
  // приложению для чтения и никогда — для записи, поэтому rw-монтирование этого каталога запрещено.
  if (normalizedSource.includes("/.secret-runtime") && readOnly !== true) {
    return "секреты предпросмотра монтируются только read-only: " + source;
  }
  return null;
}

function checkTmpfs(tmpfs) {
  if (EMPTY(tmpfs)) return null;
  if (!isObject(tmpfs)) return "Tmpfs должен быть объектом";
  for (const [target, options] of Object.entries(tmpfs)) {
    if (!(target === "/tmp" || target.startsWith("/tmp/"))) {
      return "tmpfs разрешён только внутри /tmp: " + target;
    }
    const value = String(options ?? "");
    if (!/(^|,)nosuid(,|$)/.test(value)) return "tmpfs обязан быть nosuid: " + target;
    if (/(^|,)suid(,|$)/.test(value) || /(^|,)exec(,|$)/.test(value)) {
      return "tmpfs не может быть suid или exec: " + target;
    }
    const size = /(?:^|,)size=(\d+)([kmg]?)(?:,|$)/i.exec(value);
    if (size) {
      const factor = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[size[2].toLowerCase()] ?? 1;
      if (Number(size[1]) * factor > MAX_SHM) return "tmpfs больше 256 МБ: " + target;
    }
  }
  return null;
}

/**
 * `docker run --network` присылает сеть дважды: в `HostConfig.NetworkMode` и в
 * `NetworkingConfig.EndpointsConfig`. Второе не расширяет прав, если имя сети уже разрешено, а
 * настройки endpoint пусты: aliases, links и IPAM позволяли бы выдать контейнер за другой сервис
 * внутри сети. Поэтому структура разрешена, а её содержимое — нет.
 */
function checkNetworkingConfig(networking, policy, networkMode) {
  if (EMPTY(networking)) return null;
  if (!isObject(networking)) return "NetworkingConfig должен быть объектом";
  for (const key of Object.keys(networking)) {
    if (key !== "EndpointsConfig" && !EMPTY(networking[key])) {
      return "Неизвестное поле NetworkingConfig запрещено: " + key;
    }
  }
  const endpoints = networking.EndpointsConfig;
  if (EMPTY(endpoints)) return null;
  if (!isObject(endpoints)) return "EndpointsConfig должен быть объектом";
  const names = Object.keys(endpoints);
  if (names.length > 1) return "Контейнер может быть только в одной сети";
  const name = names[0];
  if (!(name === "" || name === "default" || name === "bridge" || name === "none" || policy.isPreviewNetwork(name))) {
    return "Сеть " + name + " запрещена: разрешены none, bridge и сеть предпросмотра";
  }
  if (networkMode && networkMode !== "default" && name !== networkMode) {
    return "NetworkingConfig не совпадает с HostConfig.NetworkMode: " + name + " ≠ " + networkMode;
  }
  const settings = endpoints[name];
  if (EMPTY(settings)) return null;
  if (!isObject(settings)) return "Настройки сети должны быть объектом";
  for (const [field, value] of Object.entries(settings)) {
    if (!EMPTY(value)) return "Настройки endpoint запрещены: " + field;
  }
  return null;
}

/**
 * Проверка тела `containers/create`. Возвращает `{ok:true}` или `{ok:false, message}`.
 * Тело не переписывается: политика проверяет всё, что может вывести контейнер за песочницу, и
 * отказывает, а не «чинит» запрос — иначе непонятно, что именно запустилось.
 */
export function validateCreate(body, policy) {
  if (!isObject(body)) return fail("Тело create должно быть объектом");

  for (const key of Object.keys(body)) {
    if (CONFIG_KEYS.has(key)) continue;
    if (!EMPTY(body[key])) return fail("Неизвестное поле контейнера запрещено: " + key);
  }
  if (!EMPTY(body.Hostname) || !EMPTY(body.Domainname) || !EMPTY(body.MacAddress)) {
    return fail("Своё имя хоста, домен и MAC-адрес запрещены");
  }
  if (!EMPTY(body.ExposedPorts) || !EMPTY(body.Volumes)) {
    return fail("Порты и анонимные тома в контейнере запрещены");
  }
  if (!EMPTY(body.ConsoleSize) && !(Array.isArray(body.ConsoleSize) && body.ConsoleSize.every(v => v === 0))) {
    return fail("ConsoleSize запрещён");
  }
  if (!EMPTY(body.Healthcheck)) return fail("Healthcheck не используется платформой и запрещён");
  if (body.Tty || body.OpenStdin || body.AttachStdin || body.StdinOnce) {
    return fail("TTY и stdin не используются платформой и запрещены");
  }
  if (typeof body.Image !== "string" || body.Image !== policy.image) {
    return fail("Образ контейнера должен быть " + policy.image + ", а не " + String(body.Image));
  }
  if (!(body.User === "1000:1000" || body.User === "1000")) {
    return fail("Контейнер обязан работать от uid 1000, а не от " + String(body.User));
  }
  const workdir = body.WorkingDir ?? "/workspace";
  if (typeof workdir !== "string" || !(workdir === "/workspace" || workdir.startsWith("/workspace/"))) {
    return fail("Рабочий каталог должен быть внутри /workspace: " + String(workdir));
  }
  if (!Array.isArray(body.Env) || body.Env.some(item => typeof item !== "string")) {
    return fail("Env должен быть массивом строк");
  }
  if (!EMPTY(body.Labels) && (!isObject(body.Labels) || Object.values(body.Labels).some(v => typeof v !== "string"))) {
    return fail("Labels должен быть объектом строк");
  }
  if (body.StopTimeout !== undefined && (!Number.isInteger(body.StopTimeout) || body.StopTimeout > 60)) {
    return fail("StopTimeout больше 60 секунд запрещён");
  }

  const host = body.HostConfig;
  if (!isObject(host)) return fail("HostConfig обязателен");
  for (const key of Object.keys(host)) {
    if (HOST_KEYS.has(key)) continue;
    if (!EMPTY(host[key])) return fail("Неизвестное поле HostConfig запрещено: " + key);
  }
  if (host.Privileged) return fail("privileged-контейнер запрещён");
  if (!EMPTY(host.CapAdd)) return fail("Добавление capabilities запрещено");
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.some(value => String(value).toUpperCase() === "ALL")) {
    return fail("Контейнер обязан запускаться с --cap-drop ALL");
  }
  const securityOpt = host.SecurityOpt;
  if (!Array.isArray(securityOpt) || securityOpt.length !== 1 || securityOpt[0] !== "no-new-privileges:true") {
    return fail("SecurityOpt обязан быть ровно no-new-privileges:true");
  }
  if (host.ReadonlyRootfs !== true) return fail("Корень контейнера обязан быть read-only");
  for (const key of FORBIDDEN_HOST_FIELDS) {
    if (!EMPTY(host[key])) return fail("Поле HostConfig." + key + " запрещено");
  }
  if (!EMPTY(host.PortBindings) || host.PublishAllPorts) {
    return fail("Публикация портов на хост запрещена");
  }
  const restart = host.RestartPolicy;
  if (!EMPTY(restart)) {
    if (!isObject(restart)) return fail("RestartPolicy должен быть объектом");
    if (!EMPTY(restart.Name) && restart.Name !== "no") return fail("Автоперезапуск контейнера запрещён");
    if (restart.MaximumRetryCount) return fail("Автоперезапуск контейнера запрещён");
  }
  if (!EMPTY(host.LogConfig) && !isObject(host.LogConfig)) return fail("LogConfig должен быть объектом");
  if (isObject(host.LogConfig) && !EMPTY(host.LogConfig.Type)) {
    return fail("Свой драйвер логов запрещён: вывод контейнера не должен уходить наружу");
  }
  if (host.OomKillDisable) return fail("Отключать OOM killer запрещено");
  if (!EMPTY(host.ConsoleSize) && !(Array.isArray(host.ConsoleSize) && host.ConsoleSize.every(v => v === 0))) {
    return fail("ConsoleSize запрещён");
  }

  const network = host.NetworkMode ?? "";
  if (!(network === "" || network === "default" || network === "bridge" || network === "none" || policy.isPreviewNetwork(network))) {
    return fail("Сеть " + network + " запрещена: разрешены none, bridge и сеть предпросмотра");
  }
  const networkingError = checkNetworkingConfig(body.NetworkingConfig, policy, network);
  if (networkingError) return fail(networkingError);

  // Монтирования: `-v` приходит в Binds, программный клиент может прислать Mounts. Проверяются оба.
  if (!EMPTY(host.Binds)) {
    if (!Array.isArray(host.Binds)) return fail("Binds должен быть массивом");
    for (const entry of host.Binds) {
      if (typeof entry !== "string") return fail("Binds должен содержать строки");
      const parts = entry.split(":");
      if (parts.length > 3) return fail("Слишком много полей в монтировании: " + entry);
      const [source, target, mode = ""] = parts;
      if (!["", "rw", "ro"].includes(mode)) return fail("Режим монтирования запрещён: " + mode);
      const error = checkBind(policy, source, target, mode === "ro");
      if (error) return fail(error);
    }
  }
  if (!EMPTY(host.Mounts)) {
    if (!Array.isArray(host.Mounts)) return fail("Mounts должен быть массивом");
    for (const mount of host.Mounts) {
      if (!isObject(mount) || mount.Type !== "bind") return fail("Разрешены только bind-монтирования");
      if (!EMPTY(mount.VolumeOptions) || !EMPTY(mount.TmpfsOptions) || !EMPTY(mount.BindOptions)) {
        return fail("VolumeOptions, TmpfsOptions и BindOptions запрещены");
      }
      const error = checkBind(policy, mount.Source, mount.Target, mount.ReadOnly === true);
      if (error) return fail(error);
    }
  }
  const tmpfsError = checkTmpfs(host.Tmpfs);
  if (tmpfsError) return fail(tmpfsError);

  if (!Number.isInteger(host.Memory) || host.Memory <= 0 || host.Memory > MAX_MEMORY) {
    return fail("Memory обязательна и должна быть от 1 байта до 4 ГБ");
  }
  if (host.MemorySwap !== undefined && host.MemorySwap !== null) {
    if (!Number.isInteger(host.MemorySwap) || host.MemorySwap < 0 || host.MemorySwap > MAX_SWAP) {
      return fail("MemorySwap вне допустимых пределов");
    }
  }
  if (host.MemoryReservation !== undefined && (!Number.isInteger(host.MemoryReservation) || host.MemoryReservation < 0 || host.MemoryReservation > host.Memory)) {
    return fail("MemoryReservation не может быть больше Memory");
  }
  if (!Number.isInteger(host.NanoCpus) || host.NanoCpus <= 0 || host.NanoCpus > MAX_NANO_CPUS) {
    return fail("NanoCpus обязательны и не больше 4 CPU");
  }
  if (!Number.isInteger(host.PidsLimit) || host.PidsLimit <= 0 || host.PidsLimit > MAX_PIDS) {
    return fail("PidsLimit обязателен и не больше " + MAX_PIDS);
  }
  for (const [key, max] of [["CpuShares", 4096], ["CpuQuota", 400_000], ["CpuPeriod", 100_000], ["ShmSize", MAX_SHM]]) {
    const value = host[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > max)) {
      return fail("Поле " + key + " вне допустимых пределов");
    }
  }

  return { ok: true };
}

/** Контейнер свой, если он помечен брокером или платформой (метка `webnestdev.*`) либо носит наше имя. */
export function isManagedContainer(info) {
  if (!isObject(info)) return false;
  const labels = info.Config?.Labels ?? info.Labels ?? {};
  if (isObject(labels) && Object.keys(labels).some(key => key.startsWith("webnestdev."))) return true;
  const name = String(info.Name ?? "").replace(/^\/+/, "");
  return /^wnd-[A-Za-z0-9_.-]+$/.test(name);
}

/** Имя контейнера, которое сервер вправе создать: `wnd-…` (cmd, job, preview и проверки). */
export function isAllowedName(name) {
  return !name || /^wnd-[A-Za-z0-9_.-]{1,110}$/.test(name);
}
