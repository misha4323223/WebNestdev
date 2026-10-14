/**
 * Проверка песочницы для оператора. Запускается внутри серверного контейнера, поэтому видит обе
 * стороны сразу: каталог, в который пишет сервер, и то, что из него монтирует Docker. Если пути
 * разошлись, терминал песочницы показывает пустой `/workspace` при живых файлах агента — эта
 * команда называет оба каталога и говорит, что править.
 *
 * На ВМ из каталога развёртывания:
 *   docker compose exec -T webnestdev-server node server/dist/scripts/sandbox-selfcheck.js
 *
 * Код возврата: 0 — порядок, 1 — песочница не работает (в том числе расхождение путей).
 * Последняя строка `SANDBOX-MOUNT=…` — машинный вердикт для deploy-скрипта.
 */
import { describeSandboxPaths } from "../sandbox/config.js";
import { checkSandboxMount,describeSandboxMount } from "../sandbox/sandbox-check.js";

console.log("[sandbox] "+describeSandboxPaths());
const result=await checkSandboxMount();
console.log((result.ok?"[sandbox] порядок: ":"[sandbox] проблема: ")+describeSandboxMount(result));
console.log("SANDBOX-MOUNT="+(result.reason??"ok"));
process.exit(result.ok?0:1);
