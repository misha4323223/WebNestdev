/**
 * A run queued before the workspace opens: template quick start and GitHub import create the
 * project first, then reload into it. The panel reads this once and starts the planner itself, so
 * the first thing the user sees is the agent asking questions instead of an empty chat.
 */
export type PendingAgentStart={
  prompt:string;
  /** Short label for the opening notice in the chat. */
  title?:string;
  createdAt:number;
};

const key=(conversationId:string)=>"webnestdev.pendingStart."+conversationId;

export function queueAgentStart(conversationId:string,start:Omit<PendingAgentStart,"createdAt">){
  try{localStorage.setItem(key(conversationId),JSON.stringify({...start,createdAt:Date.now()} satisfies PendingAgentStart))}catch{}
}

/** Reads and removes the queued run, so a reload or a second panel mount cannot start it twice. */
export function takeAgentStart(conversationId:string):PendingAgentStart|null{
  if(!conversationId)return null;
  try{
    const raw=localStorage.getItem(key(conversationId));
    if(!raw)return null;
    localStorage.removeItem(key(conversationId));
    const parsed=JSON.parse(raw) as Partial<PendingAgentStart>;
    if(typeof parsed.prompt!=="string"||!parsed.prompt.trim())return null;
    return {
      prompt:parsed.prompt,
      ...(typeof parsed.title==="string"&&parsed.title?{title:parsed.title}:{}),
      createdAt:typeof parsed.createdAt==="number"?parsed.createdAt:Date.now(),
    };
  }catch{return null}
}
