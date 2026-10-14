export type SandboxConfig={projectId:string;root:string;hostRoot?:string;memoryMb:number;cpuLimit:number;timeoutMs:number};
export type SandboxCommandResult={code:number;stdout:string;stderr:string;timedOut?:boolean};
