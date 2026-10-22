import { useCallback,useEffect,useState } from "react";
import { createConversation,createProject,listConversations,renameProject } from "../../lib/project-api";

const projectKey="webnestdev.projectId";
const conversationKey="webnestdev.conversationId";
const projectNameKey="webnestdev.projectName";
/** The chat the user left open, remembered per project so the choice survives the home screen. */
export const conversationMemoryKey=(projectId:string)=>"webnestdev.conversation."+projectId;

/**
 * A project keeps its chats on the server, so the workspace returns to a saved one instead
 * of opening an empty session: the same conversation comes back on another device or after
 * the browser storage is cleared. The chat the user left open wins, then the most recent
 * one, and only a project without chats gets a new session.
 */
async function conversationToOpen(projectId:string,remembered:string){
  const stored=(await listConversations(projectId)).conversations;
  const rememberedItem=stored.find(item=>item.id===remembered);
  // Чат с перепиской — это работа, к которой возвращаются; пустой чат — только место, где
  // человек оказался. Поэтому запомненный чат выигрывает лишь тогда, когда в нём есть разговор,
  // иначе вход в проект снова и снова показывал бы пустую «новую сессию».
  if(rememberedItem&&rememberedItem.messageCount>0)return rememberedItem;
  return stored.find(item=>item.messageCount>0)??rememberedItem??stored[0]??await createConversation(projectId);
}

export function useWorkspace(){
  const [projectId,setProjectId]=useState(()=>localStorage.getItem(projectKey)??"");
  // Чат берётся из памяти этого проекта, а не из общего ключа браузера: общий мог остаться от
  // другого проекта или от старой пустой сессии, и тогда рабочая область сначала показывала
  // не тот чат, а потом переключалась. Выбор всё равно уточняется списком чатов при открытии.
  const [conversationId,setConversationId]=useState(()=>{
    try{
      const storedProject=localStorage.getItem(projectKey);
      if(storedProject)return localStorage.getItem(conversationMemoryKey(storedProject))??"";
      return localStorage.getItem(conversationKey)??"";
    }catch{return ""}
  });
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

  /**
   * Название проекта меняется из шапки рабочей области и сразу обновляет подпись: имя хранится
   * и на сервере, и в браузере, поэтому оба места пишутся одним действием. Подпись на главной
   * перечитает список проектов сама, когда человек туда вернётся.
   */
  const renameCurrentProject=useCallback(async(name:string)=>{
    const updated=await renameProject(projectId,name);
    setProjectName(updated.name);
    try{localStorage.setItem(projectNameKey,updated.name)}catch{}
    return updated;
  },[projectId]);

  const initialize=useCallback(async()=>{
    // Заглушка загрузки нужна только тогда, когда показать ещё нечего: сохранённый чат
    // открывается сразу, а список чатов лишь уточняет выбор без мигания экрана.
    if(!conversationId)setLoading(true);
    setError("");
    try{
      if(projectId){
        let remembered="";
        try{remembered=localStorage.getItem(conversationMemoryKey(projectId))??""}catch{}
        // Список чатов решает, какой открыть, даже когда идентификатор уже лежит в браузере:
        // глобальный ключ мог остаться от другой вкладки или от пустой сессии, созданной раньше,
        // и тогда каждый заход встречал «новый чат». Память проекта пишется при каждом открытии.
        const conversation=await conversationToOpen(projectId,remembered).catch(error=>{
          // Сбой списка не должен запирать уже открытый чат: он загрузится по своему id.
          if(!conversationId)throw error;
          return {id:conversationId};
        });
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
      console.error("NestDev workspace initialization failed",error);
      setError(error instanceof Error?error.message:String(error));
    }finally{
      setLoading(false);
    }
    // Чат выбирается только при открытии рабочей области: смена чата — это выбор
    // пользователя, и перевыбор на каждом изменении состояния отменял бы его.
  },[projectId,projectName,openConversation]);

  useEffect(()=>{
    void initialize();
  },[initialize]);

  return {projectId,conversationId,projectName,loading,error,retry:initialize,openConversation,renameCurrentProject};
}
