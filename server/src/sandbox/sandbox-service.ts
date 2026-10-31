import { mkdir, stat } from "node:fs/promises";
import { getProject, reassignProjectNode } from "../project-store.js";
import { chooseProjectNode, isNodeFresh } from "../nodes/placement.js";
import { getNode } from "../nodes/node-store.js";
import { getPreview } from "../preview/preview-store.js";
import { listSandboxJobs } from "./jobs.js";
import { ensureProjectWorkspace, noteProjectAccess } from "../storage/project-archive.js";
import { buildSandboxConfig,sandboxMemoryMb,sandboxRootPath } from "./config.js";
import { SandboxNodeUnavailableError, SharedWorkspaceRequiredError } from "./host.js";
import { nodeId } from "../nodes/identity.js";
import { clearRootOwnedBuildCaches,openDirForSandbox,openGitForSandbox,openTreeForSandbox } from "./permissions.js";
import type { SandboxConfig } from "./sandbox-types.js";

/**
 * Command and preview containers run as uid 1000 while the server writes the project as root, so
 * the project directory is opened to every writer once: without it the containers can read the
 * agent's files but not install packages or rebuild the app inside them.
 *
 * The root alone is not enough — a project with subdirectories (server/, packages/) keeps its
 * files inside those, and a root-owned 755 directory is where a build stops with EPERM. So the
 * existing tree is opened too, once per project per process; every later write by the server
 * reopens what it created (see tools/filesystem-tools.ts).
 */
const opened=new Map<string,Promise<void>>();
/**
 * Кеш «дерево уже открыто» привязан к inode каталога, а не только к пути. Восстановление из
 * холодного яруса заменяет рабочую папку через `rename`: по тому же пути оказывается новый
 * каталог, созданный от root, и кеш по одному пути молча пропустил бы обход — сборка тогда
 * упирается в EPERM на корне проекта.
 */
const openedIno=new Map<string,number>();

function openToSandboxUser(root:string,ino:number){
  if(openedIno.get(root)!==ino){
    openedIno.set(root,ino);
    opened.delete(root);
  }
  const pending=opened.get(root);
  if(pending)return pending;
  const run=openDirForSandbox(root)
    .then(()=>openTreeForSandbox(root))
    // Кеши Vite под node_modules обход дерева пропускает, а именно там старая сборка от root
    // оставляла каталог, в который контейнер уже не мог писать.
    .then(()=>clearRootOwnedBuildCaches(root).then(()=>undefined));
  opened.set(root,run);
  return run;
}

/**
 * Песочница выдаётся только владельцу проекта. `userId` обязателен: необязательный параметр
 * означал, что любой новый маршрут, забывший его передать, получал чужой каталог без проверки.
 * Права проверяются и в маршруте (`requireProjectUser`), и здесь — на случай будущих вызовов.
 */
export async function getSandbox(projectId:string,userId:string):Promise<SandboxConfig>{
  const project=await getProject(projectId);
  if(!project || project.userId!==userId)throw new Error("Проект не найден");
  const root=sandboxRootPath(projectId);
  let node=project.node||nodeId();
  if(node!==nodeId()&&process.env.WEBNESTDEV_SHARED_SANDBOX!=="1"){
    // Check before touching the workspace: restoring a remote project's archive into the API's
    // local disk would be a silent wrong-location write that only appears later on the runner.
    throw new SharedWorkspaceRequiredError(
      node,
      "задайте WEBNESTDEV_SHARED_SANDBOX=1 и смонтируйте один SANDBOX_DIR на API и runner",
    );
  }
  // Отметка для фоновой архивации ставится до восстановления: пока проект скачивается из бакета,
  // планировщик не должен решить, что он всё ещё простаивает, и начать упаковку заново.
  noteProjectAccess(projectId);
  // Проект может лежать в объектном хранилище (холодный ярус): первый доступ ставит
  // восстановление в фон и отвечает 409, поэтому сюда доходят уже после распаковки.
  await ensureProjectWorkspace(projectId,userId);
  if(node!==nodeId()){
    // Never mkdir a remote project's root: an empty directory would hide a missing NFS/shared
    // mount and the runner would see no files while the API happily reports success.
    const mounted=await stat(root).catch(()=>null);
    if(!mounted?.isDirectory()){
      throw new SharedWorkspaceRequiredError(node,"каталог "+root+" не виден на API — проверьте общий mount");
    }
    // Recovery after a lost node is opt-in: a transient heartbeat gap must not move a project
    // with a live preview. The shared workspace makes the file move unnecessary; only the pin
    // changes, and only after we prove no preview/job owns a container on the old node.
    if(process.env.WEBNESTDEV_AUTO_MOVE_PROJECTS==="1"){
      const current=await getNode(node);
      if(!current||current.status==="offline"||!isNodeFresh(current)){
        if(getPreview(projectId)||listSandboxJobs(projectId).length){
          throw new SandboxNodeUnavailableError(
            node,
            "есть активный предпросмотр или задание; остановите их и повторите — автоматический перенос не трогает живые контейнеры",
          );
        }
        const chosen=await chooseProjectNode({requiredMemoryMb:sandboxMemoryMb()});
        const moved=await reassignProjectNode(projectId,userId,chosen.id);
        if(!moved)throw new SandboxNodeUnavailableError(node,"не удалось перенести проект на другой узел");
        console.warn("[sandbox] проект "+projectId+" перенесён с "+node+" на "+chosen.id+" после потери узла");
        node=chosen.id;
        if(node!==nodeId()){
          const target=await stat(root).catch(()=>null);
          if(!target?.isDirectory())throw new SharedWorkspaceRequiredError(node,"каталог "+root+" не виден на API");
        }
      }
    }
  }else{
    await mkdir(root,{recursive:true});
  }
  // inode у восстановленного каталога другой — по нему и снимается устаревший кеш прав.
  const info=await stat(root);
  await openToSandboxUser(root,info.ino);
  // `.git` сервер пишет сам от root после каждого коммита и выгрузки, поэтому открывается не один
  // раз при первом доступе, а перед каждым обращением: иначе `git add`/`git commit` в контейнере
  // снова упираются в `.git/index: Permission denied`.
  await openGitForSandbox(root);
  return buildSandboxConfig(projectId,root,node);
}
