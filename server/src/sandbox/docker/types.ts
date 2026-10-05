export type DockerCommandResult={ok:boolean;exitCode:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;truncated:boolean};
export type DockerSandboxOptions={image:string;memory:string;cpus:string;pids:string;network:string;maxOutput:number};
