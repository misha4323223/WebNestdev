import { dockerExec } from "./docker-exec.js";

/**
 * The preview container has to sit on a network the server can actually reach. In production
 * the server itself runs in a container and Docker isolates bridge networks from each other,
 * so the preview joins the server's own network by default; PREVIEW_NETWORK pins another one
 * and an empty result keeps the Docker default (the local case, where the server is the host
 * and reaches the container address directly).
 */
export async function previewNetwork(){
  const configured=process.env.PREVIEW_NETWORK?.trim();
  if(configured)return configured;
  const hostname=process.env.HOSTNAME?.trim();
  if(!hostname)return "";
  const result=await dockerExec(["inspect","-f","{{range $name,$value := .NetworkSettings.Networks}}{{$name}}\n{{end}}",hostname],5000).catch(()=>null);
  if(!result||result.code!==0)return "";
  return result.stdout.split("\n").map(value=>value.trim()).filter(Boolean)[0]??"";
}
