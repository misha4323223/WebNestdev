import { useCallback,useEffect,useState } from "react";
import { createConversation,createProject } from "../../lib/project-api";

export function useWorkspace(){
  const [projectId,setProjectId]=useState(()=>localStorage.getItem("webnestdev.projectId")??"");
  const [conversationId,setConversationId]=useState(()=>localStorage.getItem("webnestdev.conversationId")??"");
  const [projectName,setProjectName]=useState(()=>localStorage.getItem("webnestdev.projectName")??"Новый проект");
  const [loading,setLoading]=useState(()=>!Boolean(projectId&&conversationId));
  const [error,setError]=useState("");

  const initialize=useCallback(async()=>{
    setLoading(true);
    setError("");
    try{
      if(projectId&&conversationId)return;

      if(projectId&&!conversationId){
        const conversation=await createConversation(projectId);
        setConversationId(conversation.id);
        localStorage.setItem("webnestdev.conversationId",conversation.id);
        return;
      }

      const project=await createProject(projectName);
      const conversation=await createConversation(project.id);
      setProjectId(project.id);
      setProjectName(project.name);
      setConversationId(conversation.id);
      localStorage.setItem("webnestdev.projectId",project.id);
      localStorage.setItem("webnestdev.projectName",project.name);
      localStorage.setItem("webnestdev.conversationId",conversation.id);
    }catch(error){
      console.error("WebNestdev workspace initialization failed",error);
      setError(error instanceof Error?error.message:String(error));
    }finally{
      setLoading(false);
    }
  },[projectId,conversationId,projectName]);

  useEffect(()=>{
    void initialize();
  },[initialize]);

  return {projectId,conversationId,projectName,loading,error,retry:initialize};
}
