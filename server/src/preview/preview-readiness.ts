import { access } from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";

export async function previewReadiness(config:SandboxConfig){
  try{
    await access(path.join(config.root,"package.json"));
    return {ready:true};
  }catch{
    return {ready:false,reason:"package.json is missing"};
  }
}
