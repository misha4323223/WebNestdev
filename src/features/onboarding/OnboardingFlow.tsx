import { useState, type FormEvent } from "react";
import {
  ArrowRight, BookOpen, Briefcase, Code2, Compass, GraduationCap, Heart,
  LayoutDashboard, Layers3, Megaphone, MessageCircle, Palette, Rocket, Search, Send,
  ShoppingBag, Smartphone, Sparkles, Users, type LucideIcon,
} from "lucide-react";
import { WebNestLogo } from "../../components/WebNestLogo";
import { realAccountEmail } from "../../lib/account-contact";
import { saveOnboardingProfile, saveOnboardingSource, type OnboardingAnswers } from "../../lib/onboarding";

/**
 * Знакомство после входа: контакты для связи, пять коротких вопросов и название проекта.
 *
 * Первый экран собирает имя и, по желанию, почту — на неё отвечают человеку. Согласия на письма
 * стоят флажками и не обязательны; рекламное включается только явно и только при наличии почты.
 * Дальше ответы сразу уходят агенту вместе с идеей, а источник знакомства сохраняется в профиле
 * для аналитики — агенту он не нужен.
 *
 * Форма как у Replit: один вопрос на экран, крупные варианты, шаг назад. Пропустить можно только
 * после того, как контакты сохранены: иначе аккаунт остался бы без данных для обратной связи.
 */

type AnswerKey = "role" | "level" | "build" | "goal" | "source";
type Option = { label: string; note: string; icon: LucideIcon };
type Question = { key: AnswerKey; eyebrow: string; title: string; hint: string; options: Option[] };

const questions: Question[] = [
  {
    key: "role",
    eyebrow: "О ВАС",
    title: "Чем вы занимаетесь?",
    hint: "Агент подстроит объяснения под вас: разработчику — короче, новичку — подробнее.",
    options: [
      { label: "Разработчик", note: "Пишу код и хочу ускорить рутину", icon: Code2 },
      { label: "Основатель или предприниматель", note: "Запускаю продукт или бизнес", icon: Rocket },
      { label: "Дизайнер", note: "Делаю интерфейсы и хочу собрать их вживую", icon: Palette },
      { label: "Студент", note: "Учусь и пробую новое", icon: GraduationCap },
      { label: "Менеджер проекта", note: "Собираю продукт вместе с командой", icon: Users },
      { label: "Другое", note: "Просто нужно сделать проект", icon: Sparkles },
    ],
  },
  {
    key: "level",
    eyebrow: "ОПЫТ",
    title: "Какой у вас опыт в разработке?",
    hint: "От этого зависит, что агент объясняет словами, а что просто делает.",
    options: [
      { label: "Первый проект", note: "Кода ещё не писал — ведите за руку", icon: BookOpen },
      { label: "Немного практики", note: "Знаю основы, делал небольшие проекты", icon: Compass },
      { label: "Уверенно", note: "Пишу код регулярно, нужен инструмент, а не урок", icon: Code2 },
    ],
  },
  {
    key: "build",
    eyebrow: "ЗАДАЧА",
    title: "Что хотите создать?",
    hint: "Можно передумать позже — выбор лишь задаёт первый план.",
    options: [
      { label: "Сайт или лендинг", note: "Презентация продукта, портфолио, визитка", icon: Compass },
      { label: "Интернет-магазин", note: "Каталог, корзина, оформление заказа", icon: ShoppingBag },
      { label: "Веб-приложение или SaaS", note: "Аккаунты, тарифы, личный кабинет", icon: Layers3 },
      { label: "Дашборд или внутренний инструмент", note: "Данные, отчёты, автоматизация", icon: LayoutDashboard },
      { label: "Мобильное приложение", note: "Экран под телефон или веб-приложение", icon: Smartphone },
      { label: "Пока не решил", note: "Помогите выбрать под задачу", icon: Sparkles },
    ],
  },
  {
    key: "goal",
    eyebrow: "ЦЕЛЬ",
    title: "Зачем вам NestDev?",
    hint: "Так агент поймёт, что важнее: скорость, аккуратность или обучение.",
    options: [
      { label: "Для работы и клиентов", note: "Проекты, которые нужно сдавать", icon: Briefcase },
      { label: "Для своего бизнеса", note: "Сайт или сервис для своей аудитории", icon: Rocket },
      { label: "Учёба и практика", note: "Разобраться, как это устроено", icon: GraduationCap },
      { label: "Личный проект", note: "Для себя и друзей", icon: Heart },
    ],
  },
  {
    key: "source",
    eyebrow: "ОТКУДА ВЫ",
    title: "Откуда вы о нас узнали?",
    hint: "Это поможет рассказывать о NestDev там, где вас действительно много.",
    options: [
      { label: "ВКонтакте", note: "Пост, сообщество или реклама", icon: MessageCircle },
      { label: "Telegram", note: "Канал, чат или реклама", icon: Send },
      { label: "Одноклассники", note: "Сообщество или объявление", icon: Users },
      { label: "Дзен", note: "Статья или рекомендация", icon: Compass },
      { label: "Поиск в интернете", note: "Яндекс, Google или другой поиск", icon: Search },
      { label: "Реклама", note: "Баннер или рекламное объявление", icon: Megaphone },
      { label: "Совет друга", note: "Коллега или знакомый рассказал", icon: Heart },
      { label: "Другое", note: "Хабр, конференция или что-то ещё", icon: Sparkles },
    ],
  },
];

/** Идея подставляется в подсказку поля: пустой лист — плохой первый вопрос. */
const ideaHints: Record<string, string> = {
  "Сайт или лендинг": "Например: лендинг студии дизайна с портфолио и формой заявки",
  "Интернет-магазин": "Например: магазин кофе с каталогом, корзиной и оплатой",
  "Веб-приложение или SaaS": "Например: сервис записи в барбершоп с личным кабинетом",
  "Дашборд или внутренний инструмент": "Например: дашборд заказов с фильтрами и выгрузкой",
  "Мобильное приложение": "Например: приложение тренировок с целями и статистикой",
  "Пока не решил": "Опиши задачу словами: для кого продукт и что он должен делать",
};

/** Проверка та же, что на сервере: без домена адрес не годится для ответа. */
function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

export function OnboardingFlow({ accountEmail, onStart, onSkip }: {
  accountEmail: string;
  /** Создаёт проект с ответами знакомства и открывает рабочую область. */
  onStart: (answers: OnboardingAnswers) => Promise<void>;
  /** Закрывает знакомство: контакты к этому моменту уже сохранены. */
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  // У входа по телефону адрес служебный — поле остаётся пустым, человек вписывает свою почту.
  const [email, setEmail] = useState(() => realAccountEmail(accountEmail));
  const [newsletter, setNewsletter] = useState(true);
  const [productUpdates, setProductUpdates] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<AnswerKey, string>>>({});
  const [projectName, setProjectName] = useState("Новый проект");
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finalStep = questions.length + 1;
  const question = step >= 1 && step <= questions.length ? questions[step - 1] : null;
  const onFinal = step === finalStep;
  // Почта необязательна: аккаунт может быть привязан к телефону. Но если её начали вводить,
  // адрес должен быть настоящим — иначе обещание «ответим на почту» станет ложным.
  const canSaveContact = name.trim().length >= 2 && (!email.trim() || validEmail(email));
  const canSubscribe = Boolean(email.trim());

  function choose(key: AnswerKey, label: string) {
    setAnswers(current => ({ ...current, [key]: label }));
  }

  /** Контакты уходят на сервер сразу: почта остаётся у нас, даже если человек уйдёт с вопросов. */
  async function submitContacts(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !canSaveContact) return;
    setBusy(true);
    setError("");
    try {
      await saveOnboardingProfile({
        name: name.trim(),
        email: email.trim(),
        newsletter,
        // Без почты рекламное согласие не имеет смысла: некуда отправлять.
        productUpdates: productUpdates && canSubscribe,
      });
      setProfileSaved(true);
      setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить контакты");
    } finally {
      setBusy(false);
    }
  }

  async function createProject(event?: FormEvent) {
    event?.preventDefault();
    if (busy || !idea.trim()) return;
    setBusy(true);
    setError("");
    try {
      // Источник сохраняется отдельно: он не нужен агенту, но нужен рассылке и аналитике.
      await saveOnboardingSource(answers.source ?? "Другое");
      await onStart({
        role: answers.role ?? "Другое",
        level: answers.level ?? "Немного практики",
        build: answers.build ?? "Пока не решил",
        goal: answers.goal ?? "Личный проект",
        idea: idea.trim(),
        projectName: projectName.trim() || "Новый проект",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step === 0) void submitContacts();
    else if (onFinal) void createProject();
  }

  return <div className="onboarding" role="dialog" aria-modal="true" aria-label="Знакомство перед началом проекта">
    <form className="onboarding-card" onSubmit={submit}>
      <header className="onboarding-head">
        <div className="onboarding-brand">
          <span className="onboarding-brand-mark"><WebNestLogo size={22} tone="light"/></span>
          <span>NestDev</span>
        </div>
        {/* Пропуск появляется только после сохранения контактов: имя и почта не должны теряться. */}
        {profileSaved
          ? <button type="button" className="ghost-button onboarding-skip" onClick={onSkip} disabled={busy}>Пропустить</button>
          : <span className="onboarding-head-note">Займёт меньше минуты</span>}
      </header>

      <div className="onboarding-progress" aria-hidden="true">
        {Array.from({ length: finalStep + 1 }, (_, index) => <span key={index}
          className={"onboarding-step" + (index < step ? " is-done" : index === step ? " is-current" : "")}/>)}
      </div>

      {step === 0 && <div className="onboarding-body">
        <span className="eyebrow">ЗНАКОМСТВО</span>
        <h1>Давайте познакомимся</h1>
        <p>Имя нужно, чтобы к вам обращаться. Почта — по желанию: на неё ответит поддержка, если вы к нам напишете. Рекламные письма — только по вашему согласию, и их можно отключить в любой момент.</p>
        <div className="onboarding-fields">
          <label className="onboarding-field">
            <span>Ваше имя</span>
            <input value={name} maxLength={80} autoFocus autoComplete="name"
              onChange={event => { setName(event.target.value); setError(""); }}
              placeholder="Как к вам обращаться" />
          </label>
          <label className="onboarding-field">
            <span>Email для связи · необязательно</span>
            <input type="email" value={email} maxLength={200} autoComplete="email" inputMode="email"
              onChange={event => {
                const next = event.target.value;
                setEmail(next);
                if (!next.trim()) setProductUpdates(false);
                setError("");
              }}
              placeholder="Можно не заполнять" />
          </label>
        </div>
        <div className="onboarding-checks">
          <label className={"onboarding-check" + (newsletter ? " is-on" : "")}>
            <input type="checkbox" checked={newsletter} onChange={event => setNewsletter(event.target.checked)} />
            <span><strong>Письма о работе сервиса</strong><small>Сбои, лимиты и важные изменения — только по делу.</small></span>
          </label>
          <label className={"onboarding-check" + (productUpdates ? " is-on" : "") + (canSubscribe ? "" : " is-disabled")}>
            <input type="checkbox" checked={productUpdates} disabled={!canSubscribe}
              onChange={event => setProductUpdates(event.target.checked)} />
            <span>
              <strong>Согласен(на) получать рекламные и информационные письма</strong>
              <small>
                {canSubscribe
                  ? <>Новости, обновления, тарифы и акции. Отдельное согласие, не условие регистрации. <a href="/legal/marketing" target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>Условия согласия</a>.</>
                  : "Укажите почту выше, если хотите получать новости и предложения."}
              </small>
            </span>
          </label>
        </div>
        {error && <div className="home-error onboarding-error">{error}</div>}
      </div>}

      {question && <div className="onboarding-body">
        <span className="eyebrow">{question.eyebrow}</span>
        <h1>{question.title}</h1>
        <p>{question.hint}</p>
        <div className="onboarding-options">
          {question.options.map(option => {
            const Icon = option.icon;
            const selected = answers[question.key] === option.label;
            return <button key={option.label} type="button"
              className={"onboarding-option" + (selected ? " is-selected" : "")}
              aria-pressed={selected}
              onClick={() => choose(question.key, option.label)}>
              <span className="onboarding-option-icon"><Icon size={15}/></span>
              <span className="onboarding-option-text"><strong>{option.label}</strong><small>{option.note}</small></span>
            </button>;
          })}
        </div>
      </div>}

      {onFinal && <div className="onboarding-body">
        <span className="eyebrow">ПОСЛЕДНИЙ ШАГ</span>
        <h1>Назовём и начнём</h1>
        <p>Агент уже знает, кто вы и что строите. Дальше он соберёт план и задаст пару уточнений в чате.</p>
        <label className="onboarding-field">
          <span>Название проекта</span>
          <input value={projectName} maxLength={80} onChange={event => setProjectName(event.target.value)} placeholder="Новый проект" />
        </label>
        <label className="onboarding-field">
          <span>Что создаём?</span>
          <textarea rows={3} value={idea} onChange={event => { setIdea(event.target.value); setError(""); }}
            placeholder={ideaHints[answers.build ?? ""] ?? "Опиши проект в одном-двух предложениях"} />
        </label>
        <div className="onboarding-summary">
          {[answers.role, answers.level, answers.build, answers.goal].filter(Boolean).map(value =>
            <span key={value}>{value}</span>)}
        </div>
        {error && <div className="home-error onboarding-error">{error}</div>}
      </div>}

      <footer className="onboarding-foot">
        {step > 0
          ? <button type="button" className="ghost-button" onClick={() => { setStep(step - 1); setError(""); }} disabled={busy}>Назад</button>
          : <span className="onboarding-foot-note">Данные увидит только команда NestDev</span>}
        {step === 0
          ? <button type="submit" className="send-button onboarding-next" disabled={busy || !canSaveContact}>
              {busy ? "Сохраняем…" : "Продолжить"} <ArrowRight size={14}/>
            </button>
          : onFinal
            ? <button type="submit" className="send-button onboarding-next" disabled={busy || !idea.trim()}>
                {busy ? "Создаём проект…" : "Создать проект"} <ArrowRight size={14}/>
              </button>
            : <button type="button" className="send-button onboarding-next"
                onClick={() => { setStep(step + 1); setError(""); }}
                disabled={!question || !answers[question.key]}>
                Далее <ArrowRight size={14}/>
              </button>}
      </footer>
    </form>
  </div>;
}
