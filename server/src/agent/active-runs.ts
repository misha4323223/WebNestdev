/**
 * Runs currently in flight, per project. A preview must not be stopped for idleness while the
 * agent is still working on that project: the run may be mid-thought and only touch the
 * preview a minute later during verification. The runtime is the only place that knows a run
 * exists, so it reports here.
 */
const active=new Map<string,number>();

export function beginRun(projectId:string){
  active.set(projectId,(active.get(projectId)??0)+1);
}

export function endRun(projectId:string){
  const next=(active.get(projectId)??0)-1;
  if(next>0)active.set(projectId,next);
  else active.delete(projectId);
}

export function isRunActive(projectId:string){
  return (active.get(projectId)??0)>0;
}
