export type SandboxConfig={projectId:string;root:string;hostRoot?:string;node?:string;memoryMb:number;cpuLimit:number;timeoutMs:number;/**
 * Владелец проекта. Нужен квотам 5.2: очередь контейнеров и дневное время песочницы считаются
 * на аккаунт, а не на проект. Необязателен для конфигураций, которые не запускают контейнеры
 * (runner собирает свою), но `getSandbox` всегда его заполняет.
 */
userId?:string};
export type SandboxCommandResult={code:number;stdout:string;stderr:string;timedOut?:boolean};
