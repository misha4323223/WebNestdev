import { apiJson } from "./api";
import type { ChatMessage, FileEntry, PreviewState } from "./types";

export type Project={id:string;name:string;createdAt:string;updatedAt:string};
export type Conversation={id:string;projectId:string;title:string;messages:ChatMessage[];createdAt:string;updatedAt:string};

export const createProject=(name="Новый проект")=>apiJson<Project>("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name})});
export const createConversation=(projectId:string,title="Новая сессия")=>apiJson<Conversation>("/api/projects/"+projectId+"/conversations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title})});
export const getConversation=(conversationId:string)=>apiJson<Conversation>("/api/conversations/"+conversationId);
export const listProjectFiles=(projectId:string)=>apiJson<{path:string;files:FileEntry[]}>("/api/projects/"+projectId+"/files");
export const getPreviewStatus=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/status");
export const startPreview=(projectId:string)=>apiJson<PreviewState>("/api/projects/"+projectId+"/preview/start",{method:"POST"});
export const stopPreview=(projectId:string)=>apiJson<{stopped:boolean}>("/api/projects/"+projectId+"/preview/stop",{method:"POST"});
export const runProjectTerminal=(projectId:string,command:string)=>apiJson<{ok:boolean;stdout:string;stderr:string}>("/api/projects/"+projectId+"/terminal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command})});
