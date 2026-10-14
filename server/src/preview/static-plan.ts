import { readFile,readdir,stat } from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../sandbox-manager.js";

/**
 * Static preview: instead of one dev-server container per project, the *built* app is served
 * from the server process. It costs no container memory, so a small host keeps several
 * previews alive at once; the trade-off is that there is no hot reload — the app is built
 * again and served again.
 *
 * This module only decides *where* the build output lives and whether it is still current.
 * The build itself and the HTTP listener live in static-preview.ts.
 */

/** Never scanned for sources: dependencies, VCS and framework caches. */
const SKIP_DIRS=new Set(["node_modules",".git",".cache",".vite",".next",".turbo",".output","coverage"]);
/** Where a build usually writes, in the order the decision tries them. */
const CANDIDATE_DIRS=["dist","build","out"];
/** Entries the freshness scan may look at; a bigger project is scanned partially by design. */
const MAX_SCAN_ENTRIES=4000;
/** Filesystem timestamp tolerance, so a build is not repeated for a write in the same second. */
const FRESHNESS_TOLERANCE_MS=1000;

export type StaticPlan={ok:true;dir:string;built:boolean}|{ok:false;reason:string};

/** Candidate output directories: PREVIEW_STATIC_DIR wins, otherwise the usual names. */
export function staticOutputCandidates(root:string){
  const configured=process.env.PREVIEW_STATIC_DIR?.trim();
  if(configured)return [path.resolve(root,configured)];
  return CANDIDATE_DIRS.map(name=>path.join(root,name));
}

export async function indexFileExists(dir:string){
  const info=await stat(path.join(dir,"index.html")).catch(()=>null);
  return Boolean(info?.isFile());
}

/**
 * A project can be previewed statically when it has a build script and produces an
 * index.html. Nothing built yet is not a refusal: the first candidate is returned as the
 * directory the build is expected to fill, and `built` says whether it is there already.
 */
export async function planStaticPreview(config:SandboxConfig):Promise<StaticPlan>{
  let packageJson:{scripts?:Record<string,string>};
  try{
    packageJson=JSON.parse(await readFile(path.join(config.root,"package.json"),"utf8")) as {scripts?:Record<string,string>};
  }catch{
    // A project without package.json is not a static site; the dev-server preview explains
    // the rest (it refuses with "нет скрипта dev или start").
    return {ok:false,reason:"нет package.json"};
  }
  if(!packageJson.scripts?.build)return {ok:false,reason:"в package.json проекта нет скрипта build"};
  const candidates=staticOutputCandidates(config.root);
  for(const dir of candidates){
    if(await indexFileExists(dir))return {ok:true,dir,built:true};
  }
  return {ok:true,dir:candidates[0],built:false};
}

/** The moment the served build was produced: the recorded build time, or index.html's mtime. */
export async function staticBuildMarker(dir:string,builtAtMs=0){
  const info=await stat(path.join(dir,"index.html")).catch(()=>null);
  return Math.max(info?.mtimeMs??0,builtAtMs);
}

/**
 * True when no project source is newer than the served build, so the existing output can be
 * served as is. A project with more files than the scan cap is treated as fresh: rebuilding a
 * large tree on every preview open would cost far more than serving a build that is a few
 * seconds old, and PREVIEW_STATIC_BUILD=always forces the rebuild when it matters.
 */
export async function isStaticBuildFresh(root:string,dir:string,builtAtMs=0){
  const marker=await staticBuildMarker(dir,builtAtMs);
  if(!marker)return false;
  const newest=await newestSourceMtime(root,dir);
  return newest<=marker+FRESHNESS_TOLERANCE_MS;
}

export async function newestSourceMtime(root:string,outputDir:string){
  const output=path.resolve(outputDir);
  const stack=[path.resolve(root)];
  let newest=0;
  let seen=0;
  while(stack.length&&seen<MAX_SCAN_ENTRIES){
    const current=stack.pop() as string;
    const entries=await readdir(current,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries){
      if(seen>=MAX_SCAN_ENTRIES)break;
      const full=path.join(current,entry.name);
      if(entry.isDirectory()){
        if(entry.name.startsWith(".")||SKIP_DIRS.has(entry.name))continue;
        // The previous build is an output, not a source: its own files must not make it stale.
        if(path.resolve(full)===output)continue;
        stack.push(full);
        continue;
      }
      if(!entry.isFile())continue;
      seen++;
      const info=await stat(full).catch(()=>null);
      if(info&&info.mtimeMs>newest)newest=info.mtimeMs;
    }
  }
  return newest;
}
