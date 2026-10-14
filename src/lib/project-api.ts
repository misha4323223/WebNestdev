import { apiJson } from "./api";
import type { ChatMessage, FileEntry, PlanState, PreviewState } from "./types";

export type Project={id:string;name:string;createdAt:string;updatedAt:string};
export type Conversation={id:string;projectId:string;title:string;messages:ChatMessage[];plan?:PlanState|null;createdAt:string;updatedAt:string};
/** A row of the chat list: enough to recognise the session without loading its messages. */
export type ConversationSummary={id:string;projectId:string;title:string;label:string;preview:string;messageCount:number;createdAt:string;updatedAt:string};

export const listProjects=()=>apiJson<{projects:Project[]}>("/api/projects");
export const createProject=(name="Новый проект")=>apiJson<Project>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
export const renameProject=(projectId:string,name:string)=>apiJson<Project>("/api/projects/"+projectId,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
export const deleteProject=(projectId:string)=>apiJson<{deleted:boolean}>("/api/projects/"+projectId,{method:"DELETE"});
export const createConversation=(projectId:string,title="Новая сессия")=>apiJson<Conversation>("/api/projects/"+projectId+"/conversations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title})});
export const getConversation=(conversationId:string)=>apiJson<Conversation>("/api/conversations/"+conversationId);
/** The project's saved chats, newest first — the ones the user can return to. */
export const listConversations=(projectId:string)=>apiJson<{conversations:ConversationSummary[]}>("/api/projects/"+projectId+"/conversations");
export const listProjectFiles=(projectId:string,path=".")=>apiJson<{path:string;files:FileEntry[]}>("/api/projects/"+projectId+"/files?path="+encodeURIComponent(path));
export const getProjectFile=(projectId:string,path:string)=>apiJson<{path:string;content:string}>("/api/projects/"+projectId+"/file?path="+encodeURIComponent(path));
/** Stores a chat attachment inside the project so the agent can use it. */
export const uploadProjectFile=(projectId:string,file:{name:string;data:string})=>apiJson<{name:string;path:string;bytes:number}>("/api/projects/"+projectId+"/upload",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(file)});
export const getPreviewStatus=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/status");
export const startPreview=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/start",{method:"POST"});
export const stopPreview=(projectId:string)=>apiJson<{stopped:boolean}>("/api/projects/"+projectId+"/preview/stop",{method:"POST"});
export const getPreviewLogs=(projectId:string)=>apiJson<{running:boolean;logs:string}>("/api/projects/"+projectId+"/preview/logs");
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
  window.location.reload();
}

export const runProjectTerminal=(projectId:string,command:string,cwd?:string)=>apiJson<{ok:boolean;stdout:string;stderr:string}>("/api/projects/"+projectId+"/terminal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,cwd})});
