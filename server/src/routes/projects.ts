import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createProjectWithinLimit, ProjectLimitError, getProject, createConversation, getConversation, listConversations, listProjects, deleteProject, renameProject } from "../project-store.js";
import { getSubscription } from "../account/account-store.js";
import { limitsForPlan, type PlanId } from "../account/plans.js";

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
    return {conversations:await listConversations(p.id)};
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
