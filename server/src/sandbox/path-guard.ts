import path from "node:path";
import { lstat,realpath } from "node:fs/promises";

export function assertInsideSandbox(root:string,candidate:string){
  const safeRoot=path.resolve(root);
  const target=path.resolve(candidate);
  if(target!==safeRoot&&!target.startsWith(safeRoot+path.sep))throw new Error("Path escapes sandbox");
  return target;
}

export async function resolveInsideSandbox(root:string,candidate:string){
  const lexical=assertInsideSandbox(root,candidate);
  const safeRoot=await realpath(root);
  const resolved=await realpath(lexical);
  if(resolved!==safeRoot&&!resolved.startsWith(safeRoot+path.sep))throw new Error("Path escapes sandbox");
  return resolved;
}

export async function assertRegularFile(root:string,candidate:string){
  const resolved=await resolveInsideSandbox(root,candidate);
  const info=await lstat(resolved);
  if(!info.isFile())throw new Error("Only regular files can be read");
  return resolved;
}
