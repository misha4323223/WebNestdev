import { useCallback,useEffect,useState } from "react";
import { createConversation,createProject,listConversations } from "../../lib/project-api";

const projectKey="webnestdev.projectId";
const conversationKey="webnestdev.conversationId";
const projectNameKey="webnestdev.projectName";
/** The chat the user left open, remembered per project so the choice survives the home screen. */
const conversationMemoryKey=(projectId:string)=>"webnestdev.conversation."+projectId;

/**
 * A project keeps its chats on the server, so the workspace returns to a saved one instead
 * of opening an empty session: the same conversation comes back on another device or after
 * the browser storage is cleared. The chat the user left open wins, then the most recent
 * one, and only a project without chats gets a new session.
 */
async function conversationToOpen(projectId:string,remembered:string){
  const stored=(await listConversations(projectId)).conversations;
  return stored.find(item=>item.id===remembered)??stored[0]??await createConversation(projectId);
}

export function useWorkspace(){
  const [projectId,setProjectId]=useState(()=>localStorage.getItem(projectKey)??"");
  const [conversationId,setConversationId]=useState(()=>localStorage.getItem(conversationKey)??"");
  const [projectName,setProjectName]=useState(()=>localStorage.getItem(projectNameKey)??"Новый проект");
  const [loading,setLoading]=useState(()=>!Boolean(projectId&&conversationId));
  const [error,setError]=useState("");

  /** Opens another saved chat of the project: the panel reloads from the stored turns. */
  const openConversation=useCallback((id:string)=>{
    setConversationId(id);
    try{
      localStorage.setItem(conversationKey,id);
      const current=localStorage.getItem(projectKey);
      if(current)localStorage.setItem(conversationMemoryKey(current),id);
    }catch{}
  },[]);

  const initialize=useCallback(async()=>{
    setLoading(true);
    setError("");
    try{
      if(projectId&&conversationId)return;

      if(projectId){
        let remembered="";
        try{remembered=localStorage.getItem(conversationMemoryKey(projectId))??""}catch{}
        const conversation=await conversationToOpen(projectId,remembered);
        openConversation(conversation.id);
        return;
      }

      const project=await createProject(projectName);
      const conversation=await createConversation(project.id);
      setProjectId(project.id);
      setProjectName(project.name);
      openConversation(conversation.id);
      try{
        localStorage.setItem(projectKey,project.id);
        localStorage.setItem(projectNameKey,project.name);
        localStorage.setItem(conversationMemoryKey(project.id),conversation.id);
      }catch{}
    }catch(error){
      console.error("WebNestdev workspace initialization failed",error);
      setError(error instanceof Error?error.message:String(error));
    }finally{
      setLoading(false);
    }
  },[projectId,conversationId,projectName,openConversation]);

  useEffect(()=>{
    void initialize();
  },[initialize]);

  return {projectId,conversationId,projectName,loading,error,retry:initialize,openConversation};
}
