import type { ReactNode } from "react";
import { Cloud, Code2, Database, Globe, Layers } from "lucide-react";
import { GitHubConnect, type ConnectorSurface } from "../github/GitHubConnect";
import { GitLabConnect } from "../gitlab/GitLabConnect";
import { RepoConnect } from "../repos/RepoConnect";
import { YandexConnect } from "../yandex/YandexConnect";
import { CloudConnectors } from "./cloud/CloudConnectors";
import { DomainConnectors } from "./domains/DomainConnectors";
import { ServiceConnectors } from "./services/ServiceConnectors";
import { DatabaseConnect } from "../database/DatabaseConnect";

/**
 * Одна категория каталога: заголовок с иконкой, короткое пояснение и карточки.
 *
 * Категории нужны, чтобы облака, базы, код и сервисы не сваливались в один список:
 * пользователь ищет «где база» или «где GitHub», а не листает все подряд. Заголовок
 * отделён линией и приглушён, поэтому он ведёт взгляд, но не спорит с карточками.
 */
function ConnectorSection({ icon, title, note, children }: { icon: ReactNode; title: string; note: string; children: ReactNode }) {
  return <section className="connector-section">
    <div className="connector-section-head">
      <span className="connector-section-icon">{icon}</span>
      <h3 className="connector-section-title">{title}</h3>
      <span className="connector-section-rule"/>
    </div>
    <p className="connector-section-note">{note}</p>
    {children}
  </section>;
}

/**
 * Каталог интеграций: каждая категория — свой заголовок, внутри — карточки одного вида.
 * Yandex Cloud стоит вместе с остальными облаками, база данных — в «Базах», GitHub и
 * GitLab — в «Коде», чтобы ни один коннектор не висел над списком без объяснения.
 */
export function IntegrationsList({surface="home",onImported}:{surface?:ConnectorSurface;onImported?:(projectId:string,conversationId:string)=>void}){
  return <div className="connectors">
    <ConnectorSection icon={<Database size={12}/>} title="Базы данных" note="Своя база для проекта — PostgreSQL, MySQL, MongoDB, Redis и Yandex YDB.">
      <DatabaseConnect surface={surface}/>
    </ConnectorSection>

    <ConnectorSection icon={<Code2 size={12}/>} title="Код и репозитории" note="Импорт проекта из GitHub, GitLab, GitVerse или SourceCraft и работа агента с репозиторием.">
      <GitHubConnect surface={surface} onImported={onImported}/>
      <GitLabConnect surface={surface} onImported={onImported}/>
      <RepoConnect provider="gitverse" surface={surface} onImported={onImported}/>
      <RepoConnect provider="sourcecraft" surface={surface} onImported={onImported}/>
    </ConnectorSection>

    <ConnectorSection icon={<Cloud size={12}/>} title="Облака" note="Виртуальные машины, диски, бакеты и базы.">
      <YandexConnect/>
      <CloudConnectors/>
    </ConnectorSection>

    <ConnectorSection icon={<Globe size={12}/>} title="Домены" note="Регистраторы доменов с доступом по API-ключу.">
      <DomainConnectors/>
    </ConnectorSection>

    <ConnectorSection icon={<Layers size={12}/>} title="Сервисы" note="Почта, оплата, AI, карты, CRM и файлы.">
      <ServiceConnectors/>
    </ConnectorSection>
  </div>;
}
