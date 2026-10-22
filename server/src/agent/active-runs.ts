/**
 * Runs currently in flight, per project. A preview must not be stopped for idleness while the
 * agent is still working on that project: the run may be mid-thought and only touch the
 * preview a minute later during verification. The runtime is the only place that knows a run
 * exists, so it reports here.
 *
 * The same report is kept per conversation. Deleting a chat is a normal action, but deleting
 * the one the agent is appending to would pull the stored session out from under the run.
 */
const active=new Map<string,number>();
const activeConversations=new Map<string,number>();

export function beginRun(projectId:string,conversationId?:string){
  active.set(projectId,(active.get(projectId)??0)+1);
  if(conversationId)activeConversations.set(conversationId,(activeConversations.get(conversationId)??0)+1);
}

export function endRun(projectId:string,conversationId?:string){
  const next=(active.get(projectId)??0)-1;
  if(next>0)active.set(projectId,next);
  else active.delete(projectId);
  if(!conversationId)return;
  const chats=(activeConversations.get(conversationId)??0)-1;
  if(chats>0)activeConversations.set(conversationId,chats);
  else activeConversations.delete(conversationId);
}

export function isRunActive(projectId:string){
  return (active.get(projectId)??0)>0;
}

export function isConversationRunning(conversationId:string){
  return (activeConversations.get(conversationId)??0)>0;
}
