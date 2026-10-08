import { useEffect,useState } from "react";
import { getAuth } from "../../lib/auth-api";
import { AuthScreen } from "./AuthScreen";
import { WorkspaceShell } from "../workspace/WorkspaceShell";
import { HomeScreen } from "../home/HomeScreen";
import { NestLoader } from "../../components/NestLoader";

export function AuthGate(){
  const [state,setState]=useState<"loading"|"authenticated"|"guest">("loading");
  const [home,setHome]=useState(true);
  const refresh=()=>{setState("loading");void getAuth().then(result=>setState(result.authenticated?"authenticated":"guest")).catch(()=>setState("guest"));};
  useEffect(()=>{refresh()},[]);
  if(state==="loading") return <div className="app-loading"><NestLoader size={58} label="Проверяем сессию"/><strong>Проверяем сессию…</strong><span>Подготавливаем ваше рабочее пространство</span></div>;
  if(state==="guest") return <AuthScreen onAuthenticated={refresh}/>;
  if(home) return <HomeScreen onOpenWorkspace={()=>setHome(false)}/>;
  return <WorkspaceShell/>;
}
