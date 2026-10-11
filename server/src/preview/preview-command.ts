import { access,readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";

type PackageJson={scripts?:Record<string,string>};

export async function resolvePreviewCommand(config:SandboxConfig){
  const packagePath=path.join(config.root,"package.json");
  try{
    await access(packagePath);
    const pkg=JSON.parse(await readFile(packagePath,"utf8")) as PackageJson;
    if(!pkg.scripts?.dev&&!pkg.scripts?.start)throw new Error("В package.json проекта нет скрипта dev или start.");
    const script=pkg.scripts.dev?"dev":"start";
    return "npm run "+script+" -- --host 0.0.0.0 --port 3000";
  }catch(error){
    if(error instanceof SyntaxError)throw new Error("В package.json проекта некорректный JSON.");
    if(error instanceof Error&&error.message.startsWith("В package.json проекта нет скрипта"))throw error;
    throw new Error("Для предпросмотра нужен package.json со скриптом dev или start.");
  }
}
