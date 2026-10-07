import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth/auth.js";
import { createProject, getProject, createConversation, getConversation, listConversations } from "../project-store.js";

export async function registerProjectRoutes(app:FastifyInstance){
  app.get("/api/projects/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Project not found"});
    return project;
  });
  app.post("/api/projects",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const body=z.object({name:z.string().max(120).optional()}).parse(request.body);
    return reply.code(201).send(await createProject(body.name??"Новый проект",undefined,user.id));
  });
  app.get("/api/projects/:id/conversations",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Project not found"});
    return {conversations:await listConversations(p.id)};
  });
  app.post("/api/projects/:id/conversations",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const body=z.object({title:z.string().max(120).optional()}).parse(request.body);
    const project=await getProject(p.id);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Project not found"});
    return reply.code(201).send(await createConversation(p.id,body.title));
  });
  app.get("/api/conversations/:id",async(request,reply)=>{
    const user=await requireUser(request,reply); if(!user)return;
    const p=z.object({id:z.string().min(1)}).parse(request.params);
    const conversation=await getConversation(p.id);
    if(!conversation)return reply.code(404).send({error:"Conversation not found"});
    const project=await getProject(conversation.projectId);
    if(!project||project.userId!==user.id)return reply.code(404).send({error:"Conversation not found"});
    return conversation;
  });
}
