import { useState } from "react";
import { ArrowRight, ListChecks, Square } from "lucide-react";
import { PendingQuestion } from "./api";

export default function QuestionForm({ request, answers, onChange, onSubmit, onStop }: {
  request: PendingQuestion;
  answers: Record<string, string>;
  onChange: (answers: Record<string, string>) => void;
  onSubmit: (cancelled: boolean) => Promise<void>;
  onStop: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(cancelled: boolean) {
    if (busy) return;
    setBusy(true); setError("");
    try { await onSubmit(cancelled); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  return <form className="agent-question-form" onSubmit={(e) => { e.preventDefault(); void submit(false); }} aria-label={request.form.title}>
    <div className="agent-question-heading"><ListChecks size={18} /><div><strong>{request.form.title}</strong><span>Ответьте, чтобы агент продолжил задачу</span></div><button type="button" className="ghost-btn question-stop" onClick={onStop} title="Остановить задачу" aria-label="Остановить задачу"><Square size={12} /></button></div>
    <div className="agent-question-fields">{request.form.questions.map((q, i) => {
      const value = answers[q.id] || "";
      const inputId = `question-${request.call_id}-${q.id}`;
      return <fieldset key={q.id} disabled={busy}>
        <legend><span className="agent-question-number">{i + 1}</span>{q.label}{q.required === false && <small>Необязательно</small>}</legend>
        {!!q.options?.length && <div className="agent-question-options" role="group" aria-label={q.label}>{q.options.map((option) => <button type="button" key={option} aria-pressed={value === option} className={value === option ? "selected" : ""} onClick={() => onChange({ ...answers, [q.id]: option })}>{option}</button>)}</div>}
        <label className="sr-only" htmlFor={inputId}>{q.label}</label>
        {q.multiline ? <textarea id={inputId} autoFocus={i === 0} rows={3} maxLength={3000} required={q.required !== false} value={value} placeholder="Ваш ответ…" onChange={(e) => onChange({ ...answers, [q.id]: e.target.value })} /> : <input id={inputId} autoFocus={i === 0} maxLength={3000} required={q.required !== false} value={value} placeholder={q.options?.length ? "Выберите вариант или напишите свой ответ…" : "Ваш ответ…"} onChange={(e) => onChange({ ...answers, [q.id]: e.target.value })} />}
      </fieldset>;
    })}</div>
    {error && <p className="status err" role="alert">{error}</p>}
    <div className="agent-question-footer"><button className="ghost-btn small" type="button" disabled={busy} onClick={() => submit(true)}>Отменить вопросы</button><button className="btn-primary small" type="submit" disabled={busy || request.form.questions.some((q) => q.required !== false && !answers[q.id]?.trim())}>{busy ? "Отправляем…" : "Продолжить"}<ArrowRight size={15} /></button></div>
  </form>;
}
