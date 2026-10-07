import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, AgentStore, AgentMode, AGENT_MODES, ChatEvent, ChatSummary, ModelEntry, loadAllModels, parseModelValue } from "./api";
import ModelSelect from "./ModelSelect";
import Markdown from "./Markdown";

// Хронологические сегменты ответа агента: текст, размышления и вызовы
// инструментов идут в том порядке, в каком происходили.
type Part =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      name: string;
      label: string;
      status: "running" | "done";
      args?: Record<string, unknown>;
      result?: string;
    };

interface ConfirmRun {
  call_id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "pending" | "allowed" | "denied";
}

interface ChatEntry {
  role: "user" | "assistant";
  parts: Part[];
  streaming?: boolean;
  error?: string;
  confirms?: ConfirmRun[];
  // блок «Ход работы» раскрыт (во время стрима — по умолчанию да)
  processOpen?: boolean;
}

function toolLabel(name: string, args?: Record<string, unknown>): string {
  if (name === "web_search") {
    const q = args?.query as string | undefined;
    return q ? `Ищет в сети: «${q}»` : "Ищет в сети";
  }
  if (name === "fetch_url") {
    const u = args?.url as string | undefined;
    return u ? `Читает: ${u}` : "Читает страницу";
  }
  if (name === "list_resumes") return "Смотрит резюме на hh.ru";
  if (name === "read_resume") return "Читает резюме на hh.ru";
  if (name === "search_vacancies") return "Ищет вакансии на hh.ru";
  if (name === "read_profile") return "Читает ваш профиль";
  if (name === "prepare_resume_texts") return "Готовит тексты для резюме";
  if (name === "set_theme") {
    const t = args?.theme as string | undefined;
    return t === "dark" ? "Включает тёмную тему" : t === "light" ? "Включает светлую тему" : t === "system" ? "Ставит системную тему" : "Меняет тему";
  }
  if (name === "navigate") {
    const tab = args?.tab as string | undefined;
    if (tab === "profile") return "Открывает раздел «Профиль»";
    if (tab === "settings") return "Открывает настройки";
    return "Открывает чат";
  }
  if (name === "update_profile") return "Запоминает сведения о вас";
  if (name === "unpublish_resume") return "Снимает резюме с публикации";
  if (name === "publish_resume") return "Публикует резюме";
  if (name === "edit_resume") return "Открывает редактирование резюме";
  return name;
}

// краткая сводка свёрнутого блока «Ход работы»
function processSummary(parts: Part[]): string {
  const bits: string[] = [];
  for (const p of parts) {
    if (p.kind === "thinking" && !bits.includes("размышлял")) bits.push("размышлял");
    if (p.kind === "tool") {
      const verb =
        p.name === "web_search" ? "искал в сети"
        : p.name === "fetch_url" ? "читал страницы"
        : p.name === "list_resumes" ? "смотрел резюме"
        : p.name === "set_theme" ? "менял тему"
        : p.name === "navigate" ? "открывал разделы"
        : p.name === "update_profile" ? "запоминал о вас"
        : p.name === "read_profile" ? "читал ваш профиль"
        : p.name === "search_vacancies" ? "искал вакансии"
        : p.name === "unpublish_resume" ? "снимал резюме с публикации"
        : p.name === "publish_resume" ? "публиковал резюме"
        : p.name === "edit_resume" ? "открывал редактирование резюме"
        : p.name;
      if (!bits.includes(verb)) bits.push(verb);
    }
  }
  return bits.join(" · ");
}

// восстановление сегментов из сохранённого чата: берём полный ход работы,
// если он записан, иначе обычный текст
function restoreParts(m: {
  content: string;
  parts?: { kind: string; text?: string; name?: string; args?: Record<string, unknown>; result?: string; label?: string; status?: string }[];
}): Part[] {
  if (m.parts && m.parts.length > 0) {
    const parts: Part[] = [];
    for (const p of m.parts) {
      if (p.kind === "text" && p.text) parts.push({ kind: "text", text: p.text });
      else if (p.kind === "thinking" && p.text) parts.push({ kind: "thinking", text: p.text });
      else if (p.kind === "tool" && p.name)
        parts.push({
          kind: "tool",
          name: p.name,
          label: p.label || toolLabel(p.name, p.args),
          status: "done",
          args: p.args,
          result: p.result,
        });
    }
    if (parts.length > 0) return parts;
  }
  return m.content ? [{ kind: "text", text: m.content }] : [];
}

function newChatId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// ---------------------------------------------------------------- чат

export default function Chat({
  store,
  mode,
  onMode,
  onTheme,
  onNavigate,
}: {
  store: AgentStore;
  mode: AgentMode;
  onMode: (m: AgentMode) => void;
  onTheme: (t: "light" | "dark" | "system") => void;
  onNavigate: (tab: "chat" | "profile" | "settings") => void;
}) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [modelEntries, setModelEntries] = useState<ModelEntry[]>([]);
  const [chatModel, setChatModel] = useState(
    () => localStorage.getItem("chat_model") || ""
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const allowedNamesRef = useRef<Set<string>>(new Set());

  const active =
    store.active !== null && store.active < store.providers.length
      ? store.providers[store.active]
      : null;

  // сигнатура провайдеров: адреса, ключи и игнорируемые модели —
  // при любом изменении список моделей перечитывается заново
  const providersSig = JSON.stringify(
    store.providers.map((p) => [p.base_url, p.api_key, p.ignored_models])
  );

  // общий список моделей всех провайдеров (игнорируемые вычтены);
  // выбранная модель может принадлежать любому провайдеру — запрос идёт к нему
  useEffect(() => {
    if (!store.providers.length) return;
    let cancelled = false;
    loadAllModels(store)
      .then((list) => {
        if (cancelled) return;
        setModelEntries(list);
        setChatModel((cur) => {
          // уже валидный выбор вида «провайдер::модель»
          if (cur && list.some((e) => e.value === cur)) return cur;
          const legacy = parseModelValue(cur);
          const pick =
            (legacy.model && list.find((e) => e.model === legacy.model)) ||
            (store.agent_model && list.find((e) => e.model === store.agent_model)) ||
            (active?.model && list.find((e) => e.model === active.model)) ||
            list[0];
          const val = pick?.value || cur;
          if (val) localStorage.setItem("chat_model", val);
          return val;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [providersSig]);

  // история чатов. Порядок в списке стабильный, пока приложение открыто:
  // обновление чата не перемещает его, новые появляются сверху
  function refreshChats() {
    api
      .chatsList()
      .then((list) =>
        setChats((prev) => {
          const order = new Map(prev.map((c, i) => [c.id, i]));
          const known = list
            .filter((c) => order.has(c.id))
            .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
          const fresh = list.filter((c) => !order.has(c.id));
          return [...fresh, ...known];
        })
      )
      .catch(() => {});
  }
  useEffect(refreshChats, []);

  // очистка истории из настроек: обновляем список и закрываем открытый чат
  useEffect(() => {
    const onCleared = () => {
      setChats([]);
      setCurrentId(null);
      setEntries([]);
    };
    window.addEventListener("hh-chats-cleared", onCleared);
    return () => window.removeEventListener("hh-chats-cleared", onCleared);
  }, []);

  // автоскролл: держимся низа, пока пользователь сам не отлистал вверх
  function scrollToEnd(force = false) {
    const el = scrollRef.current;
    if (!el) return;
    if (force || stickBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }
  useLayoutEffect(() => scrollToEnd(), [entries]);

  function openChat(id: string) {
    if (streaming) return;
    setCurrentId(id);
    api
      .chatGet(id)
      .then((msgs) =>
        setEntries(msgs.map((m) => ({ role: m.role, parts: restoreParts(m) })))
      )
      .catch(() => {});
  }

  function newChat() {
    if (streaming) return;
    setCurrentId(null);
    setEntries([]);
  }

  function deleteChat(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    api.chatDelete(id).then(() => {
      setChats((cs) => cs.filter((c) => c.id !== id));
      if (currentId === id) {
        setCurrentId(null);
        setEntries([]);
      }
    });
  }

  const handleEvent = useCallback(
    (e: ChatEvent) => {
      setEntries((prev) => {
        const last = prev[prev.length - 1];
        const ensureAssistant = (): ChatEntry[] => {
          if (last && last.role === "assistant" && last.streaming) return prev;
          return [...prev, { role: "assistant", parts: [], streaming: true, processOpen: true }];
        };
        const patchLast = (patch: (e0: ChatEntry) => ChatEntry): ChatEntry[] => {
          const next = ensureAssistant();
          const lastA = next[next.length - 1];
          return [...next.slice(0, -1), patch(lastA)];
        };

        switch (e.type) {
          case "delta":
            return patchLast((e0) => {
              const parts = [...e0.parts];
              const lastP = parts[parts.length - 1];
              if (lastP && lastP.kind === "text") {
                parts[parts.length - 1] = { ...lastP, text: lastP.text + e.content };
              } else {
                parts.push({ kind: "text", text: e.content });
              }
              return { ...e0, parts };
            });
          case "reasoning":
            return patchLast((e0) => {
              const parts = [...e0.parts];
              const lastP = parts[parts.length - 1];
              if (lastP && lastP.kind === "thinking") {
                parts[parts.length - 1] = { ...lastP, text: lastP.text + e.content };
              } else {
                parts.push({ kind: "thinking", text: e.content });
              }
              return { ...e0, parts };
            });
          case "tool_start":
            return patchLast((e0) => ({
              ...e0,
              parts: [
                ...e0.parts,
                {
                  kind: "tool",
                  name: e.name,
                  label: toolLabel(e.name, e.args),
                  status: "running",
                  args: e.args,
                },
              ],
            }));
          case "tool_end":
            return patchLast((e0) => ({
              ...e0,
              parts: e0.parts.map((p) =>
                p.kind === "tool" && p.name === e.name && p.status === "running"
                  ? { ...p, status: "done" as const, result: e.result }
                  : p
              ),
            }));
          case "confirm_request": {
            // «всегда разрешать» — отвечаем молча, без карточки
            if (allowedNamesRef.current.has(e.name) && currentId) {
              api.chatConfirm(currentId, e.call_id, "allow");
              return prev;
            }
            return patchLast((e0) => ({
              ...e0,
              confirms: [
                ...(e0.confirms || []),
                { call_id: e.call_id, name: e.name, args: e.args, status: "pending" },
              ],
            }));
          }
          case "confirm_result":
            return patchLast((e0) => ({
              ...e0,
              confirms: (e0.confirms || []).map((c) =>
                c.call_id === e.call_id
                  ? { ...c, status: e.decision === "allow" ? ("allowed" as const) : ("denied" as const) }
                  : c
              ),
            }));
          case "do_action": {
            const th = e.name === "set_theme" ? e.args?.theme : undefined;
            if (th === "light" || th === "dark" || th === "system") {
              onTheme(th);
            } else if (
              e.name === "navigate" &&
              e.args?.tab &&
              ["chat", "profile", "settings"].includes(e.args.tab)
            ) {
              onNavigate(e.args.tab as "chat" | "profile" | "settings");
            }
            return prev;
          }
          case "done":
            return patchLast((e0) => ({ ...e0, streaming: false, processOpen: false }));
          case "cancelled":
            return patchLast((e0) => {
              const hasText = e0.parts.some((p) => p.kind === "text" && p.text.trim());
              const parts = e0.parts.map((p) =>
                p.kind === "tool" && p.status === "running"
                  ? { ...p, status: "done" as const }
                  : p
              );
              return {
                ...e0,
                streaming: false,
                processOpen: false,
                parts: hasText ? parts : [...parts, { kind: "text" as const, text: "_Остановлено._" }],
              };
            });
          case "error":
            return patchLast((e0) => ({ ...e0, streaming: false, processOpen: false, error: e.message }));
          default:
            return prev;
        }
      });
    },
    [currentId]
  );

  async function send() {
    const message = text.trim();
    if (!message || streaming) return;

    const id = currentId ?? newChatId();
    setCurrentId(id);
    setText("");
    setStreaming(true);
    stickBottomRef.current = true;
    setEntries((prev) => [
      ...prev,
      { role: "user", parts: [{ kind: "text", text: message }] },
      // мгновенный отклик: пузырь агента с точками ещё до первого события
      { role: "assistant", parts: [], streaming: true, processOpen: true },
    ]);

    try {
      // модель хранится как «провайдер::модель» — запрос уходит её провайдеру
      const sel = parseModelValue(chatModel);
      await api.chatStartStream(id, message, sel.model, sel.provider, mode, handleEvent);
    } catch (e) {
      handleEvent({ type: "error", message: String(e) });
    } finally {
      setStreaming(false);
      refreshChats();
    }
  }

  function stop() {
    if (currentId) api.chatStop(currentId);
  }

  // «Всегда разрешать» — в рамках чата запоминаем выбранный тип действия
  function decide(c: ConfirmRun, decision: "allow" | "allow_always" | "deny") {
    if (decision === "allow_always") {
      allowedNamesRef.current.add(c.name);
    }
    handleEvent({ type: "confirm_result", call_id: c.call_id, decision: decision === "deny" ? "deny" : "allow" });
    if (currentId) api.chatConfirm(currentId, c.call_id, decision === "deny" ? "deny" : "allow");
  }

  function pickModel(m: string) {
    setChatModel(m);
    localStorage.setItem("chat_model", m);
  }

  // пересчёт высоты поля ввода
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const needed = el.scrollHeight + 2;
    el.style.height = Math.min(needed, 220) + "px";
    el.style.overflowY = needed > 220 ? "auto" : "hidden";
  }, [text]);

  const empty = entries.length === 0;

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <button className="new-chat-btn" onClick={newChat} disabled={streaming}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          Новый чат
        </button>
        <div className="sidebar-title">История</div>
        {chats.map((c) => (
          <div
            key={c.id}
            className={"chat-item" + (c.id === currentId ? " current" : "")}
            onClick={() => openChat(c.id)}
            title={c.title}
          >
            <span className="chat-item-label">{c.title}</span>
            <button
              className="chat-item-del"
              title="Удалить чат"
              onClick={(e) => deleteChat(c.id, e)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        {chats.length === 0 && <p className="sidebar-empty">Пока пусто</p>}
      </aside>

      <div className="chat-main">
        {empty ? (
          <div className="chat-hero">
            <div className="chat-title">
              HH-bot<span className="logo-accent">.</span>
            </div>
          </div>
        ) : (
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="chat-messages">
              {entries.map((m, i) =>
                m.role === "user" ? (
                  <div className="msg-user-row" key={i}>
                    <div className="msg-user">
                      {m.parts.map((p, j) => (p.kind === "text" ? p.text : null))}
                    </div>
                  </div>
                ) : (
                  <AgentMessage
                    key={i}
                    m={m}
                    onToggle={() =>
                      setEntries((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, processOpen: !x.processOpen } : x))
                      )
                    }
                    onDecide={(c, d) => decide(c, d)}
                  />
                )
              )}
            </div>
          </div>
        )}

        <div className="chat-composer-wrap">
          <div className="chat-mode-row">
            <div className="segmented small" title="Права агента в приложении">
              {AGENT_MODES.map((m) => (
                <button
                  key={m.id}
                  className={"seg" + (mode === m.id ? " active" : "")}
                  onClick={() => onMode(m.id)}
                  disabled={streaming}
                  title={m.hint}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {mode === "confirm" && (
              <span className="mode-hint">действия — после подтверждения</span>
            )}
            {mode === "full" && <span className="mode-hint warn">действия выполняются без запроса</span>}
          </div>
          <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="chat-textarea"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Напишите сообщение…"
          />
          {modelEntries.length > 0 && (
            <ModelSelect
              value={chatModel}
              options={modelEntries.map((e) => e.value)}
              onChange={pickModel}
              dropUp
              title="Модель для чата"
              label={(v) => modelEntries.find((x) => x.value === v)?.model || v}
            />
          )}

          {streaming ? (
            <button className="send-btn stop" onClick={stop} title="Остановить">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={send}
              disabled={!text.trim()}
              title="Отправить"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 20V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

// один вызов инструмента с раскрываемыми деталями (JSON запроса и ответа)
function ToolPartView({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(
    (part.args && Object.keys(part.args).length > 0) || part.result
  );
  return (
    <div className="tool-part">
      <span className={"tool-chip" + (part.status === "running" ? " running" : "")}>
        {part.status === "running" ? (
          <span className="tool-spinner" aria-hidden="true" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {part.label}
        {hasDetails && (
          <button
            type="button"
            className="tool-details-btn"
            onClick={() => setOpen((o) => !o)}
            title="Показать JSON запроса и ответа"
          >
            {open ? "скрыть" : "детали"}
          </button>
        )}
      </span>
      {open && hasDetails && (
        <div className="tool-details">
          {part.args && Object.keys(part.args).length > 0 && (
            <>
              <div className="tool-details-label">Запрос</div>
              <pre>{JSON.stringify(part.args, null, 2)}</pre>
            </>
          )}
          {part.result && (
            <>
              <div className="tool-details-label">Ответ</div>
              <pre>{part.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- сообщение агента

function AgentMessage({
  m,
  onToggle,
  onDecide,
}: {
  m: ChatEntry;
  onToggle: () => void;
  onDecide: (c: ConfirmRun, d: "allow" | "allow_always" | "deny") => void;
}) {
  const process = m.parts.filter((p) => p.kind !== "text");
  const answer = m.parts
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n\n");
  const working = m.streaming && !answer.trim();

  return (
    <div className="msg-agent">
      {process.length > 0 && (
        <div className={"process" + (m.processOpen ? " open" : "")}>
          <button type="button" className="process-head" onClick={onToggle}>
            {m.streaming ? (
              <span className="tool-spinner" aria-hidden="true" />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            <span className="process-title">
              {m.streaming ? "Агент работает…" : "Ход работы"}
            </span>
            {!m.processOpen && !m.streaming && process.length > 0 && (
              <span className="process-summary">{processSummary(process)}</span>
            )}
            <svg className="process-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {m.processOpen && (
            <div className="process-body">
              {process.map((p, j) =>
                p.kind === "tool" ? (
                  <ToolPartView key={j} part={p} />
                ) : p.kind === "thinking" ? (
                  <div className="process-think" key={j}>
                    {process.filter((q) => q.kind === "thinking").indexOf(p) > 0 && (
                      <div className="process-label">Снова размышляет</div>
                    )}
                    <div className="process-think-text">{p.text}</div>
                  </div>
                ) : null
              )}
            </div>
          )}
        </div>
      )}

      {answer && <Markdown text={answer} />}

      {working && process.length === 0 && (
        <div className="typing" aria-label="Агент печатает">
          <span /><span /><span />
        </div>
      )}
      {working && process.length > 0 && (
        <div className="typing inline" aria-label="Агент печатает">
          <span /><span /><span />
        </div>
      )}

      {m.confirms && m.confirms.some((c) => c.status === "pending") && (
        <div className="confirm-cards">
          {m.confirms
            .filter((c) => c.status === "pending")
            .map((c) => (
              <div className="confirm-card" key={c.call_id}>
                <div className="confirm-title">Агент просит разрешение</div>
                <div className="confirm-action">{toolLabel(c.name, c.args)}</div>
                {c.args && Object.keys(c.args).length > 0 && (
                  <code className="confirm-args">{JSON.stringify(c.args, null, 1)}</code>
                )}
                <div className="confirm-btns">
                  <button className="ghost-btn small" onClick={() => onDecide(c, "deny")}>
                    Запретить
                  </button>
                  <button
                    className="ghost-btn small"
                    onClick={() => onDecide(c, "allow_always")}
                    title="Разрешать это действие и дальше без вопросов"
                  >
                    Всегда
                  </button>
                  <button className="btn-primary small" onClick={() => onDecide(c, "allow")}>
                    Разрешить
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
      {m.error && <p className="status err">{m.error}</p>}
    </div>
  );
}
