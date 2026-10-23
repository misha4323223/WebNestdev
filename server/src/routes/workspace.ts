import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readdir,readFile,stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { requireProjectUser } from "../auth/auth.js";
import { getSandbox } from "../sandbox-manager.js";
import { assertRegularFile,resolveInsideSandbox,writeFileInside } from "../sandbox/path-guard.js";
import { openDirsForSandbox,openFileForSandbox } from "../sandbox/permissions.js";
import { runInSandbox } from "../sandbox-worker.js";
import { dockerMissing } from "../sandbox/docker/unavailable.js";
import { isSecretProjectPath, secretEnvRefusal } from "../secrets/secret-paths.js";
import { getProject } from "../project-store.js";
import { archiveFolderName,zipProject } from "../storage/zip.js";
import { refreshStaticPreview } from "../preview/static-preview.js";
import { applyNoStoreToReply } from "./cache-headers.js";
import { recordStorageMutation } from "../account/storage-quota.js";

const MAX_FILE_BYTES=Number(process.env.WORKSPACE_MAX_FILE_BYTES??2_000_000);
const MAX_DIRECTORY_ENTRIES=Number(process.env.WORKSPACE_MAX_DIRECTORY_ENTRIES??2_000);
// Uploads arrive as base64 inside a JSON body, and the API body limit is 2 MB, so
// the decoded ceiling stays well below it.
const MAX_UPLOAD_BYTES=Number(process.env.WORKSPACE_MAX_UPLOAD_BYTES??1_200_000);
/** Сколько текста редактор панели сохраняет за один раз; тело запроса целиком — до 2 МБ. */
const MAX_EDIT_BYTES=1_000_000;
const UPLOAD_FOLDER="uploads";
/**
 * Служебные папки, которые редактор не трогает: в `.git` лежит история проекта, и запись туда
 * руками ломает репозиторий, а `node_modules` — чужие пакеты, а не исходники.
 */
const LOCKED_PATH=/(^|\/)(\.git|node_modules)(\/|$)/;

/** Двоичный файл: в нём есть нулевой байт, и текстовый редактор испортит его при сохранении. */
function looksBinary(bytes:Buffer){
  return bytes.subarray(0,8000).includes(0);
}
/** Папка снимков проверок: единственное, что отдаёт маршрут `/screenshot`. */
const SCREENSHOT_PREFIX=".webnestdev/screenshots/";

export async function registerWorkspaceRoutes(app:FastifyInstance){
  app.get("/api/projects/:id/files",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const q=z.object({path:z.string().max(2000).default(".")}).parse(request.query);
    const sandbox=await getSandbox(p.id,user.id);
    const dir=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,q.path));
    const entries=await readdir(dir,{withFileTypes:true});
    if(entries.length>MAX_DIRECTORY_ENTRIES)throw new Error("В папке слишком много файлов");
    // Панель «Файлы» — это ещё один читатель рабочей области. Секретные env-файлы не
    // показываются в ней даже именем: значения правятся только в разделе «Секреты».
    applyNoStoreToReply(reply);
    return {path:q.path,files:entries
      .filter(e=>!isSecretProjectPath(e.name))
      .map(e=>({name:e.name,type:e.isDirectory()?"directory":e.isFile()?"file":"other"}))
      .filter(e=>e.type!=="other")};
  });

  app.get("/api/projects/:id/file",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const q=z.object({path:z.string().min(1).max(2000)}).parse(request.query);
    applyNoStoreToReply(reply);
    // Прямой запрос файла не должен обходить запрет инструментов агента: тот же basename,
    // то же правило. 403, а не 404: файл существует, но этот маршрут его не отдаёт.
    if(isSecretProjectPath(q.path))return reply.code(403).send({error:secretEnvRefusal(q.path)});
    const sandbox=await getSandbox(p.id,user.id);
    const file=await assertRegularFile(sandbox.root,path.join(sandbox.root,q.path));
    const info=await stat(file);
    if(info.size>MAX_FILE_BYTES)throw new Error("Файл слишком большой, чтобы открыть его в рабочей области");
    const bytes=await readFile(file);
    // Двоичный файл панель показывает как «не редактируется», а не как мусор из символов:
    // правка такого файла текстом — это испорченная картинка, а не сохранение.
    if(looksBinary(bytes))return {path:q.path,content:"",binary:true};
    return {path:q.path,content:bytes.toString("utf8")};
  });

  /**
   * Прямое редактирование: панель «Файлы» сохраняет текст в файл проекта без участия модели.
   * Правка уходит в то же место, где лежит файл: агент видит её в следующем запуске, предпросмотр —
   * сразу (dev-сервер подхватывает сам, статическая сборка пересобирается).
   *
   * Секретные env-файлы и служебные папки закрыты: значения секретов правятся только в разделе
   * «Секреты», а `.git` — это история, а не исходники.
   */
  app.put("/api/projects/:id/file",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const body=z.object({path:z.string().min(1).max(2000),content:z.string().max(MAX_EDIT_BYTES)}).parse(request.body);
    // Сообщение — для человека в панели, а не для агента: значения секретов правятся только в
    // разделе «Секреты», а описывает переменные безопасный шаблон `.env.example`.
    if(isSecretProjectPath(body.path))return reply.code(403).send({error:"Файл «"+body.path+"» содержит секреты проекта: значения меняются в разделе «Секреты», а переменные без значений описывает .env.example."});
    if(LOCKED_PATH.test(body.path))return reply.code(400).send({error:"Служебную папку «"+body.path.split("/").find(part=>part===".git"||part==="node_modules")+"» нельзя редактировать вручную"});
    const sandbox=await getSandbox(p.id,user.id);

    let current:Buffer;
    try{
      const file=await assertRegularFile(sandbox.root,path.join(sandbox.root,body.path));
      current=await readFile(file);
    }catch(error){
      // Файл могли удалить агентом или откатом, пока панель была открыта: это ответ для человека,
      // а не «Внутренняя ошибка сервера».
      const message=error instanceof Error?error.message:String(error);
      const missing=(error as NodeJS.ErrnoException).code==="ENOENT";
      return reply.code(missing?404:400).send({error:missing?"Файла «"+body.path+"» больше нет в проекте — обновите список.":message});
    }
    if(looksBinary(current))return reply.code(400).send({error:"Двоичный файл нельзя править как текст"});

    const written=await writeFileInside(sandbox.root,path.join(sandbox.root,body.path),body.content);
    // Сервер пишет от root, а команды проекта идут от uid 1000: без этого файл после правки
    // стал бы недоступен сборщику и предпросмотру.
    await openDirsForSandbox(sandbox.root,path.dirname(written));
    await openFileForSandbox(written);
    await recordStorageMutation(p.id,user.id).catch(error=>console.warn("[storage] не удалось обновить размер после правки",error));
    await refreshStaticPreview(p.id).catch(error=>console.warn("[preview] предпросмотр не пересобран",error));
    applyNoStoreToReply(reply);
    return {path:body.path,content:body.content,bytes:Buffer.byteLength(body.content)};
  });

  /**
   * Выгрузка проекта архивом. Поток, а не буфер в памяти: архив с картинками и шрифтами
   * весит десятки мегабайт, и собирать его целиком ради одного скачивания незачем.
   * Зависимости и `.git` в архив не попадают — это не исходники проекта.
   */
  app.get("/api/projects/:id/export",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const sandbox=await getSandbox(p.id,user.id);
    const project=await getProject(p.id).catch(()=>null);
    const folder=archiveFolderName(project?.name??"project");
    const file=folder+".zip";
    const ascii=folder.replace(/[^\x20-\x7e]/g,"_")+".zip";
    applyNoStoreToReply(reply);
    reply.header("content-type","application/zip");
    // `filename*` — UTF-8 имя: без него русское название проекта превращалось в «_.zip».
    reply.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file)}`);
    return reply.send(Readable.from(zipProject(sandbox.root,folder)));
  });

  /**
   * Stores a file the user attached in the chat composer inside the project, so the
   * agent can use it as project material. Names are reduced to a safe basename and
   * the upload lives in its own folder to keep it apart from generated sources.
   */
  app.post("/api/projects/:id/upload",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const body=z.object({name:z.string().min(1).max(300),data:z.string().min(1).max(1_700_000)}).parse(request.body);
    const bytes=Buffer.from(body.data,"base64");
    if(!bytes.length)throw new Error("Пустой файл");
    if(bytes.length>MAX_UPLOAD_BYTES)throw new Error("Файл больше "+Math.round(MAX_UPLOAD_BYTES/1000)+" КБ");
    const base=(body.name.split(/[\\/]/).pop()??"file").replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^[.-]+/,"").slice(0,120)||"file";
    const sandbox=await getSandbox(p.id,user.id);
    const relative=UPLOAD_FOLDER+"/"+Date.now().toString(36)+"-"+base;
    await writeFileInside(sandbox.root,path.join(sandbox.root,relative),bytes);
    // Загрузка — это запись в проект: без пересчёта квота не видела её до следующей задачи
    // агента, и место в настройках оставалось старым. Ошибка учёта не отменяет загрузку.
    await recordStorageMutation(p.id,user.id).catch(error=>console.warn("[storage] не удалось обновить размер после загрузки",error));
    return {name:base,path:relative,bytes:bytes.length};
  });

  /**
   * Снимок проверки: PNG лежит в служебной папке проекта (`.webnestdev/screenshots/`, она вне
   * истории), а открывается по этому адресу — человек видит ту же картинку, что снял инструмент.
   * Маршрут отдаёт только эту папку: иначе он стал бы способом прочитать любой файл мимо просмотра.
   */
  app.get("/api/projects/:id/screenshot",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const q=z.object({path:z.string().min(1).max(500)}).parse(request.query);
    if(!q.path.startsWith(SCREENSHOT_PREFIX))return reply.code(400).send({error:"Этот маршрут отдаёт только снимки проверок"});
    const sandbox=await getSandbox(p.id,user.id);
    const file=await assertRegularFile(sandbox.root,path.join(sandbox.root,q.path));
    const png=await readFile(file);
    applyNoStoreToReply(reply);
    return reply.type("image/png").send(png);
  });

  app.post("/api/projects/:id/terminal",async(request,reply)=>{
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const user=await requireProjectUser(request,reply,p.id);
    if(!user)return;
    const body=z.object({command:z.string().min(1).max(20000),cwd:z.string().max(2000).optional()}).parse(request.body);
    try{
      const sandbox=await getSandbox(p.id,user.id);
      // Рабочая папка проверяется в том же try: `cd` в несуществующую папку — это ответ для
      // пользователя («такой папки нет»), а не «Внутренняя ошибка сервера».
      const cwd=await resolveInsideSandbox(sandbox.root,path.join(sandbox.root,body.cwd??"."));
      // Терминал панели — тоже команда: `.env.local` в нём виден по пути, но пуст.
      return await runInSandbox(sandbox,body.command,cwd,{maskSecretEnvFiles:true});
    }catch(error){
      // Команда, которая не запустилась вообще, — это диагностика для того, кто её набрал:
      // «Внутренняя ошибка сервера» не отличима от сломанного проекта. Хост без Docker и очередь
      // песочницы — 503 (как их и описывает лимитер), остальное — 400 с причиной, как в предпросмотре.
      const message=error instanceof Error?error.message:String(error);
      const carried=(error as {statusCode?:unknown}).statusCode;
      const status=typeof carried==="number"&&carried>=400&&carried<600?carried:dockerMissing(error)?503:400;
      const missingFolder=(error as NodeJS.ErrnoException).code==="ENOENT"&&!dockerMissing(error);
      return reply.code(status).send({error:missingFolder?"Папки «"+(body.cwd??".")+"» нет в проекте — проверьте путь.":message});
    }
  });
}