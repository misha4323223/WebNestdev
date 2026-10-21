import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ArrowLeft, ArrowUpRight, Check, Cookie, FileText, Printer, ShieldCheck } from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import {
  LEGAL_DOCS,
  LEGAL_FOOTER_LINKS,
  REQUISITE_HINTS,
  SITE,
  SELLER,
  legalDoc,
  legalDocFromPath,
  legalPath,
  requisite,
  type LegalDocId,
} from "../../lib/legal";
import { LEGAL_CONTENT, type LegalBlock } from "./legal-docs";
import { openCookieSettings } from "./CookieConsent";

/**
 * Юридические страницы живут по обычным адресам (`/legal/offer` и т. д.), а не внутри приложения:
 * их нужно открыть без входа, отправить ссылкой в платёжный сервис и распечатать. Сервер отдаёт
 * на любой такой адрес тот же документ панели, поэтому перезагрузка и прямая ссылка работают.
 *
 * Переходы внутри раздела сделаны без полной перезагрузки: pushState обновляет адрес, и страница
 * не теряет место прокрутки при чтении.
 */
export function LegalScreen() {
  const [path, setPath] = useState(() => window.location.pathname);
  const docId = legalDocFromPath(path);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = docId ? legalDoc(docId).title + " — " + SITE.name : "Документы — " + SITE.name;
  }, [docId]);

  function go(to: string) {
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function linkProps(to: string) {
    return {
      href: to,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        // Ctrl/Cmd-клик и средняя кнопка должны открывать новую вкладку как обычно.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        go(to);
      },
    };
  }

  return <div className="legal-shell">
    <header className="legal-top">
      <a className="legal-brand" {...linkProps("/legal")} aria-label="Все документы NestDev">
        <span className="brand-mark"><WebNestLogo size={22} tone="light"/></span>
        <span className="legal-brand-name">NestDev</span>
        <span className="legal-brand-sep">/</span>
        <span className="legal-brand-section">Документы</span>
      </a>
      <div className="legal-top-actions">
        <button type="button" className="ghost-button legal-print" onClick={() => window.print()} title="Распечатать или сохранить в PDF">
          <Printer size={13}/> <span>Печать</span>
        </button>
        <a className="ghost-button legal-back" href="/">
          <ArrowLeft size={13}/> <span>В приложение</span>
        </a>
      </div>
    </header>

    <main className="legal-main" id="legal-content">
      {docId ? <LegalDocumentView
        docId={docId}
        linkProps={linkProps}
        onCookieSettings={openCookieSettings}
      /> : <LegalHub linkProps={linkProps} />}
    </main>

    <footer className="legal-footer">
      <div className="legal-footer-main">
        <div className="legal-footer-brand">
          <span className="brand-mark"><WebNestLogo size={20} tone="light"/></span>
          <div>
            <strong>{SITE.name}</strong>
            <span>Среда разработки с ИИ-агентом</span>
          </div>
        </div>
        <nav className="legal-footer-links" aria-label="Юридические документы">
          {LEGAL_FOOTER_LINKS.map(id => <a key={id} {...linkProps(legalPath(id))}>{legalDoc(id).short}</a>)}
          <button type="button" className="legal-footer-cookie" onClick={openCookieSettings}><Cookie size={11}/> Cookie-настройки</button>
        </nav>
      </div>
      <div className="legal-footer-meta">
        <span>© {new Date().getFullYear()} {SITE.name}</span>
        <span>Редакция {SITE.version} · {SITE.updated}</span>
        <span>ИНН {SELLER.inn}</span>
      </div>
    </footer>
  </div>;
}

function LegalHub({ linkProps }: { linkProps: (to: string) => { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void } }) {
  const groups = useMemo(() => {
    const order = ["Договор", "Данные", "Оплата", "Согласия", "Сведения"] as const;
    return order
      .map(group => ({ group, docs: LEGAL_DOCS.filter(doc => doc.group === group) }))
      .filter(entry => entry.docs.length > 0);
  }, []);
  const pending = [
    requisite(SELLER.fullName, REQUISITE_HINTS.fullName),
    requisite(SELLER.city, REQUISITE_HINTS.city),
  ].filter(item => item.pending);

  return <>
    <section className="legal-hero">
      <span className="eyebrow">ДОКУМЕНТЫ</span>
      <h1>Правила и документы NestDev</h1>
      <p>Здесь собрано всё, что определяет отношения между вами и сервисом: договор, правила использования, обработка данных, оплата и возврат. Документы открываются без входа и доступны по прямой ссылке.</p>
    </section>

    <div className="legal-groups">
      {groups.map(({ group, docs }) => <section className="legal-group" key={group}>
        <h2>{group}</h2>
        <div className="legal-cards">
          {docs.map(doc => <a className="legal-card" key={doc.id} {...linkProps(legalPath(doc.id))}>
            <span className="legal-card-icon" aria-hidden="true">{doc.group === "Данные" ? <ShieldCheck size={15}/> : <FileText size={15}/>}</span>
            <span className="legal-card-text">
              <strong>{doc.title}</strong>
              <small>{doc.summary}</small>
            </span>
            <ArrowUpRight size={14} className="legal-card-arrow"/>
          </a>)}
        </div>
      </section>)}
    </div>

    <section className="legal-summary">
      <div>
        <span className="eyebrow">ИСПОЛНИТЕЛЬ</span>
        <h2>{SELLER.status}</h2>
        <p>ИНН {SELLER.inn}. Услуги оказываются дистанционно на территории РФ. Связаться с поддержкой: <a href={"mailto:" + SELLER.email}>{SELLER.email}</a>, <a href={"tel:" + SELLER.phoneHref}>{SELLER.phone}</a>.</p>
      </div>
      <a className="legal-summary-link" {...linkProps(legalPath("contacts"))}>Реквизиты и контакты <ArrowUpRight size={13}/></a>
    </section>

    {pending.length > 0 && <p className="legal-pending-note">{pending.length === 1
      ? "В реквизитах осталось незаполненное поле: " + pending[0].text + ". Его нужно заполнить до публикации."
      : "В реквизитах остались незаполненные поля: " + pending.map(item => item.text).join(", ") + ". Их нужно заполнить до публикации."}</p>}
  </>;
}

function LegalDocumentView({ docId, linkProps, onCookieSettings }: {
  docId: LegalDocId;
  linkProps: (to: string) => { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };
  onCookieSettings: () => void;
}) {
  const doc = LEGAL_CONTENT[docId];
  const meta = legalDoc(docId);
  const otherDocs = LEGAL_FOOTER_LINKS.filter(id => id !== docId);

  return <div className="legal-doc-layout">
    <article className="legal-doc">
      <nav className="legal-crumbs" aria-label="Путь">
        <a {...linkProps("/legal")}>Документы</a>
        <span>/</span>
        <span>{meta.short}</span>
      </nav>

      <header className="legal-doc-head">
        <span className="eyebrow">{meta.group.toUpperCase()}</span>
        <h1>{meta.title}</h1>
        <div className="legal-doc-meta">
          <span>Редакция {SITE.version}</span>
          <span>Обновлено {SITE.updated}</span>
          <span>Вступает в силу с даты публикации</span>
        </div>
        <p className="legal-doc-lead">{doc.lead}</p>
      </header>

      <details className="legal-toc-mobile">
        <summary>Содержание</summary>
        <ol>{doc.sections.map((section, index) => <li key={section.title}><a href={"#sec-" + (index + 1)}>{section.title}</a></li>)}</ol>
      </details>

      <div className="legal-doc-body">
        {doc.sections.map((section, index) => <section className="legal-section" id={"sec-" + (index + 1)} key={section.title}>
          <h2>{section.title}</h2>
          {section.blocks.map((block, blockIndex) => <LegalBlockView key={blockIndex} block={block} onCookieSettings={onCookieSettings}/>)}
        </section>)}
      </div>

      <div className="legal-doc-foot">
        <div>
          <strong>Нужна помощь с документом?</strong>
          <span>Напишите на <a href={"mailto:" + SELLER.email}>{SELLER.email}</a> — ответим в рабочие часы.</span>
        </div>
        <button type="button" className="ghost-button" onClick={() => window.print()}><Printer size={13}/> Печать</button>
      </div>

      <nav className="legal-other" aria-label="Другие документы">
        <span className="eyebrow">СМОТРИТЕ ТАКЖЕ</span>
        <div>
          {otherDocs.map(id => <a key={id} {...linkProps(legalPath(id))}>{legalDoc(id).short}</a>)}
          <button type="button" className="legal-other-cookie" onClick={onCookieSettings}><Cookie size={11}/> Cookie-настройки</button>
        </div>
      </nav>
    </article>

    <aside className="legal-side" aria-label="Содержание документа">
      <div className="legal-side-inner">
        <span className="eyebrow">СОДЕРЖАНИЕ</span>
        <ol>{doc.sections.map((section, index) => <li key={section.title}><a href={"#sec-" + (index + 1)}>{section.title}</a></li>)}</ol>
        <div className="legal-side-doc">
          <strong>{meta.title}</strong>
          <span>{SITE.updated}</span>
        </div>
      </div>
    </aside>
  </div>;
}

function LegalBlockView({ block, onCookieSettings }: { block: LegalBlock; onCookieSettings: () => void }) {
  if (typeof block === "string") return <p>{block}</p>;
  if ("list" in block) return <ul>{block.list.map(item => <li key={item}>{item}</li>)}</ul>;
  if ("table" in block) return <div className="legal-table-wrap">
    <table>
      <thead><tr>{block.table.head.map(cell => <th key={cell}>{cell}</th>)}</tr></thead>
      <tbody>{block.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => cellIndex === 0
        ? <th key={cellIndex} scope="row">{cell}</th>
        : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>;
  if ("note" in block) return <p className="legal-note">{block.note}</p>;
  return <Requisites onCookieSettings={onCookieSettings}/>;
}

function Requisites({ onCookieSettings }: { onCookieSettings: () => void }) {
  const fullName = requisite(SELLER.fullName, REQUISITE_HINTS.fullName);

  return <div className="legal-requisites">
    <dl>
      <div><dt>Исполнитель</dt><dd>{SELLER.status}</dd></div>
      <div><dt>ФИО</dt><dd>{fullName.pending ? <Pending text={fullName.text}/> : fullName.text}</dd></div>
      <div><dt>ИНН</dt><dd className="legal-mono">{SELLER.inn}</dd></div>
      <div><dt>Электронная почта</dt><dd><a href={"mailto:" + SELLER.email}>{SELLER.email}</a></dd></div>
      <div><dt>Телефон</dt><dd><a href={"tel:" + SELLER.phoneHref}>{SELLER.phone}</a></dd></div>
      <div><dt>Часы поддержки</dt><dd>{SELLER.supportHours}</dd></div>
      <div><dt>Сайт</dt><dd><a href={SELLER.site} target="_blank" rel="noopener noreferrer">nestdev.ru <ArrowUpRight size={11}/></a></dd></div>
    </dl>
    <div className="legal-requisites-foot">
      <span><Check size={11}/> Услуги оказываются дистанционно на территории РФ</span>
      <button type="button" onClick={onCookieSettings}><Cookie size={11}/> Cookie-настройки</button>
    </div>
  </div>;
}

function Pending({ text }: { text: string }) {
  return <span className="legal-pending" title="Поле не заполнено">{text}</span>;
}
