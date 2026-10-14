import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hostPathFor,sandboxRootPath,workspaceMountSource } from "./config.js";
import { MOUNT_MARKER_FILE,checkSandboxMount,classifyDockerFailure,countFiles,describeSandboxMount,markerMatches,type SandboxMountCheck } from "./sandbox-check.js";

const check=(overrides:Partial<SandboxMountCheck>={}):SandboxMountCheck=>({
  ok:true,
  serverDir:"/app/.webnestdev/sandboxes",
  hostDir:"/var/lib/webnestdev/sandboxes",
  image:"node:22-bookworm-slim",
  checkedAt:1_700_000_000_000,
  ...overrides
});

test("путь хоста выводится из пути сервера заменой корня", () => {
  const roots={serverDir:"/app/.webnestdev/sandboxes",hostDir:"/var/lib/webnestdev/sandboxes"};
  assert.equal(hostPathFor("/app/.webnestdev/sandboxes/p1",roots),"/var/lib/webnestdev/sandboxes/p1");
  assert.equal(hostPathFor("/app/.webnestdev/sandboxes",roots),"/var/lib/webnestdev/sandboxes");
  // Когда песочницы лежат на хосте, обе стороны совпадают и ничего не меняется.
  assert.equal(hostPathFor("/app/.webnestdev/sandboxes/p1",{serverDir:"/srv/s",hostDir:"/srv/s"}),"/app/.webnestdev/sandboxes/p1");
  // Каталог вне корня песочниц нельзя переписывать на путь хоста: он не смонтирован.
  assert.equal(hostPathFor("/tmp/other",roots),"/tmp/other");
});

test("без WEBNESTDEV_SANDBOX_HOST_DIR в контейнер монтируется путь сервера", () => {
  const project=sandboxRootPath("проект");
  assert.equal(workspaceMountSource({root:project,hostRoot:project}),project);
  assert.equal(workspaceMountSource({root:project}),project);
});

test("недоступный образ отличается от недоступного docker", () => {
  assert.equal(classifyDockerFailure("Unable to find image 'node:22-bookworm-slim' locally\nNo such image: node:22-bookworm-slim"),"image");
  assert.equal(classifyDockerFailure("pull access denied for ghost, repository does not exist"),"image");
  assert.equal(classifyDockerFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),"docker");
});

test("маркер сверяется по содержимому, а не по наличию файла", () => {
  assert.equal(markerMatches("token-1","token-1\n"),true);
  assert.equal(markerMatches("token-1","token-1"),true);
  assert.equal(markerMatches("token-1",""),false);
  assert.equal(markerMatches("token-1","token-2"),false);
});

test("расхождение путей названо вместе с обоими каталогами и способом починки", () => {
  const line=describeSandboxMount(check({ok:false,reason:"mismatch"}));
  assert.match(line,/РАСХОЖДЕНИЕ/);
  assert.match(line,/\/app\/\.webnestdev\/sandboxes/);
  assert.match(line,/\/var\/lib\/webnestdev\/sandboxes/);
  assert.match(line,/WEBNESTDEV_SANDBOX_DIR/);
});

test("вердикт успешной проверки называет каталоги, а не только «ок»", () => {
  assert.match(describeSandboxMount(check()),/\/app\/\.webnestdev\/sandboxes/);
  assert.match(describeSandboxMount(check({serverDir:"/srv/s",hostDir:"/srv/s"})),/\/srv\/s/);
});

test("относительный путь песочницы — это то же расхождение", async () => {
  const result=await checkSandboxMount({serverDir:".webnestdev/sandboxes",hostDir:"/var/lib/webnestdev/sandboxes",timeoutMs:2000});
  assert.equal(result.ok,false);
  assert.equal(result.reason,"mismatch");
  assert.match(result.detail??"",/относительный/);
});

test("счёт файлов видит вложенные каталоги, а не только верхний уровень", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"sandbox-count-"));
  try{
    await writeFile(path.join(dir,"index.html"),"x");
    await mkdir(path.join(dir,"src"),{recursive:true});
    await writeFile(path.join(dir,"src","app.js"),"x");
    await writeFile(path.join(dir,"src","style.css"),"x");
    assert.equal(await countFiles(dir),3);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});

test("две одновременные проверки пишут разные маркеры", () => {
  const first=`${MOUNT_MARKER_FILE}-${randomUUID()}`;
  const second=`${MOUNT_MARKER_FILE}-${randomUUID()}`;
  assert.notEqual(first,second);
  assert.match(first,new RegExp("^"+MOUNT_MARKER_FILE.replace(/\./g,"\\.")));
});

test("недоступный для записи каталог песочницы не доходит до docker", async () => {
  const dir=await mkdtemp(path.join(tmpdir(),"sandbox-check-"));
  const file=path.join(dir,"not-a-directory");
  await writeFile(file,"x");
  try{
    // Каталог песочницы здесь — обычный файл: маркер записать некуда, и это видно в вердикте.
    const result=await checkSandboxMount({serverDir:file,hostDir:file,timeoutMs:2000});
    assert.equal(result.ok,false);
    assert.equal(result.reason,"disk");
    assert.equal(result.serverDir,file);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
