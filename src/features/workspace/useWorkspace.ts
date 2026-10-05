import { useEffect,useState } from "react";
import { createConversation,createProject } from "../../lib/project-api";

export function useWorkspace(){
  const [projectId,setProjectId]=useState(()=>localStorage.getItem("webnestdev.projectId")??"");
  const [conversationId,setConversationId]=useState(()=>localStorage.getItem("webnestdev.conversationId")??"");
  const [projectName,setProjectName]=useState(()=>localStorage.getItem("webnestdev.projectName")??"Новый проект");

  useEffect(()=>{
    if(projectId&&conversationId)return;
    let cancelled=false;
    (async()=>{
      try{
        const project=await createProject(projectName);
        if(cancelled)return;
        const conversation=await createConversation(project.id);
        if(cancelled)return;
        setProjectId(project.id);setProjectName(project.name);setConversationId(conversation.id);
        localStorage.setItem("webnestdev.projectId",project.id);
        localStorage.setItem("webnestdev.projectName",project.name);
        localStorage.setItem("webnestdev.conversationId",conversation.id);
      }catch{}
    })();
    return()=>{cancelled=true};
  },[projectId,conversationId,projectName]);

  return {projectId,conversationId,projectName};
}
