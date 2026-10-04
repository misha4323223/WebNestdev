import { getSandbox,assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

function quote(value:string){return "'"+value.replaceAll("'","'\\''")+"'"}

async function git(c:{projectId:string;runId:string},command:string){
  const sandbox=await getSandbox(c.projectId);
  return runInSandbox(sandbox,"git "+command,sandbox.root);
}
registerTool({name:"git.status",description:"Show Git working tree status for the project.",async(_,c)=>git(c,"status --short --branch")});
registerTool({name:"git.diff",description:"Show unstaged Git diff for the project.",async(_,c)=>git(c,"diff --no-ext-diff")});
registerTool({name:"git.log",description:"Show recent Git commits.",async(_,c)=>git(c,"log --oneline -20")});
registerTool({name:"git.branch",description:"List local Git branches.",async(_,c)=>git(c,"branch --list")});
registerTool({name:"git.add",description:"Stage project paths. Input: {paths:string[]}.",async(input,c)=>{const paths=(input as {paths?:string[]}).paths;if(!paths?.length)throw new Error("paths is required");const sandbox=await getSandbox(c.projectId);const safe=paths.map(p=>assertInsideSandbox(sandbox.root,sandbox.root+"/"+p).slice(sandbox.root.length+1));const quoted=safe.map(p=>"'"+p.replaceAll("'","'\\''")+"'").join(" ");return runInSandbox(sandbox,"git add -- "+quoted,sandbox.root)}});
registerTool({name:"git.commit",description:"Create a Git commit. Input: {message:string}.",async(input,c)=>{const message=(input as {message?:string}).message?.trim();if(!message)throw new Error("message is required");const sandbox=await getSandbox(c.projectId);const quoted=message.replaceAll("'","'\\''");return runInSandbox(sandbox,"git commit -m '"+quoted+"'",sandbox.root)}});
