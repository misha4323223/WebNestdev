import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createProjectWithinLimit, ProjectLimitError, getProject, createConversation, getConversation, listConversations, listProjects, deleteProject, deleteConversation, renameProject } from "../project-store.js";
import type { Conversation } from "../project-store.js";
import { limitsForPlan } from "../account/plans.js";
import { accountPlanFor } from "../billing/store.js";
import { forgetProjectStorage } from "../account/storage-quota.js";
import { archiveProject, deleteProjectArchive, projectArchiveInfo, startProjectRestore } from "../storage/project-archive.js";
import { cancelProjectRestore, projectRestoreJob, restoreJobActive } from "../storage/restore-jobs.js";
import { recordArchiveFailure } from "../storage/archive-health.js";
import { isConversationRunning, isRunActive } from "../agent/active-runs.js";
import { getPreview } from "../preview/preview-store.js";
import { recordAudit } from "../security/audit-journal.js";

/** How many chats the picker shows. Older sessions stay stored and reachable by id. */
const CONVERSATION_LIST_LIMIT = 50;

/** One line, trimmed: a chat title and a preview are read in a narrow row, not as text. */
function firstLine(value:string|undefined,max:number){
  const text=(value??"").split("\n").find(line=>line.trim())?.trim()??"";
  return text.length>max?text.slice(0,max)+"…":text;
}

/**
 * The chat list answers "which sessions does this project have", so it carries a label
 * and a short preview instead of the stored turns: a long run holds hundreds of tool
 * results, and no picker needs them. Conversation titles stay "Новая сессия" until the
 * user renames them, so the first question the user asked is what the row is called.
 */
export function conversationSummaries(conversations:Conversation[],limit=CONVERSATION_LIST_LIMIT){
  return conversations.slice(0,limit).map(conversation=>{
    const visible=conversation.messages.filter(message=>message.role==="user"||message.role==="assistant");
    const firstUser=visible.find(message=>message.role==="user");
    const last=visible.at(-1);
    return {
      id:conversation.id,
      projectId:conversation.projectId,
      title:conversation.title,
      label:firstLine(firstUser?.content,80)||conversation.title,
      preview:firstLine(last?.content,120),
      messageCount:visible.length,
      createdAt:conversation.createdAt,
      updatedAt:conversation.updatedAt,
    };
  });
}

export async function registerProjectRoutes(app:FastifyInstance){
  app.get("/api/projects",async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;return {projects:await listProjects(user.id)};});
  app.get("/api/projects/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    return {...project,archived:Boolean(await projectArchiveInfo(p.id,project.userId))};
  });
  app.post("/api/projects",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const body=z.object({name:z.string().max(120).optional()}).parse(request.body);
    const plan = await accountPlanFor(user.id);
    const limit=limitsForPlan(plan).projects;
    try{
      return reply.code(201).send(await createProjectWithinLimit(body.name??"Новый проект",undefined,user.id,limit));
    }catch(error){
      if(error instanceof ProjectLimitError)return reply.code(403).send({error:error.message,code:"PROJECT_LIMIT_REACHED",limit:error.limit,used:error.used,plan});
      throw error;
    }
  });
  app.patch("/api/projects/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const body=z.object({name:z.string().trim().min(1,"Название не может быть пустым").max(120)}).parse(request.body);
    const project=await renameProject(p.id,user.id,body.name);
    if(!project)return reply.code(404).send({error:"Проект не найден"});
    return project;
  });
  app.delete("/api/projects/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    // Имя нужно журналу после удаления: в записи останется и id, и человекочитаемое название.
    const project=await getProject(p.id);
    if(!await deleteProject(p.id,user.id))return reply.code(404).send({error:"Проект не найден"});
    // Если проект как раз возвращался из архива, распаковка должна остановиться: иначе каталог
    // удалённого проекта вернулся бы на диск и снова занял квоту.
    cancelProjectRestore(p.id);
    await recordAudit({
      action:"project.deleted",
      actorType:"user",
      actorId:user.id,
      actorLabel:user.email,
      target:p.id,
      targetLabel:project?.name??"",
      ip:request.ip,
    });
    // Размер удалённого проекта больше не существует: без этого квота помнила бы его
    // навсегда, а список проектов показывал бы место, которого нет. Проект уже удалён,
    // поэтому сбой учёта не должен превращать успешное удаление в ошибку.
    await forgetProjectStorage(p.id,user.id)
      .catch(error=>console.warn("[storage] не удалось очистить размер удалённого проекта",error));
    // Архив в бакете пережил бы удаление проекта и оплачивался бы дальше.
    await deleteProjectArchive(p.id,user.id)
      .catch(error=>console.warn("[storage] не удалось удалить архив проекта из хранилища",error));
    return {deleted:true};
  });
  /**
   * Холодный ярус: рабочая папка уезжает в объектное хранилище и освобождает диск ВМ. Открытие
   * проекта возвращает её само (`getSandbox`), поэтому эта пара ручек нужна панели и оператору,
   * а не обычному пути пользователя.
   */
  app.post("/api/projects/:id/archive",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    if(isRunActive(p.id))return reply.code(409).send({error:"Агент ещё работает в проекте — дождитесь окончания запуска",code:"PROJECT_BUSY"});
    if(getPreview(p.id))return reply.code(409).send({error:"Остановите предпросмотр: он держит файлы проекта открытыми",code:"PREVIEW_RUNNING"});
    try{
      const result=await archiveProject(p.id,user.id);
      return {archived:true,bytes:result.bytes,alreadyArchived:result.alreadyArchived};
    }catch(error){
      recordArchiveFailure();
      const message=error instanceof Error?error.message:String(error);
      return reply.code(400).send({error:message,code:"ARCHIVE_FAILED"});
    }
  });
  /**
   * Восстановление больше не держит запрос: проект в 200 МБ скачивается и распаковывается
   * десятки секунд, а HTTP отвечает сразу `202` и `jobId`. Дальше панель опрашивает
   * `GET .../archive` — там же `restoring`, `bytesDone` и `bytesTotal`.
   */
  app.post("/api/projects/:id/restore",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    try{
      const job=await startProjectRestore(p.id,user.id);
      // Архива нет — восстанавливать нечего; это не ошибка и не задание.
      if(!job)return {archived:false,restored:false,restoring:false,jobId:null,bytesDone:0,bytesTotal:0,phase:null};
      return reply.code(202).send({
        archived:true,
        restored:false,
        restoring:true,
        jobId:job.id,
        bytesDone:job.bytesDone,
        bytesTotal:job.bytesTotal,
        phase:job.state,
      });
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      return reply.code(502).send({error:message,code:"RESTORE_FAILED"});
    }
  });
  app.get("/api/projects/:id/archive",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    const record=await projectArchiveInfo(p.id,project.userId);
    // `job` живёт на этой машине: после перезапуска сервера панель увидит только отметку архива,
    // и первый же доступ к песочнице поставит восстановление заново.
    const job=projectRestoreJob(p.id);
    const restoring=job?restoreJobActive(job):false;
    return {
      archived:Boolean(record),
      bytes:record?.bytes??job?.bytesTotal??0,
      archivedAt:record?.archivedAt??null,
      restoring,
      bytesDone:job?.bytesDone??0,
      bytesTotal:job?.bytesTotal??record?.bytes??0,
      phase:restoring&&job?job.state:null,
      jobId:job?.id??null,
      error:job?.state==="failed"?job.error:null,
    };
  });
  app.get("/api/projects/:id/conversations",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    return {conversations:conversationSummaries(await listConversations(p.id))};
  });
  app.post("/api/projects/:id/conversations",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const body=z.object({title:z.string().max(120).optional()}).parse(request.body);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    return reply.code(201).send(await createConversation(p.id,body.title));
  });
  app.delete("/api/conversations/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const conversation=await getConversation(p.id);
    if(!conversation)return reply.code(404).send({error:"Сессия не найдена"});
    const project=await getProject(conversation.projectId);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Сессия не найдена"});
    // Удалить чат, в который агент прямо сейчас пишет, значит выдернуть сессию из-под запуска.
    // Остальные чаты проекта удаляются свободно — блокируется именно этот, а не весь проект.
    if(isConversationRunning(p.id))return reply.code(409).send({error:"Агент ещё работает в этом чате — дождитесь окончания запуска",code:"CONVERSATION_BUSY"});
    if(!await deleteConversation(p.id))return reply.code(404).send({error:"Сессия не найдена"});
    return {deleted:true};
  });
  app.get("/api/conversations/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const conversation=await getConversation(p.id);
    if(!conversation)return reply.code(404).send({error:"Сессия не найдена"});
    const project=await getProject(conversation.projectId);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Сессия не найдена"});
    return conversation;
  });
}
