import { useEffect,useState } from "react";
import { getAuth } from "../../lib/auth-api";
import { AuthScreen } from "./AuthScreen";
import { WorkspaceShell } from "../workspace/WorkspaceShell";

export function AuthGate(){
  const [state,setState]=useState<"loading"|"authenticated"|"guest">("loading");
  const refresh=()=>{setState("loading");void getAuth().then(result=>setState(result.authenticated?"authenticated":"guest")).catch(()=>setState("guest"));};
  useEffect(()=>{refresh()},[]);
  if(state==="loading") return <div className="app-loading">Проверяем сессию…</div>;
  if(state==="guest") return <AuthScreen onAuthenticated={refresh}/>;
  return <WorkspaceShell/>;
}
