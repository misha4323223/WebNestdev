import { access,readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";

type PackageJson={scripts?:Record<string,string>};

export async function resolvePreviewCommand(config:SandboxConfig){
  const packagePath=path.join(config.root,"package.json");
  try{
    await access(packagePath);
    const pkg=JSON.parse(await readFile(packagePath,"utf8")) as PackageJson;
    if(!pkg.scripts?.dev&&!pkg.scripts?.start)throw new Error("Project has no dev or start script in package.json.");
    const script=pkg.scripts.dev?"dev":"start";
    return "npm run "+script+" -- --host 0.0.0.0 --port 3000";
  }catch(error){
    if(error instanceof SyntaxError)throw new Error("Project package.json is invalid JSON.");
    if(error instanceof Error&&error.message.startsWith("Project has no"))throw error;
    throw new Error("Preview requires a package.json with a dev or start script.");
  }
}
