export async function* lines(body:ReadableStream<Uint8Array>){
  const reader=body.getReader();const decoder=new TextDecoder();let buffer="";
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      const parts=buffer.split("\n");buffer=parts.pop()??"";
      for(const line of parts){const value=line.trim();if(value)yield value.startsWith("data:")?value.slice(5).trim():value}
    }
    if(buffer.trim())yield buffer.trim();
  }finally{reader.releaseLock()}
}
