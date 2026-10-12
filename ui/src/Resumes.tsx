import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { BrainCircuit, ExternalLink, Eye, EyeOff, FileText, Pencil, Plus, RefreshCw } from "lucide-react";
import { api, isDemo, Resume, resumeHidden } from "./api";

export default function Resumes({ onCreate }: { onCreate: () => void }) {
  const [items, setItems] = useState<Resume[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  async function refresh() {
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const result = await api.getResumes();
      if (request === generation.current) { setItems(result.items || []); setLoaded(true); }
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setLoading(false); }
  }
  useEffect(() => {
    refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (!isDemo) listen("resumes-changed", onFocus).then((fn) => { if (disposed) fn(); else unlisten = fn; }).catch(() => {});
    return () => { disposed = true; generation.current++; unlisten?.(); window.removeEventListener("focus", onFocus); };
  }, []);
  async function action(key: string, run: () => Promise<unknown>, success?: string) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await run(); if (success) { await refresh(); setNotice(success); } }
    catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }
  return <section className="card resumes-card" aria-labelledby="resumes-heading">
    <div className="resumes-heading">
      <div><h2 id="resumes-heading">Мои резюме {loaded && <span className="resumes-count">{items.length}</span>}</h2><p>Ваш опыт и навыки — для следующего шага в карьере.</p></div>
      <button className="ghost-btn resume-refresh" onClick={refresh} disabled={loading || !!busy} aria-label="Обновить резюме" title="Обновить"><RefreshCw size={16} className={loading ? "spin" : ""} /></button>
    </div>
    <div className="resume-create-banner">
      <div className="resume-create-icon"><BrainCircuit size={22} /></div>
      <div className="resume-create-copy"><strong>Соберите резюме с агентом</strong><p>Он использует знания о вас и уточнит недостающие детали.</p></div>
      <button className="btn-primary small" onClick={onCreate}><Plus size={15} />Создать резюме</button>
    </div>
    {error && <p className="status err" role="alert">{error}</p>}
    {notice && <p className="status ok" role="status">{notice}</p>}
    {loading && !loaded && <div className="resume-empty" role="status">Загружаем резюме…</div>}
    {loaded && items.length === 0 && <div className="resume-empty"><FileText size={26} /><strong>Здесь появятся ваши резюме</strong><span>Создайте первое с агентом или заполните форму на hh.ru.</span></div>}
    <div className="resumes-list">{items.map((r, i) => {
      const published = r.status?.id === "published" && !resumeHidden(r);
      const pending = busy === r.id;
      const status = resumeHidden(r) && r.status?.id === "published" ? "Скрыто" : r.status?.name || (r.status?.id === "draft" ? "Черновик" : "Не опубликовано");
      const date = r.updated_at ? new Date(r.updated_at) : null;
      return <article className="resume-card" key={r.id || i}>
        <div className="resume-card-top"><div className="resume-file-icon"><FileText size={20} /></div><div className="resume-card-title"><h3>{r.title || "Без названия"}</h3><span>{date && !isNaN(date.getTime()) ? `Обновлено ${date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}` : "Дата обновления не указана"}</span></div><span className={"badge " + (published ? "published" : "")}>{published ? "Опубликовано" : status}</span></div>
        <div className="resume-card-footer"><div className="resume-card-stats"><Eye size={14} /><span>{r.total_views ?? r.views ?? 0} просмотров</span></div><div className="resume-card-actions">
          <button className="ghost-btn small" disabled={!!busy || !r.id} onClick={() => action(`edit-${r.id}`, () => api.openResumeEditor(r.id!))}><Pencil size={14} />Редактировать</button>
          <button className="ghost-btn small" disabled={!!busy || !r.id} onClick={() => action(r.id!, () => published ? api.unpublishResume(r.id!) : api.publishResume(r.id!), published ? "Резюме скрыто от работодателей." : "Резюме опубликовано.")}>{published ? <EyeOff size={14} /> : <Eye size={14} />}{pending ? "Сохраняем…" : published ? "Снять с публикации" : "Опубликовать"}</button>
        </div></div>
      </article>;
    })}</div>
    <div className="resumes-bottom"><span>Синхронизировано с hh.ru</span><button className="resume-site-link" disabled={!!busy} onClick={() => action("create-web", api.openResumeCreator)}>Создать на hh.ru<ExternalLink size={13} /></button></div>
  </section>;
}
