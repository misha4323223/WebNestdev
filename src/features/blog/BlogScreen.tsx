import { useEffect, useState, type MouseEvent } from "react";
import { ArrowLeft, ArrowUpRight, Clock } from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import { LEGAL_FOOTER_LINKS, SITE, SELLER, legalDoc, legalPath } from "../../lib/legal";
import { BLOG_POSTS, blogPath, blogPost, blogSlugFromPath, type BlogBlock, type BlogPost } from "./blog-posts";

/**
 * Информационный раздел: список материалов и страница статьи. Адреса обычные (`/blog`,
 * `/blog/<slug>`), входа не требуют — ссылку на статью можно отправить до регистрации.
 * Переходы внутри раздела идут через pushState, как в юридических документах, чтобы чтение
 * не теряло место прокрутки при возврате к списку.
 */
export function BlogScreen() {
  const [path, setPath] = useState(() => window.location.pathname);
  const slug = blogSlugFromPath(path);
  const post = slug ? blogPost(slug) : undefined;

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    document.title = post ? post.title + " — " + SITE.name : "Блог — " + SITE.name;
    // Описание страницы меняется вместе со статьёй: поисковик и превью ссылки должны
    // показывать то, о чём материал, а не заголовок сайта по умолчанию.
    const description = post
      ? post.summary
      : "Материалы о платформе NestDev: что на ней собирается, как выходит публикация, какие лимиты у тарифов и что агент проверяет перед сдачей.";
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    const previous = meta.content;
    meta.content = description;
    return () => {
      if (created) meta?.remove();
      else if (meta) meta.content = previous;
    };
  }, [post]);

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

  return <div className="legal-shell blog-shell">
    <header className="legal-top">
      <a className="legal-brand" {...linkProps(blogPath())} aria-label="Блог NestDev">
        <span className="brand-mark"><WebNestLogo size={22} tone="light"/></span>
        <span className="legal-brand-name">NestDev</span>
        <span className="legal-brand-sep">/</span>
        <span className="legal-brand-section">Блог</span>
      </a>
      <div className="legal-top-actions">
        <a className="ghost-button legal-back" href="/">
          <ArrowLeft size={13}/> <span>В приложение</span>
        </a>
      </div>
    </header>

    <main className="legal-main blog-main">
      {post
        ? <BlogArticle post={post} linkProps={linkProps}/>
        : <BlogHub linkProps={linkProps}/>}
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
        <nav className="legal-footer-links" aria-label="Документы">
          {LEGAL_FOOTER_LINKS.map(id => <a key={id} href={legalPath(id)}>{legalDoc(id).short}</a>)}
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

function BlogHub({ linkProps }: { linkProps: (to: string) => { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void } }) {
  const [featured, ...rest] = BLOG_POSTS;

  return <>
    <section className="legal-hero blog-hero">
      <span className="eyebrow">БЛОГ</span>
      <h1>Что можно сделать и как это работает</h1>
      <p>Материалы о платформе: что на ней собирается, как выходит публикация, какие лимиты у тарифов и что агент проверяет перед сдачей.</p>
    </section>

    <a className="blog-featured" {...linkProps(blogPath(featured.slug))}>
      <img src={featured.cover} width="1392" height="752" alt="" loading="eager" />
      <div className="blog-featured-body">
        <span className="blog-tag">{featured.tag} · {featured.minutes} мин</span>
        <h2>{featured.title}</h2>
        <p>{featured.summary}</p>
        <span className="blog-more">Читать <ArrowUpRight size={12}/></span>
      </div>
    </a>

    <div className="blog-grid">
      {rest.map(item => <a className="blog-card" key={item.slug} {...linkProps(blogPath(item.slug))}>
        <img src={item.cover} width="1392" height="752" alt="" loading="lazy" />
        <div className="blog-card-body">
          <span className="blog-tag">{item.tag} · {item.minutes} мин</span>
          <h3>{item.title}</h3>
          <p>{item.summary}</p>
        </div>
      </a>)}
    </div>
  </>;
}

function BlogArticle({ post, linkProps }: {
  post: BlogPost;
  linkProps: (to: string) => { href: string; onClick: (event: MouseEvent<HTMLAnchorElement>) => void };
}) {
  const related = BLOG_POSTS.filter(item => item.slug !== post.slug).slice(0, 2);

  return <article className="blog-post">
    <nav className="blog-crumbs" aria-label="Путь">
      <a {...linkProps(blogPath())}>Блог</a>
      <span>/</span>
      <span>{post.tag}</span>
    </nav>

    <header className="blog-post-head">
      <h1>{post.title}</h1>
      <div className="blog-post-meta">
        <span>{post.date}</span>
        <span className="blog-post-time"><Clock size={11}/> {post.minutes} мин</span>
      </div>
    </header>

    <img className="blog-post-cover" src={post.cover} width="1392" height="752" alt="" />

    <div className="blog-post-body">
      {post.blocks.map((block, index) => <BlogBlockView key={index} block={block}/>)}
    </div>

    <div className="blog-post-foot">
      <a className="blog-back" {...linkProps(blogPath())}><ArrowLeft size={12}/> Все материалы</a>
    </div>

    <section className="blog-related" aria-labelledby="blog-related-title">
      <h2 id="blog-related-title">Читайте также</h2>
      <div className="blog-related-grid">
        {related.map(item => <a key={item.slug} className="blog-related-card" {...linkProps(blogPath(item.slug))}>
          <span className="blog-tag">{item.tag}</span>
          <strong>{item.title}</strong>
          <span className="blog-related-more">Читать <ArrowUpRight size={11}/></span>
        </a>)}
      </div>
    </section>
  </article>;
}

function BlogBlockView({ block }: { block: BlogBlock }) {
  if ("h2" in block) return <h2>{block.h2}</h2>;
  if ("list" in block) return <ul>{block.list.map(item => <li key={item}>{item}</li>)}</ul>;
  if ("note" in block) return <p className="blog-note">{block.note}</p>;
  return <p>{block.p}</p>;
}
