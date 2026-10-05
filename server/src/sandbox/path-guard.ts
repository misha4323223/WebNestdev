import path from "node:path";

export function assertInsideSandbox(root:string,candidate:string){
  const safeRoot=path.resolve(root);
  const target=path.resolve(candidate);
  if(target!==safeRoot&&!target.startsWith(safeRoot+path.sep))throw new Error("Path escapes sandbox");
  return target;
}
