/** Result of one Docker CLI call; shared by the local host and preview/job operations. */
export type DockerCliResult={code:number;stdout:string;stderr:string};
export type DockerCommandResult={ok:boolean;exitCode:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;truncated:boolean};
export type DockerSandboxOptions={image:string;memory:string;cpus:string;pids:string;network:string;maxOutput:number;runtime:"docker"|"runsc"};
