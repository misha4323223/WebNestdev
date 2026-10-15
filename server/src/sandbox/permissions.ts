import { chmod,readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Команды проекта выполняются в контейнере от uid 1000, а файлы проекта пишет сервер от root.
 * Файл root:root 644 контейнер читает, но не меняет, поэтому сборка в подкаталоге, установка
 * пакетов рядом с такими файлами и `chmod` изнутри падают на EPERM. Корень песочницы открыт
 * с самого начала (см. sandbox-service); здесь то же самое делается для всего, что внутри.
 */

/** Права, при которых uid 1000 может писать: каталогу нужен вход, файлу — запись. */
const DIR_MODE=0o777;
const FILE_MODE=0o666;
/** Каталоги, которые наполняет сам контейнер: обход по ним ничего не исправляет, но дорог. */
const SKIP_DIRS=new Set(["node_modules",".git",".cache",".vite",".turbo"]);
/** Потолок разового обхода: большое дерево лечится частично, но не тормозит первый вызов. */
const TREE_LIMIT=20000;

async function open(target:string,mode:number){
  try{await chmod(target,mode)}
  catch(error){
    // Права — не повод падать: если что-то осталось закрытым, об этом скажет сама команда.
    if((error as NodeJS.ErrnoException).code!=="ENOENT")console.error(`[sandbox] не удалось выставить права на ${target}`,error);
  }
}

/** Каталог для контейнера: создание в нём node_modules, dist и прочего. */
export function openDirForSandbox(dir:string){return open(dir,DIR_MODE)}

/** Файл, записанный сервером: контейнер должен уметь его перезаписать. */
export function openFileForSandbox(file:string){return open(file,FILE_MODE)}

/** Каталог, в который сервер положил файл, и все его родители до корня песочницы включительно. */
export async function openDirsForSandbox(root:string,dir:string){
  const stop=path.resolve(root);
  let current=path.resolve(dir);
  while(current===stop||current.startsWith(stop+path.sep)){
    await openDirForSandbox(current);
    if(current===stop)return;
    const parent=path.dirname(current);
    if(parent===current)return;
    current=parent;
  }
}

/**
 * Разовое открытие уже существующего дерева: проект, собранный до этого исправления (или
 * скопированный в песочницу), лежит root:root с 644, и агент не может в нём собрать ничего.
 * node_modules и .git пропускаются: их наполняет контейнер, и обход стоит тысяч вызовов.
 */
export async function openTreeForSandbox(root:string,limit=TREE_LIMIT){
  const stack=[path.resolve(root)];
  let seen=0;
  while(stack.length&&seen<limit){
    const current=stack.pop() as string;
    const entries=await readdir(current,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries){
      if(seen>=limit)break;
      seen++;
      const full=path.join(current,entry.name);
      if(entry.isDirectory()){
        if(SKIP_DIRS.has(entry.name))continue;
        await openDirForSandbox(full);
        stack.push(full);
        continue;
      }
      if(entry.isFile())await openFileForSandbox(full);
    }
  }
}
