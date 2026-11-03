import { ArrowRight, ClipboardList, Play, RotateCcw } from "lucide-react";
import type { PlanState } from "../../lib/types";
import { NestLoader } from "../../components/NestLoader";
import { QuestionSheet, type AgentQuestion } from "./QuestionSheet";

/**
 * Окно планирования нового проекта.
 *
 * Это не чат: человек видит только текущий вопрос и готовое резюме, без размышлений модели,
 * списка инструментов и служебных реплик. Планировщик уже остановлен на вопросе, поэтому окно
 * не спорит с остальной рабочей областью. Кнопка внизу переводит агента в разработчика и
 * отправляет утверждённый список шагов — до неё файлы не меняются.
 */
export function PlanningRoom({ title, loaded, question, questionBusy, questionError, onAnswer, onSkipQuestion, plan, running, resume, onContinue, onStart, onSkip }: {
  title: string;
  /** Чат уже прочитан: до этого «Собираю вопросы» — это ещё не зависание. */
  loaded: boolean;
  question: AgentQuestion | null;
  questionBusy: boolean;
  questionError: string;
  onAnswer: (answer: { selected: string[]; custom?: string }) => void;
  onSkipQuestion: () => void;
  plan: PlanState | null;
  running: boolean;
  resume: { label: string } | null;
  onContinue: () => void;
  onStart: () => void;
  onSkip: () => void;
}) {
  const ready = Boolean(plan?.items.length);
  return <section className="planning-room" aria-label="Планирование проекта">
    <div className="planning-room-inner">
      <header className="planning-room-head">
        <span className="planning-room-mark" aria-hidden="true"><ClipboardList size={18}/></span>
        <div className="planning-room-title">
          <span className="eyebrow">ПЛАНИРОВАНИЕ ПРОЕКТА</span>
          <h2>{title || "Новый проект"}</h2>
          <p>Ответьте на пару вопросов — агент соберёт резюме. Код начнётся только после перехода в разработку.</p>
        </div>
        <button type="button" className="ghost-button planning-room-skip" onClick={onSkip} disabled={questionBusy}>Пропустить</button>
      </header>

      <div className="planning-room-stage">
        {question
          ? <QuestionSheet
              key={question.requestId}
              embedded
              prompt={question}
              busy={questionBusy}
              error={questionError}
              onAnswer={onAnswer}
              onSkip={onSkipQuestion}
            />
          : ready && plan
            ? <>
                <section className="planning-summary" aria-labelledby="planning-summary-title">
                  <header className="planning-summary-head">
                    <span className="eyebrow">РЕЗЮМЕ ПРОЕКТА</span>
                    <h3 id="planning-summary-title">Что будем делать</h3>
                    <p>Проверьте детали. Дальше агент начнёт разработку по этому плану.</p>
                  </header>
                  <ol className="planning-summary-list">
                    {plan.items.map((item, index) => <li key={index}>
                      <span className="planning-summary-index" aria-hidden="true">{index + 1}</span>
                      <div>
                        <strong>{item.title}</strong>
                        {item.note && <small>{item.note}</small>}
                      </div>
                    </li>)}
                  </ol>
                </section>
                {running
                  ? <p className="planning-room-status" role="status"><NestLoader size={15} label="Дорабатываем резюме"/><span>Дорабатываю резюме…</span></p>
                  : <button type="button" className="send-button planning-room-start" onClick={onStart}>
                      Переключиться на разработчика <ArrowRight size={15}/>
                    </button>}
              </>
            : resume && !running
              ? <div className="planning-room-resume" role="status">
                  <span className="planning-room-resume-icon" aria-hidden="true"><RotateCcw size={16}/></span>
                  <div><strong>Планирование остановилось</strong><span>{resume.label}</span></div>
                  <button type="button" className="send-button" onClick={onContinue}><Play size={13}/> Продолжить</button>
                </div>
              : loaded && !running
                ? <div className="planning-room-empty" role="status">
                    <div><strong>Резюме пока не готово</strong><span>Можно перейти в разработку и описать задачу в чате.</span></div>
                    <button type="button" className="send-button" onClick={onStart}>
                      Переключиться на разработчика <ArrowRight size={15}/>
                    </button>
                  </div>
                : <div className="planning-room-wait" role="status" aria-live="polite">
                    <NestLoader size={30} label="Собираем вопросы"/>
                    <strong>Собираю вопросы…</strong>
                    <span>Агент смотрит на идею и готовит уточнения.</span>
                  </div>}
      </div>

      <footer className="planning-room-foot">
        <span>Файлы не меняются, пока вы в планировании</span>
      </footer>
    </div>
  </section>;
}
