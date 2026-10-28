import test from "node:test";
import assert from "node:assert/strict";
import { classify, isAllowedName, isManagedContainer, stripVersion, validateCreate } from "./policy.mjs";

/**
 * Политика проверяется без Docker: это и есть её смысл. Тело `create` в фикстуре — то, что
 * действительно присылает `docker run` из sandbox/docker/args.ts (плюс пустые структуры, которые
 * CLI отправляет всегда: RestartPolicy и LogConfig).
 */
const policy = {
  image: "node:22-bookworm",
  sandboxRoot: "/var/lib/webnestdev/sandboxes",
  realRoot: "/var/lib/webnestdev/sandboxes",
  // В тестах путей на диске нет: реальный путь совпадает со строкой. Проверка самого realpath —
  // отдельным тестом ниже, с подставным резолвером.
  realpath: value => value,
  isPreviewNetwork: name => name === "webnestdev-preview",
};

function createBody(overrides = {}) {
  return {
    Hostname: "",
    Domainname: "",
    User: "1000:1000",
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: ["HOME=/tmp", "CI=1"],
    Cmd: ["/bin/sh", "-lc", "npm test"],
    Image: "node:22-bookworm",
    Volumes: null,
    WorkingDir: "/workspace",
    Entrypoint: null,
    OnBuild: null,
    Labels: { "webnestdev.job": "1" },
    HostConfig: {
      Binds: ["/var/lib/webnestdev/sandboxes/proj-1:/workspace"],
      NetworkMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,size=256m" },
      Memory: 1073741824,
      NanoCpus: 1000000000,
      PidsLimit: 128,
      AutoRemove: true,
      Init: true,
      RestartPolicy: { Name: "", MaximumRetryCount: 0 },
      LogConfig: { Type: "", Config: {} },
    },
    NetworkingConfig: {},
    ...overrides,
  };
}

const withHost = (patch, rest = {}) => createBody({ HostConfig: { ...createBody().HostConfig, ...patch }, ...rest });

test("снимает префикс версии API", () => {
  assert.equal(stripVersion("/v1.45/containers/json"), "/containers/json");
  assert.equal(stripVersion("/containers/json"), "/containers/json");
});

test("classify пропускает операции платформы", () => {
  assert.equal(classify("GET", "/_ping").kind, "proxy");
  assert.equal(classify("GET", "/v1.45/version").kind, "proxy");
  assert.equal(classify("GET", "/_webnestdev/self").kind, "self");
  assert.equal(classify("GET", "/containers/json?all=1").kind, "containers-list");
  assert.equal(classify("POST", "/containers/create?name=wnd-cmd-1-abcd").kind, "container-create");
  assert.deepEqual(classify("DELETE", "/containers/abc?force=1"), { kind: "container", action: "delete", id: "abc" });
  assert.deepEqual(classify("GET", "/containers/abc/json"), { kind: "container", action: "inspect", id: "abc" });
  assert.deepEqual(classify("POST", "/containers/abc/attach?stream=1"), { kind: "container", action: "attach", id: "abc" });
  assert.deepEqual(classify("GET", "/containers/abc/logs?tail=120"), { kind: "container", action: "logs", id: "abc" });
  assert.deepEqual(classify("POST", "/exec/exec-1/start"), { kind: "exec-start", id: "exec-1" });
  assert.deepEqual(classify("GET", "/networks/webnestdev-preview"), { kind: "network", action: "inspect", id: "webnestdev-preview" });
  assert.deepEqual(classify("POST", "/networks/webnestdev-preview/connect"), { kind: "network", action: "connect", id: "webnestdev-preview" });
  assert.equal(classify("GET", "/system/df").kind, "system-df");
  assert.equal(classify("POST", "/build/prune?-a=1").kind, "prune");
  assert.equal(classify("GET", "/images/json").kind, "images-list");
  assert.deepEqual(classify("GET", "/images/node%3A22-bookworm/json"), { kind: "image", name: "node:22-bookworm" });
});

test("classify закрывает всё остальное", () => {
  for (const [method, path] of [
    ["POST", "/images/create"],
    ["POST", "/build"],
    ["GET", "/volumes"],
    ["POST", "/volumes/create"],
    ["GET", "/secrets"],
    ["GET", "/containers/abc/archive"],
    ["POST", "/containers/abc/stop"],
    ["POST", "/exec/exec-1/resize"],
    ["POST", "/networks/create"],
    ["POST", "/swarm/init"],
    ["GET", "/info"],
  ]) {
    const decision = classify(method, path);
    assert.equal(decision.kind, "deny", method + " " + path + " должен быть запрещён");
    assert.equal(decision.status, 403);
  }
});

test("тело create платформы проходит проверку", () => {
  assert.deepEqual(validateCreate(createBody(), policy), { ok: true });
});

test("create с сетью предпросмотра и монтированием секретов проходит", () => {
  const body = withHost({
    NetworkMode: "webnestdev-preview",
    Binds: [
      "/var/lib/webnestdev/sandboxes/proj-1:/workspace",
      "/var/lib/webnestdev/sandboxes/.secret-runtime/proj-1/.env.local:/workspace/.env.local:ro",
    ],
  });
  assert.deepEqual(validateCreate(body, policy), { ok: true });
});

test("NetworkingConfig той же разрешённой сети проходит: так CLI присылает --network", () => {
  const preview = withHost(
    { NetworkMode: "webnestdev-preview" },
    { NetworkingConfig: { EndpointsConfig: { "webnestdev-preview": {} } } },
  );
  assert.deepEqual(validateCreate(preview, policy), { ok: true });
  const none = withHost({ NetworkMode: "none" }, { NetworkingConfig: { EndpointsConfig: { none: {} } } });
  assert.deepEqual(validateCreate(none, policy), { ok: true });
});

test("проба без -e и -w проходит: Env null и пустой WorkingDir — дефолты Docker", () => {
  assert.deepEqual(validateCreate(createBody({ Env: null, WorkingDir: "" }), policy), { ok: true });
  assert.deepEqual(validateCreate(createBody({ Env: undefined }), policy), { ok: true });
});

test("create выходит за песочницу — отказ", () => {
  const cases = [
    ["privileged", withHost({ Privileged: true })],
    ["добавление capabilities", withHost({ CapAdd: ["SYS_ADMIN"] })],
    ["без --cap-drop ALL", withHost({ CapDrop: [] })],
    ["другой SecurityOpt", withHost({ SecurityOpt: ["seccomp=unconfined"] })],
    ["корень не read-only", withHost({ ReadonlyRootfs: false })],
    ["сеть host", withHost({ NetworkMode: "host" })],
    ["сеть базы", withHost({ NetworkMode: "src_webnestdev" })],
    ["сеть чужого контейнера", withHost({ NetworkMode: "container:postgres" })],
    ["монтирование /", withHost({ Binds: ["/:/host"] })],
    ["монтирование чужих данных", withHost({ Binds: ["/var/lib/webnestdev/secrets:/workspace/secrets:ro"] })],
    ["монтирование вне каталога песочниц", withHost({ Binds: ["/etc:/workspace/etc:ro"] })],
    ["монтирование в /etc контейнера", withHost({ Binds: ["/var/lib/webnestdev/sandboxes/p1:/etc"] })],
    ["«..» в пути", withHost({ Binds: ["/var/lib/webnestdev/sandboxes/../secrets:/workspace/x:ro"] })],
    ["публикация портов", withHost({ PortBindings: { "3000/tcp": [{ HostPort: "3000" }] } })],
    ["автоперезапуск", withHost({ RestartPolicy: { Name: "always", MaximumRetryCount: 0 } })],
    ["драйвер логов на чужой сервер", withHost({ LogConfig: { Type: "syslog", Config: {} } })],
    ["устройства", withHost({ Devices: [{ PathOnHost: "/dev/kmsg" }] })],
    ["PID хоста", withHost({ PidMode: "host" })],
    ["тома хоста", withHost({ VolumesFrom: ["postgres"] })],
    ["DNS", withHost({ Dns: ["8.8.8.8"] })],
    ["/etc/hosts", withHost({ ExtraHosts: ["db:10.0.0.1"] })],
    ["tmpfs вне /tmp", withHost({ Tmpfs: { "/etc": "rw,nosuid,size=1m" } })],
    ["tmpfs без nosuid", withHost({ Tmpfs: { "/tmp": "rw,size=1m" } })],
    ["VolumeOptions", withHost({ Mounts: [{ Type: "volume", Source: "v", Target: "/workspace/v" }] })],
    ["BindOptions", withHost({ Mounts: [{ Type: "bind", Source: "/var/lib/webnestdev/sandboxes/p1", Target: "/workspace", BindOptions: { Propagation: "rshared" } }] })],
    ["секреты предпросмотра с записью", withHost({ Binds: ["/var/lib/webnestdev/sandboxes/.secret-runtime/p1/.env.local:/workspace/.env.local"] })],
    ["неизвестное поле", withHost({ Hostname: "evil" })],
    ["Memory = 0", withHost({ Memory: 0 })],
    ["Memory больше 4 ГБ", withHost({ Memory: 8 * 1024 ** 3 })],
    ["Cpu больше 4", withHost({ NanoCpus: 8_000_000_000 })],
    ["PidsLimit больше 512", withHost({ PidsLimit: 4096 })],
    ["корень контейнера от root", createBody({ User: "0" })],
    ["рабочий каталог вне /workspace", createBody({ WorkingDir: "/" })],
    ["Env не массив строк", createBody({ Env: "HOME=/tmp" })],
    ["чужой образ", createBody({ Image: "alpine" })],
    ["Healthcheck", createBody({ Healthcheck: { Test: ["CMD", "true"] } })],
    ["EndpointsConfig", createBody({ NetworkingConfig: { EndpointsConfig: { webnestdev: {} } } })],
    ["EndpointsConfig с сетью, не совпадающей с NetworkMode", withHost(
      { NetworkMode: "webnestdev-preview" },
      { NetworkingConfig: { EndpointsConfig: { bridge: {} } } },
    )],
    ["NetworkingConfig с alias", withHost(
      { NetworkMode: "webnestdev-preview" },
      { NetworkingConfig: { EndpointsConfig: { "webnestdev-preview": { Aliases: ["postgres"] } } } },
    )],
    ["NetworkingConfig с IPAM", withHost(
      { NetworkMode: "webnestdev-preview" },
      { NetworkingConfig: { EndpointsConfig: { "webnestdev-preview": { IPAMConfig: { IPv4Address: "10.0.0.2" } } } } },
    )],
    ["NetworkingConfig с двумя сетями", withHost(
      { NetworkMode: "webnestdev-preview" },
      { NetworkingConfig: { EndpointsConfig: { "webnestdev-preview": {}, bridge: {} } } },
    )],
    ["неизвестное поле контейнера", { ...createBody(), SomethingNew: { a: 1 } }],
  ];
  for (const [name, body] of cases) {
    const verdict = validateCreate(body, policy);
    assert.equal(verdict.ok, false, "должно быть запрещено: " + name);
    assert.ok(verdict.message.length > 0);
  }
});

test("корень песочниц разрешён: его монтирует проверка путей", () => {
  const body = withHost({ Binds: ["/var/lib/webnestdev/sandboxes:/workspace"] });
  assert.deepEqual(validateCreate(body, policy), { ok: true });
});

test("символическая ссылка за пределы каталога песочниц запрещена", () => {
  const escaping = { ...policy, realpath: () => "/etc" };
  const body = withHost({ Binds: ["/var/lib/webnestdev/sandboxes/proj-1:/workspace"] });
  const verdict = validateCreate(body, escaping);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /за пределы/i);
});

test("несуществующий источник монтирования отклоняется, а не создаётся Docker", () => {
  const missing = { ...policy, realpath: () => { throw new Error("ENOENT"); } };
  const body = withHost({ Binds: ["/var/lib/webnestdev/sandboxes/nope:/workspace"] });
  const verdict = validateCreate(body, missing);
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /не существует/i);
});

test("своим считается контейнер с меткой платформы или нашим именем", () => {
  assert.equal(isManagedContainer({ Name: "/wnd-job-1-abcd", Config: { Labels: {} } }), true);
  assert.equal(isManagedContainer({ Name: "/wnd-preview-proj", Config: { Labels: {} } }), true);
  assert.equal(isManagedContainer({ Name: "/abc", Config: { Labels: { "webnestdev.preview": "p1" } } }), true);
  assert.equal(isManagedContainer({ Name: "/postgres", Config: { Labels: {} } }), false);
  assert.equal(isManagedContainer({ Name: "/src-webnestdev-server-1", Config: { Labels: { "com.docker.compose.service": "webnestdev-server" } } }), false);
  assert.equal(isManagedContainer(null), false);
});

test("имена контейнеров ограничены нашим префиксом", () => {
  assert.equal(isAllowedName("wnd-cmd-p1-abcd1234"), true);
  assert.equal(isAllowedName(""), true);
  assert.equal(isAllowedName("postgres"), false);
  assert.equal(isAllowedName("wnd-"), false);
});
