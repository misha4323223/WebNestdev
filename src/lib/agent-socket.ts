export type AgentSocketEvent={type:string;delta?:string;error?:string};

export function createAgentSocket(onEvent:(event:AgentSocketEvent)=>void,onError:()=>void){
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  const socket=new WebSocket(protocol+"//"+window.location.host+"/ws");
  socket.onmessage=event=>onEvent(JSON.parse(event.data) as AgentSocketEvent);
  socket.onerror=onError;
  return socket;
}
