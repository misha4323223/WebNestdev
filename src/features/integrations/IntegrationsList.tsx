import { BrandMark } from "../../components/BrandLogo";
import { GitHubConnect, type ConnectorSurface } from "../github/GitHubConnect";
import { YandexConnect } from "../yandex/YandexConnect";
import { CloudConnectors } from "./cloud/CloudConnectors";
import { DomainConnectors } from "./domains/DomainConnectors";
import { ServiceConnectors } from "./services/ServiceConnectors";
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
    <DatabaseConnect surface={surface}/>
    <GitHubConnect surface={surface} onImported={onImported}/>
    <YandexConnect/>
    <CloudConnectors/>
    <DomainConnectors/>
    <ServiceConnectors/>
    <ConnectorCard name="GitLab" icon={<BrandMark brand="gitlab" size={18}/>} status="disconnected" soon/>
  </div>;
}
