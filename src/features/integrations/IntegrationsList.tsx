import { GitBranch } from "lucide-react";
import { GitHubConnect, type ConnectorSurface } from "../github/GitHubConnect";
import { YandexConnect } from "../yandex/YandexConnect";
import { DatabaseConnect } from "../database/DatabaseConnect";
import { ConnectorCard } from "./ConnectorCard";

/**
 * The integrations catalog: every service is one card with a connect button and a
 * status indicator. GitHub, Yandex Cloud and the project database are live; the
 * remaining services are reserved slots that already use the same shape, so wiring
 * one up only means giving it a real status.
 */
export function IntegrationsList({surface="home",onImported}:{surface?:ConnectorSurface;onImported?:(projectId:string,conversationId:string)=>void}){
  return <div className="connectors">
    <DatabaseConnect/>
    <GitHubConnect surface={surface} onImported={onImported}/>
    <YandexConnect surface={surface}/>
    <ConnectorCard name="GitLab" icon={<GitBranch size={18}/>} status="disconnected" soon/>
  </div>;
}
