/**
 * Регистрация всех инструментов агента.
 *
 * Модуль существует ради одной гарантии: сервер и eval регистрируют один и тот же каталог.
 * Инструменты регистрируются импортом (побочный эффект `registerTool`), поэтому раньше список
 * жил только в `index.ts` — и отдельный процесс (eval) получал пустой реестр: модели уходил
 * запрос без `tools`, и она просто рассказывала, что собирается сделать.
 */
import "./project-tools.js";
import "./scout-tools.js";
import "./filesystem-tools.js";
import "./memory-tools.js";
import "./repo-tools.js";
import "./test-tools.js";
import "./terminal-tools.js";
import "./git-tools.js";
import "./preview-tools.js";
import "./browser-tools.js";
import "./screenshot-tools.js";
import "./verification-tools.js";
import "./check-tools.js";
import "./perf-tools.js";
import "./asset-tools.js";
import "./vision-tools.js";
import "./note-tools.js";
import "./history-tools.js";
import "./plan-tools.js";
import "./yandex-tools.js";
import "./cloud-tools.js";
import "./domain-tools.js";
import "./service-tools.js";
import "./expo-tools.js";
import "./database-tools.js";
import "./client-database-tools.js";
import "./deploy-tools.js";
import "./deploy-check.js";
import "./access-tools.js";
import "./secret-tools.js";
import "./question-tools.js";
import "./web-tools.js";
import "./net-tools.js";
import "./python-tools.js";
import "./design-tools.js";
import "./image-tools.js";
import "./seo-tools.js";
import "./seo-check.js";
import "./view-image-tools.js";
import "./ui-tools.js";
