import { randomUUID } from "node:crypto";
import type { ProviderToolCall } from "./provider-types.js";

/**
 * DeepSeek V4 can describe a tool call as DSML text instead of filling the structured
 * `tool_calls` field. The format is a wrapper with one or more invokes and parameters,
 * where the wrapper name starts with the model's DSML control token. A gateway that does
 * not parse it (or that receives a malformed wrapper) leaks the whole block into content.
 *
 * This module recovers a complete block without buffering the whole answer: text before
 * the block is emitted immediately, the block is held until its closing tag, and only a
 * dangling "<" is kept between chunks. Recovery is conservative: an invoke is accepted
 * only when its name is present in the tools declared for the request.
 */

const DSML_MARK = "(?:[|\\uFF5C]?DSML[|\\uFF5C]?\\s*)?";
const DSML_PREFIX = "<"+DSML_MARK;
const TAG_NAME = "(?:tool[\\s_-]*calls?|invoke|parameter)";

function openWrapper(){ return new RegExp(DSML_PREFIX+"tool[\\s_-]*calls?\\b[^>]*>","i") }
function closeWrapper(){ return new RegExp("<\\/"+DSML_MARK+"tool[\\s_-]*calls?\\s*>","i") }
function openInvoke(){ return new RegExp(DSML_PREFIX+"invoke\\b[^>]*>","i") }
function closeInvoke(){ return new RegExp("<\\/"+DSML_MARK+"invoke\\s*>","i") }

function findStart(text:string):number{
  const positions=[openWrapper().exec(text)?.index,openInvoke().exec(text)?.index]
    .filter((value):value is number=>typeof value==="number");
  return positions.length?Math.min(...positions):-1;
}

/** End of the block currently being collected, or -1 while more stream is needed. */
function findEnd(block:string):number{
  if(openWrapper().exec(block)?.index===0){
    const end=closeWrapper().exec(block);
    if(end)return end.index+end[0].length;
    // A malformed wrapper may lose its closing tag. Wait for the stream end instead of
    // committing the first invoke and showing later invokes as ordinary text.
    return -1;
  }
  const end=closeInvoke().exec(block);
  if(end)return end.index+end[0].length;
  return -1;
}

function decodeXml(value:string):string{
  return value
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'")
    .replace(/&amp;/g,"&");
}

function attribute(attrs:string,name:string):string|undefined{
  const match=new RegExp("\\b"+name+"\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')","i").exec(attrs);
  return match?.[1]??match?.[2];
}

function parameterValue(body:string,stringAttr:string|undefined):unknown{
  const value=decodeXml(body);
  if(stringAttr!=="false")return value;
  const trimmed=value.trim();
  if(!trimmed)return "";
  try{return JSON.parse(trimmed)}catch{return value}
}

function invokeArguments(body:string):Record<string,unknown>{
  const args:Record<string,unknown>={};
  const pattern=new RegExp(DSML_PREFIX+"parameter\\b([^>]*)>([\\s\\S]*?)"+"<\\/"+
    DSML_MARK+"parameter\\s*>","gi");
  for(const match of body.matchAll(pattern)){
    const name=attribute(match[1],"name");
    if(!name)continue;
    args[name]=parameterValue(match[2],attribute(match[1],"string"));
  }
  return args;
}

/** All tool names the request actually declared. Without one, no recovery is attempted. */
export function declaredToolNames(tools:unknown[]|undefined):Set<string>{
  const names=new Set<string>();
  for(const tool of tools??[]){
    const value=tool as {name?:unknown;function?:{name?:unknown}}|undefined;
    const name=typeof value?.function?.name==="string" ? value.function.name : value?.name;
    if(typeof name==="string"&&name.trim())names.add(name.trim());
  }
  return names;
}

function stripDsmlTags(text:string):string{
  return text
    .replace(new RegExp(DSML_PREFIX+TAG_NAME+"\\b[^>]*>","gi"),"")
    .replace(new RegExp("<\\/"+DSML_MARK+TAG_NAME+"\\s*>","gi"),"")
    .replace(/[ \t]+\n/g,"\n")
    .trim();
}

function stripOrphanClosers(text:string):string{
  return text
    .replace(new RegExp("<\\/"+DSML_MARK+TAG_NAME+"\\s*>","gi"),"")
    .replace(/\n{3,}/g,"\n\n");
}

/**
 * Parse one block (or an incomplete tail, when called from flush) into ordinary tool calls.
 * `text` is what remains of the block when it could not be recovered: tags are removed so a
 * parser failure never shows raw DSML in the chat.
 */
export function parseDsmlToolCalls(raw:string,allowed:Set<string>|undefined):{calls:ProviderToolCall[];text:string}{
  const calls:ProviderToolCall[]=[];
  const pattern=new RegExp(DSML_PREFIX+"invoke\\b([^>]*)>([\\s\\S]*?)"+"<\\/"+
    DSML_MARK+"invoke\\s*>","gi");
  for(const match of raw.matchAll(pattern)){
    const name=attribute(match[1],"name");
    if(!name)continue;
    if(allowed&&allowed.size&&!allowed.has(name))continue;
    calls.push({id:randomUUID(),name,arguments:invokeArguments(match[2])});
  }
  if(calls.length)return {calls,text:""};
  return {calls:[],text:stripDsmlTags(raw)};
}

function safePrefix(text:string):string{
  const lastLt=text.lastIndexOf("<");
  if(lastLt<0)return text;
  const tail=text.slice(lastLt);
  // A complete tag is not a marker start: emit it normally. An incomplete tail may be the
  // beginning of a DSML tag split across stream chunks, so keep it for the next chunk.
  return tail.includes(">")?text:text.slice(0,lastLt);
}

export class DsmlTextFilter{
  private readonly allowed:Set<string>;
  private buffer="";
  private block="";
  private inBlock=false;

  constructor(tools:unknown[]|undefined){
    this.allowed=declaredToolNames(tools);
  }

  push(text:string):{text:string;calls:ProviderToolCall[]}{
    if(!text||!this.allowed.size)return {text,calls:[]};
    if(this.inBlock)this.block+=text;
    else this.buffer+=text;
    return this.drain();
  }

  flush():{text:string;calls:ProviderToolCall[]}{
    if(this.inBlock){
      const parsed=parseDsmlToolCalls(this.block,this.allowed);
      this.block="";
      this.inBlock=false;
      return {text:stripOrphanClosers(parsed.text),calls:parsed.calls};
    }
    const text=stripOrphanClosers(this.buffer);
    this.buffer="";
    return {text,calls:[]};
  }

  private drain():{text:string;calls:ProviderToolCall[]}{
    let text="";
    const calls:ProviderToolCall[]=[];
    for(;;){
      if(this.inBlock){
        const end=findEnd(this.block);
        if(end<0)break;
        const raw=this.block.slice(0,end);
        const rest=this.block.slice(end);
        const parsed=parseDsmlToolCalls(raw,this.allowed);
        text+=parsed.text;
        calls.push(...parsed.calls);
        this.block="";
        this.inBlock=false;
        this.buffer=rest;
        continue;
      }
      const start=findStart(this.buffer);
      if(start<0)break;
      text+=this.buffer.slice(0,start);
      this.block=this.buffer.slice(start);
      this.buffer="";
      this.inBlock=true;
    }
    if(!this.inBlock){
      const safe=safePrefix(this.buffer);
      text+=safe;
      this.buffer=this.buffer.slice(safe.length);
    }
    return {text:stripOrphanClosers(text),calls};
  }
}
