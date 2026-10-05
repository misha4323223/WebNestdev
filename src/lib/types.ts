export type ChatMessage={role:"user"|"assistant";content:string};
export type FileEntry={name:string;type:"file"|"directory"};
export type PreviewState={running:boolean;port?:number};
