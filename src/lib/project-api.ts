import { apiJson, apiUrl } from "./api";
import { rememberScreen } from "./screen";
import type { ChatMessage, FileEntry, PlanState, PreviewState } from "./types";

export type Project={id:string;name:string;createdAt:string;updatedAt:string};
/** Одна точка истории проекта: коммит, к которому можно вернуться. */
export type ChangeCheckpoint={
  sha:string;
  shortSha:string;
  subject:string;
  message:string;
  kind:"task"|"rollback"|"imported"|"manual";
  createdAt:string;
  runId?:string;
  conversationId?:string;
  revertedTo?:string;
  files:Array<{path:string;status:"added"|"modified"|"deleted"}>;
  filesChanged:number;
  pushed:boolean;
  url?:string;
};
export type ProjectChanges={
  initialized:boolean;
  repository:{provider?:"github"|"gitlab"|"gitverse"|"sourcecraft";connected:boolean;branch:string;remoteUrl:string|null;lastPushAt:string|null;lastPushError:string|null};
  checkpoints:ChangeCheckpoint[];
};
export type Conversation={id:string;projectId:string;title:string;messages:ChatMessage[];plan?:PlanState|null;createdAt:string;updatedAt:string};
/** Переменная окружения проекта: значение намеренно не приходит — только его форма. */
export type ProjectSecret={name:string;preview:string;file:string};
export type ProjectSecrets={file:string;variables:ProjectSecret[]};
/** A row of the chat list: enough to recognise the session without loading its messages. */
export type ConversationSummary={id:string;projectId:string;title:string;label:string;preview:string;messageCount:number;createdAt:string;updatedAt:string};

export const listProjects=()=>apiJson<{projects:Project[]}>("/api/projects");
export const createProject=(name="Новый проект")=>apiJson<Project>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
export const renameProject=(projectId:string,name:string)=>apiJson<Project>("/api/projects/"+projectId,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
export const deleteProject=(projectId:string)=>apiJson<{deleted:boolean}>("/api/projects/"+projectId,{method:"DELETE"});
export const createConversation=(projectId:string,title="Новая сессия")=>apiJson<Conversation>("/api/projects/"+projectId+"/conversations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title})});
/** Deletes one saved chat; the project and its other chats stay. */
export const deleteConversation=(conversationId:string)=>apiJson<{deleted:boolean}>("/api/conversations/"+conversationId,{method:"DELETE"});
export const getConversation=(conversationId:string)=>apiJson<Conversation>("/api/conversations/"+conversationId);
/** The project's saved chats, newest first — the ones the user can return to. */
export const listConversations=(projectId:string)=>apiJson<{conversations:ConversationSummary[]}>("/api/projects/"+projectId+"/conversations");
export const listProjectFiles=(projectId:string,path=".")=>apiJson<{path:string;files:FileEntry[]}>("/api/projects/"+projectId+"/files?path="+encodeURIComponent(path));
/**
 * `binary` — файл не текст: панель показывает «не редактируется», а не портит картинку
 * сохранением строки поверх байтов.
 */
export type ProjectFile={path:string;content:string;binary?:boolean};
export const getProjectFile=(projectId:string,path:string)=>apiJson<ProjectFile>("/api/projects/"+projectId+"/file?path="+encodeURIComponent(path));
/**
 * Адрес картинки проекта: панель «Файлы» показывает её как изображение, а чат — в карточке
 * сгенерированной картинки. Маршрут отдаёт только растровые форматы.
 */
export const projectAssetUrl=(projectId:string,path:string)=>apiUrl("/api/projects/"+projectId+"/asset?path="+encodeURIComponent(path));
/** Прямое редактирование файла из панели: правка уходит в проект без запуска агента. */
export const saveProjectFile=(projectId:string,path:string,content:string)=>apiJson<{path:string;content:string;bytes:number}>(
  "/api/projects/"+projectId+"/file",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({path,content})});
/**
 * Выгрузка проекта архивом. Скачивание идёт через `fetch`, а не ссылкой: так ошибка сервера
 * (нет прав, проект в архиве) показывается в панели, а не белой страницей вместо приложения.
 */
export async function downloadProjectZip(projectId:string,projectName:string){
  let response:Response;
  try{
    response=await fetch(apiUrl("/api/projects/"+projectId+"/export"),{credentials:"include"});
  }catch(error){
    throw new Error("Не удалось подключиться к NestDev API: "+(error instanceof Error?error.message:String(error)));
  }
  if(!response.ok){
    const data=await response.json().catch(()=>null) as {error?:string}|null;
    throw new Error(data?.error??("HTTP "+response.status));
  }
  const blob=await response.blob();
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  const name=(projectName||"project").replace(/[\\/:*?"<>|]+/g,"-").trim()||"project";
  link.href=url;
  link.download=name+".zip";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // URL живёт до следующей вкладки: отзывать его сразу после click() в Safari нельзя —
  // скачивание отменялось на пустом месте.
  window.setTimeout(()=>URL.revokeObjectURL(url),10000);
}
/** Stores a chat attachment inside the project so the agent can use it. */
export const uploadProjectFile=(projectId:string,file:{name:string;data:string})=>apiJson<{name:string;path:string;bytes:number}>("/api/projects/"+projectId+"/upload",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(file)});
/** Одна задача проекта из TASKS.md: `line` — строка файла, по ней панель меняет пункт. */
export type ProjectTask={
  line:number;
  title:string;
  done:boolean;
  section:string|null;
  depth:number;
};
/** `revision` — хеш TASKS.md: устаревшая панель получает конфликт, а не затирает правку агента. */
export type ProjectTasks={
  file:string;
  exists:boolean;
  revision:string;
  markdown:string;
  tasks:ProjectTask[];
  total:number;
  done:number;
};
export type ProjectTaskInput={title:string;section?:string;done?:boolean};
export const getProjectTasks=(projectId:string)=>apiJson<ProjectTasks>("/api/projects/"+projectId+"/tasks");
/** Добавляет пункты; сервер сам пропускает дубли и возвращает, сколько добавил и сколько уже было. */
export const addProjectTasks=(projectId:string,body:{items:ProjectTaskInput[];section?:string;revision?:string})=>apiJson<ProjectTasks&{added:number;skipped:number}>(
  "/api/projects/"+projectId+"/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
export const toggleProjectTask=(projectId:string,body:{line:number;done:boolean;revision:string})=>apiJson<ProjectTasks>(
  "/api/projects/"+projectId+"/tasks",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({op:"toggle",...body})});
export const removeProjectTask=(projectId:string,body:{line:number;revision:string})=>apiJson<ProjectTasks>(
  "/api/projects/"+projectId+"/tasks",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({op:"remove",...body})});

/** История задач проекта: каждая точка — проверенное состояние, к которому можно вернуться. */
export const getProjectChanges=(projectId:string)=>apiJson<ProjectChanges>("/api/projects/"+projectId+"/changes");
/**
 * Откат создаёт новую точку, а не переписывает историю. На GitHub ничего не уходит: отправку
 * пользователь запускает сам кнопкой — агент коммиты не пушит.
 */
export const rollbackProjectChanges=(projectId:string,sha:string)=>apiJson<{checkpoint:ChangeCheckpoint;branch:string;pushed:boolean;overview:ProjectChanges}>("/api/projects/"+projectId+"/changes/"+encodeURIComponent(sha)+"/rollback",{method:"POST"});
/**
 * Выгрузка из GitHub: забирает ветку в проект, когда отправлять было нечего. Fast-forward:
 * если в проекте есть неотправленные точки, сервер честно откажет вместо перезаписи работы.
 */
export const pullProjectChanges=(projectId:string)=>apiJson<{pulled:boolean;branch:string;at:string;sha?:string;changed?:number;error?:string;overview:ProjectChanges}>("/api/projects/"+projectId+"/changes/pull",{method:"POST"});
/**
 * Ветки проекта для выбора в шапке. `pushed` — локальная ветка совпадает с последней
 * отправленной точкой; `remote` — ветка уже есть на GitHub.
 */
export type RepositoryBranch={name:string;current:boolean;remote:boolean;pushed:boolean};
export type ProjectBranches={initialized:boolean;current:string;branches:RepositoryBranch[]};
export const listProjectBranches=(projectId:string)=>apiJson<ProjectBranches>("/api/projects/"+projectId+"/changes/branches");
/** Рабочие изменения: то, что ещё не стало точкой истории. */
export type WorktreeFile={path:string;status:"added"|"modified"|"deleted";additions?:number;deletions?:number};
export type ProjectWorktree={initialized:boolean;branch:string;files:WorktreeFile[];additions?:number;deletions?:number};
export type ProjectFileDiff={path:string;status:"added"|"modified"|"deleted";patch:string;additions?:number;deletions?:number;binary?:boolean;truncated?:boolean};
export const getProjectWorktree=(projectId:string)=>apiJson<ProjectWorktree>("/api/projects/"+projectId+"/changes/worktree");
/** Diff файла — из рабочего дерева или из коммита истории. */
export const getProjectDiff=(projectId:string,path:string,sha?:string)=>apiJson<ProjectFileDiff>(
  "/api/projects/"+projectId+"/changes/diff?path="+encodeURIComponent(path)+(sha?"&sha="+encodeURIComponent(sha):""));
/**
 * Ручной коммит из Git-панели: выбранные файлы и сообщение. `push` — единственный путь, которым
 * этот коммит попадает в репозиторий, и включает его только пользователь.
 */
export const commitProjectWorktree=(projectId:string,body:{message:string;paths?:string[];push?:boolean})=>apiJson<{
  checkpoint:ChangeCheckpoint;branch:string;pushed:boolean;pushError?:string;overview:ProjectChanges;
}>("/api/projects/"+projectId+"/changes/commit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
/** Новая ветка от текущего HEAD: рабочее дерево не меняется. */
export const createProjectBranch=(projectId:string,name:string)=>apiJson<{created:boolean;branch:string;overview:ProjectChanges}>(
  "/api/projects/"+projectId+"/changes/branches",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
/** Переключение ветки: следующая отправка уйдёт в выбранную ветку. */
export const switchProjectBranch=(projectId:string,branch:string)=>apiJson<{switched:boolean;branch:string;error?:string;overview:ProjectChanges}>(
  "/api/projects/"+projectId+"/changes/branches/switch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({branch})});
/** Отправка на GitHub по кнопке — единственный путь, которым коммиты попадают в ветку. */
export const pushProjectChanges=(projectId:string)=>apiJson<{pushed:boolean;branch:string;at:string}>("/api/projects/"+projectId+"/changes/push",{method:"POST"});
/**
 * Палитра проекта: переменные, которые он объявил сам (контрактные `--color-…` у нового проекта,
 * свои `--bg`/`--ink` у проекта постарше). `fields` приходит с сервера — подписи, допустимые
 * значения, порядок, файл каждой переменной и читает ли её страница.
 */
export type ThemeField={
  variable:string;
  label:string;
  kind:"color"|"font"|"radius"|"length"|"weight"|"number";
  value:string;
  options?:Array<{value:string;label:string}>;
  /** Файл проекта, где переменная объявлена: туда же уходит правка. */
  file?:string;
  /** Читает ли страница переменную через `var(--…)`. */
  used?:boolean;
};
/**
 * `used` — читается ли палитра страницей хотя бы одной переменной. Без этого палитра молча
 * «сохраняется» и ничего не перекрашивает, а причина видна только в коде проекта.
 */
export type ProjectTheme={present:boolean;file:string|null;themeFile?:string|null;tokens:Record<string,string>;fields:ThemeField[];used:boolean};
export const getProjectTheme=(projectId:string)=>apiJson<ProjectTheme>("/api/projects/"+projectId+"/theme");
/**
 * Создание палитры для проекта, где цвета вписаны в стили напрямую: сервер собирает токены из
 * фактических цветов страницы и заменяет совпавшие литералы на `var(--color-…)`. Панель зовёт
 * это сама при открытии; `reason` объясняет отказ, когда цветов в стилях не нашлось.
 */
export const createProjectTheme=(projectId:string)=>apiJson<ProjectTheme&{created:boolean;reason?:string}>(
  "/api/projects/"+projectId+"/theme",{method:"POST"});
export const saveProjectTheme=(projectId:string,tokens:Record<string,string>)=>apiJson<ProjectTheme>("/api/projects/"+projectId+"/theme",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({tokens})});

export const getPreviewStatus=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/status");
export const startPreview=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/start",{method:"POST"});
export const stopPreview=(projectId:string)=>apiJson<{stopped:boolean}>("/api/projects/"+projectId+"/preview/stop",{method:"POST"});
export const getPreviewLogs=(projectId:string)=>apiJson<{running:boolean;logs:string}>("/api/projects/"+projectId+"/preview/logs");
/**
 * Билет на публичный адрес предпросмотра: адрес открывается в отдельной вкладке без cookie панели,
 * поэтому панель просит ссылку с билетом — она живёт ограниченное время и открывает один проект.
 */
export const requestPreviewTicket=(projectId:string)=>apiJson<{baseUrl:string;url:string;expiresAt:number;param:string}>("/api/projects/"+projectId+"/preview/ticket",{method:"POST"});
/** Heartbeat: while the panel is open and visible the preview counts as used, so the idle sweeper leaves it running. */
export const touchPreview=(projectId:string)=>apiJson<{ok:boolean}>("/api/projects/"+projectId+"/preview/touch",{method:"POST"});
/**
 * Makes the given project the active workspace and reloads the app into it.
 * Used by GitHub imports, which hand back an already created project.
 */
export function openImportedProject(projectId:string,conversationId:string){
  localStorage.setItem("webnestdev.projectId",projectId);
  localStorage.setItem("webnestdev.conversationId",conversationId);
  localStorage.removeItem("webnestdev.projectName");
  localStorage.setItem("webnestdev.openWorkspace","1");
  // Импорт открывает рабочую область и после следующей перезагрузки тоже: иначе F5 снова
  // выбрасывал на главную, хотя openWorkspace — одноразовый флаг и после монтирования стирается.
  rememberScreen("workspace");
  window.location.reload();
}

/**
 * Секреты проекта: пользователь сам добавляет пары KEY=value, сервер хранит их зашифрованными
 * вне рабочей области и монтирует в предпросмотр как `.env.local`. Значения не возвращаются в
 * браузер — в списке только имя, форма и файл сохранённого значения.
 */
export const listProjectSecrets=(projectId:string)=>apiJson<ProjectSecrets>("/api/projects/"+projectId+"/secrets");
export const saveProjectSecrets=(projectId:string,variables:Record<string,string>,file?:string)=>apiJson<ProjectSecrets>(
  "/api/projects/"+projectId+"/secrets",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({variables,...(file?{file}:{})})});
export const importProjectSecrets=(projectId:string,env:string,file?:string)=>apiJson<ProjectSecrets>(
  "/api/projects/"+projectId+"/secrets",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({env,...(file?{file}:{})})});
export const deleteProjectSecret=(projectId:string,name:string,file?:string)=>apiJson<ProjectSecrets&{deleted:boolean}>(
  "/api/projects/"+projectId+"/secrets/"+encodeURIComponent(name)+(file?"?file="+encodeURIComponent(file):""),{method:"DELETE"});

/**
 * Незакрытый запрос ключа: окно возвращается в чат после перезагрузки. Значения здесь нет —
 * `waiting:false` означает, что запуск уже остановлен и после сохранения нужно нажать «Продолжить».
 */
export type PendingProjectSecret={id:string;variable:string;purpose:string;file:string;createdAt:number;expiresAt:number;waiting:boolean};
export const listPendingProjectSecrets=(projectId:string,conversationId:string)=>apiJson<{requests:PendingProjectSecret[]}>(
  "/api/projects/"+projectId+"/secrets/pending?conversationId="+encodeURIComponent(conversationId));

/**
 * Значение ключа, введённое в модальном окне. Оно идёт прямо в песочницу проекта и возвращается
 * только подтверждением: ни в переписку, ни в события запуска, ни в ответы модели оно не попадает.
 */
export const submitProjectSecret=(projectId:string,requestId:string,value:string)=>apiJson<{ok:boolean;variable:string;file:string;delivered:boolean}>
  ("/api/projects/"+projectId+"/secrets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestId,value})});/** Отмена запроса: агент получает отказ и продолжает без ключа, а не ждёт таймаута. */
export const cancelProjectSecret=(projectId:string,requestId:string)=>apiJson<{cancelled:boolean}>(
  "/api/projects/"+projectId+"/secrets/"+encodeURIComponent(requestId)+"/cancel",{method:"POST"});

/** Ответ на вопрос агента: выбранные варианты и, если пользователь написал сам, свой текст. */
export const answerProjectQuestion=(projectId:string,requestId:string,answer:{selected:string[];custom?:string})=>apiJson<{ok:boolean;selected:string[];custom?:string;delivered:boolean}>(
  "/api/projects/"+projectId+"/questions/"+encodeURIComponent(requestId)+"/answer",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(answer)});
/** Пропуск вопроса: агент выбирает разумный вариант сам, а не ждёт таймаута. */
export const skipProjectQuestion=(projectId:string,requestId:string)=>apiJson<{cancelled:boolean}>(
  "/api/projects/"+projectId+"/questions/"+encodeURIComponent(requestId)+"/skip",{method:"POST"});

export const runProjectTerminal=(projectId:string,command:string,cwd?:string)=>apiJson<{ok:boolean;stdout:string;stderr:string}>("/api/projects/"+projectId+"/terminal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,cwd})});

/**
 * Холодный ярус проекта. `archived` — рабочая папка лежит в бакете; `restoring` — её уже
 * возвращают, `bytesDone`/`bytesTotal` — прогресс скачивания архива.
 */
export type ProjectArchivePhase="queued"|"downloading"|"unpacking"|null;
export type ProjectArchiveState={
  archived:boolean;
  bytes:number;
  archivedAt:string|null;
  restoring:boolean;
  bytesDone:number;
  bytesTotal:number;
  phase:ProjectArchivePhase;
  jobId:string|null;
  error:string|null;
};
export const getProjectArchive=(projectId:string)=>apiJson<ProjectArchiveState>("/api/projects/"+projectId+"/archive");
/**
 * Ставит восстановление в фон и сразу возвращает задание (`202`), а не ждёт распаковки.
 * `jobId: null` — архива нет, проект уже на диске.
 */
export const startProjectRestore=(projectId:string)=>apiJson<{
  archived:boolean;
  restored:boolean;
  restoring:boolean;
  jobId:string|null;
  bytesDone:number;
  bytesTotal:number;
  phase:ProjectArchivePhase;
}>("/api/projects/"+projectId+"/restore",{method:"POST"});
