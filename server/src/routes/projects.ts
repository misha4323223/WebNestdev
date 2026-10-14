import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createProjectWithinLimit, ProjectLimitError, getProject, createConversation, getConversation, listConversations, listProjects, deleteProject, renameProject } from "../project-store.js";
import type { Conversation } from "../project-store.js";
import { getSubscription } from "../account/account-store.js";
import { limitsForPlan, type PlanId } from "../account/plans.js";

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

function planFor(subscription: Awaited<ReturnType<typeof getSubscription>>, now = Date.now()): PlanId {
  return subscription.status === "demo_active" && subscription.expiresAt && Date.parse(subscription.expiresAt) > now ? subscription.plan : "free";
}

export async function registerProjectRoutes(app:FastifyInstance){
  app.get("/api/projects",async(request,reply)=>{const user=await requireUser(request,reply);if(!user)return;return {projects:await listProjects(user.id)};});
  app.get("/api/projects/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Проект не найден"});
    return project;
  });
  app.post("/api/projects",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const body=z.object({name:z.string().max(120).optional()}).parse(request.body);
    const subscription=await getSubscription(user.id);
    const plan=planFor(subscription);
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
    if(!await deleteProject(p.id,user.id))return reply.code(404).send({error:"Проект не найден"});
    return {deleted:true};
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
