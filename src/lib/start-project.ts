import { createConversation, createProject, type Project } from "./project-api";
import { queueAgentStart } from "./agent-start";

export type ProjectStartOptions = {
  name: string;
  /** Задача агенту, которая начнётся сразу после открытия проекта. */
  plannerPrompt?: string;
  /** Подпись первого сообщения в чате. */
  title?: string;
};

/**
 * Новый проект и его первый чат в одном порядке: главная и знакомство при входе запускают
 * проект одинаково, поэтому запуск живёт здесь, а не в двух экранах.
 *
 * Идентификаторы пишутся в localStorage до открытия рабочей области: она выбирает проект и чат
 * по ним же, так что обновление страницы возвращает в тот же запуск, а не на главную.
 */
export async function startProjectWithAgent({ name, plannerPrompt, title }: ProjectStartOptions): Promise<Project> {
  const project = await createProject(name);
  const conversation = await createConversation(project.id);
  if (plannerPrompt) queueAgentStart(conversation.id, { prompt: plannerPrompt, ...(title ? { title } : {}) });
  localStorage.setItem("webnestdev.projectId", project.id);
  localStorage.setItem("webnestdev.projectName", project.name);
  localStorage.setItem("webnestdev.conversationId", conversation.id);
  return project;
}
