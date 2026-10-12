import { useEffect, useState } from "react";
import { Check, ChevronDown, Circle, CirclePause, Copy, ListChecks, Play, X } from "lucide-react";
import { TodoPlan as Plan, TodoStatus } from "./api";

const labels: Record<TodoStatus, string> = {
  pending: "Ожидает", in_progress: "В работе", completed: "Готово", blocked: "Заблокировано", cancelled: "Отменено",
};

export default function TodoPlan({ plans, working, onResume }: {
  plans: Plan[];
  working: boolean;
  onResume: (plan: Plan) => void;
}) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState("");
  const [copied, setCopied] = useState(false);
  const active = [...plans].reverse().find((p) => !p.archived && p.items.some((i) => !["completed", "cancelled"].includes(i.status)))
    || [...plans].reverse().find((p) => !p.archived) || plans[plans.length - 1];
  useEffect(() => { setSelected(""); setOpen(true); }, [active?.id]);
  const plan = plans.find((p) => p.id === selected) || active;
  if (!plan) return null;
  const completed = plan.items.filter((i) => i.status === "completed").length;
  const cancelled = plan.items.filter((i) => i.status === "cancelled").length;
  const remaining = plan.items.length - completed - cancelled;
  const blocked = plan.items.some((i) => i.status === "blocked");
  const current = plan.items.find((i) => i.status === "in_progress");
  const status = plan.archived ? "Архив" : !remaining ? (cancelled === plan.items.length ? "Отменён" : "Завершён")
    : working ? (current ? "В работе" : blocked ? "Ждёт уточнений" : "Планирует") : blocked ? "Есть препятствия" : "На паузе";
  const percent = Math.round((completed + cancelled) / plan.items.length * 100);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${plan.title}\n${plan.items.map((i) => `- [${i.status === "completed" ? "x" : " "}] ${i.text} — ${labels[i.status]}${i.note ? `: ${i.note}` : ""}`).join("\n")}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { setCopied(false); }
  }

  return <section className={"todo-plan" + (!remaining && completed > 0 ? " finished" : "")} aria-label="План задачи">
    <button className="todo-plan-head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? "Свернуть план" : "Развернуть план"}>
      <ListChecks size={17} className="todo-plan-icon" aria-hidden="true" />
      <span className="todo-plan-heading"><span className="todo-plan-eyebrow">План задачи <span className="todo-plan-status">{status}</span></span>
        <span className="todo-plan-title">{plan.title}</span></span>
      <span className="todo-plan-count" title={`${completed} выполнено, ${cancelled} отменено, ${remaining} осталось`}>{completed}/{plan.items.length}</span>
      <ChevronDown size={15} className={"todo-plan-chevron" + (open ? " open" : "")} aria-hidden="true" />
    </button>
    <div className="todo-plan-progress" role="progressbar" aria-label="Завершённые и отменённые шаги" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${completed} выполнено, ${cancelled} отменено, ${remaining} осталось`}><span style={{ width: `${percent}%` }} /></div>
    {open && <>
      <ol className="todo-plan-items">
        {plan.items.map((item) => <li key={item.id} className={`todo-item ${item.status}`}>
          <span className="todo-item-mark" title={labels[item.status]} aria-label={labels[item.status]}>
            {item.status === "completed" ? <Check size={12} strokeWidth={2.6} /> : item.status === "cancelled" ? <X size={12} /> : item.status === "blocked" ? <CirclePause size={16} /> : item.status === "in_progress" ? (working && !plan.archived ? <span className="tool-spinner" /> : <CirclePause size={16} />) : <Circle size={15} />}
          </span>
          <div className="todo-item-content"><div className="todo-item-line"><span className="todo-item-text">{item.text}</span>
            {["in_progress", "blocked", "cancelled"].includes(item.status) && <span className="todo-item-status">{item.status === "in_progress" && !working ? "На паузе" : labels[item.status]}</span>}</div>
            {item.note && <p className="todo-item-note">{item.note}</p>}
          </div>
        </li>)}
      </ol>
      <div className="todo-plan-footer">
        {plans.length > 1 ? <select aria-label="Выбрать план из истории" value={plan.id} onChange={(e) => setSelected(e.target.value)}>
          {[...plans].reverse().map((p) => <option key={p.id} value={p.id}>{p.title}{p.archived ? " · Архив" : ""}</option>)}
        </select> : <span className="todo-plan-footnote">{remaining ? `${remaining} осталось` : cancelled ? `${cancelled} отменено` : "Все шаги выполнены"}</span>}
        <button className="todo-plan-action" type="button" onClick={copy} title="Скопировать план" aria-label={copied ? "План скопирован" : "Скопировать план"}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        {!working && !plan.archived && remaining > 0 && <button className="todo-plan-action resume" type="button" onClick={() => onResume(plan)}><Play size={12} />Продолжить</button>}
      </div>
    </>}
    {!open && current && remaining > 0 && <div className="todo-plan-current">{working ? "Сейчас" : "Следующий шаг"}: {current.text}</div>}
  </section>;
}
