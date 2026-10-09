import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, AgentStore, AgentMode, AGENT_MODES, ChatEvent, ChatSummary, ModelEntry, loadAllModels, parseModelValue } from "./api";
import ModelSelect from "./ModelSelect";
import Markdown from "./Markdown";
import {
  BookmarkCheck, BookmarkPlus, BookmarkX, BriefcaseBusiness, BrainCircuit, Check, ChevronDown,
  CalendarClock, CircleUserRound, Copy, FileCheck, FileSearch, FileText, Files,
  FileX, Globe, LayoutPanelTop, ListChecks, MessageSquare,
  MessageSquareText, Navigation, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Search, Send, ShieldCheck, Trash2,
  UserRoundPen, Wrench, Zap,
} from "lucide-react";

// Хронологические сегменты ответа агента: текст, размышления и вызовы
// инструментов идут в том порядке, в каком происходили.
type Part =
  | { kind: "text"; text: string; final?: boolean }
  | { kind: "thinking"; text: string; startedAt?: number; elapsedMs?: number }
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
  startedAt?: number;
  elapsedMs?: number;
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
  if (name === "current_datetime") return "Проверяет дату и время";
  if (name === "list_resumes") return "Смотрит ваши резюме";
  if (name === "read_resume") return "Читает резюме";
  if (name === "search_vacancies") return "Ищет вакансии через приложение";
  if (name === "list_trackings") return "Смотрит отслеживания вакансий";
  if (name === "create_tracking") return "Создаёт отслеживание вакансий";
  if (name === "update_tracking") return "Изменяет отслеживание вакансий";
  if (name === "delete_tracking") return "Удаляет отслеживание вакансий";
  if (name === "read_profile") return "Читает ваш профиль";
  if (name === "prepare_resume_texts") return "Готовит тексты для резюме";
  if (name === "render_page") return "Открывает и читает страницу";
  if (name === "list_chats") return "Смотрит переписки с работодателями";
  if (name === "read_chat") return "Читает переписку с работодателем";
  if (name === "send_chat_message") return "Пишет работодателю";
  if (name === "fetch_url") return "Читает страницу";
  if (name === "set_theme") {
    const t = args?.theme as string | undefined;
    return t === "dark" ? "Включает тёмную тему" : t === "light" ? "Включает светлую тему" : t === "system" ? "Ставит системную тему" : "Меняет тему";
  }
  if (name === "navigate") {
    const tab = args?.tab as string | undefined;
    if (tab === "knowledge") return "Открывает раздел «Знания»";
    if (tab === "profile") return "Открывает раздел «Профиль»";
    if (tab === "vacancies") return "Открывает раздел «Вакансии»";
    if (tab === "hhchats") return "Открывает раздел «Чаты»";
    if (tab === "settings") return "Открывает настройки";
    return "Открывает чат";
  }
  if (name === "update_profile") return "Запоминает сведения о вас";
  if (name === "unpublish_resume") return "Снимает резюме с публикации";
  if (name === "publish_resume") return "Публикует резюме";
  if (name === "edit_resume") return "Открывает редактирование резюме";
  return `Выполняет действие: ${name.replaceAll("_", " ")}`;
}

function thoughtTail(text: string, wordLimit = 12): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  return `${words.length > wordLimit ? "…" : ""}${words.slice(-wordLimit).join(" ")}`;
}

function finishLastThought(parts: Part[]): Part[] {
  const next = [...parts];
  const last = next[next.length - 1];
  if (last?.kind === "thinking" && last.elapsedMs === undefined) {
    next[next.length - 1] = { ...last, elapsedMs: last.startedAt ? Date.now() - last.startedAt : 0 };
  }
  return next;
}

function toolIcon(name: string) {
  if (name === "web_search") return Search;
  if (name === "fetch_url") return Globe;
  if (name === "render_page") return LayoutPanelTop;
  if (name === "send_chat_message") return Send;
  if (name === "list_chats" || name === "read_chat") return MessageSquareText;
  if (name === "search_vacancies") return BriefcaseBusiness;
  if (name === "list_resumes") return Files;
  if (name === "read_resume") return FileSearch;
  if (name === "prepare_resume_texts") return FileText;
  if (name === "edit_resume") return Pencil;
  if (name === "publish_resume") return FileCheck;
  if (name === "unpublish_resume") return FileX;
  if (name === "read_profile") return CircleUserRound;
  if (name === "update_profile") return UserRoundPen;
  if (name === "list_trackings") return ListChecks;
  if (name === "update_tracking") return BookmarkCheck;
  if (name === "delete_tracking") return BookmarkX;
  if (name === "create_tracking") return BookmarkPlus;
  if (name === "navigate") return Navigation;
  if (name === "set_theme") return Palette;
  if (name.startsWith("delete")) return Trash2;
  if (name === "current_datetime") return CalendarClock;
  if (name === "fetch_url") return Globe;
  if (name === "render_page") return LayoutPanelTop;
  if (name === "list_chats" || name === "read_chat") return MessageSquareText;
  if (name === "send_chat_message") return Send;
  return Wrench;
}

// восстановление сегментов из сохранённого чата: берём полный ход работы,
// если он записан, иначе обычный текст
function restoreParts(m: {
  content: string;
  parts?: { kind: string; text?: string; name?: string; args?: Record<string, unknown>; result?: string; label?: string; status?: string; elapsed_ms?: number }[];
}): Part[] {
  if (m.parts && m.parts.length > 0) {
    const parts: Part[] = [];
    for (const p of m.parts) {
      if (p.kind === "text" && p.text) parts.push({ kind: "text", text: p.text });
      else if (p.kind === "thinking" && p.text) parts.push({ kind: "thinking", text: p.text, elapsedMs: p.elapsed_ms });
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
    if (parts.length > 0) {
      const lastText = parts.map((p) => p.kind).lastIndexOf("text");
      if (lastText >= 0 && parts[lastText].kind === "text") parts[lastText] = { ...parts[lastText], final: true };
      return parts;
    }
  }
  return m.content ? [{ kind: "text", text: m.content }] : [];
}

function newChatId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function getModeIcon(m: AgentMode) {
  if (m === "chat") return MessageSquare;
  if (m === "confirm") return ShieldCheck;
  return Zap;
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
  onNavigate: (tab: "chat" | "vacancies" | "hhchats" | "knowledge" | "profile" | "settings") => void;
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
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("chat_sidebar_open") !== "false"
  );
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [isMultiline, setIsMultiline] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  function toggleSidebar(open: boolean) {
    setSidebarOpen(open);
    localStorage.setItem("chat_sidebar_open", String(open));
  }

  useEffect(() => {
    if (!modeMenuOpen) return;
    function onDoc(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modeMenuOpen]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const allowedNamesRef = useRef<Set<string>>(new Set());
  const activeChatIdRef = useRef<string | null>(currentId);
  activeChatIdRef.current = currentId;
  const entriesByChatRef = useRef<Map<string, ChatEntry[]>>(new Map());
  const runningChatsRef = useRef<Set<string>>(new Set());
  const [runningChatIds, setRunningChatIds] = useState<Set<string>>(new Set());

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
    if (id === currentId) return;
    setCurrentId(id);
    setStreaming(runningChatsRef.current.has(id));
    const cached = entriesByChatRef.current.get(id);
    if (cached) setEntries(cached);
    api
      .chatGet(id)
      .then((msgs) => {
        if (activeChatIdRef.current !== id) return;
        const restored = msgs.map((m) => ({ role: m.role, parts: restoreParts(m), error: m.error }));
        const live = entriesByChatRef.current.get(id);
        const merged = live?.some((entry) => entry.streaming) ? live : restored;
        entriesByChatRef.current.set(id, merged);
        setEntries(merged);
      })
      .catch(() => {});
  }

  function newChat() {
    if (currentId === null && entries.length === 0) return;
    setCurrentId(null);
    setStreaming(false);
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
    (targetId: string, e: ChatEvent) => {
      // A stream belongs to the chat that started it. Background events must
      // never leak into whichever conversation the user has opened meanwhile.
      setEntries((visible) => {
        const prev = entriesByChatRef.current.get(targetId) || (activeChatIdRef.current === targetId ? visible : []);
        const last = prev[prev.length - 1];
        const ensureAssistant = (): ChatEntry[] => {
          if (last && last.role === "assistant" && last.streaming) return prev;
          return [...prev, { role: "assistant", parts: [], streaming: true, processOpen: true, startedAt: Date.now() }];
        };
        const patchLast = (patch: (e0: ChatEntry) => ChatEntry): ChatEntry[] => {
          const next = ensureAssistant();
          const lastA = next[next.length - 1];
          return [...next.slice(0, -1), patch(lastA)];
        };

        let result: ChatEntry[];
        switch (e.type) {
          case "delta":
            result = patchLast((e0) => {
              const parts = finishLastThought(e0.parts);
              const lastP = parts[parts.length - 1];
              if (lastP && lastP.kind === "text") {
                parts[parts.length - 1] = { ...lastP, text: lastP.text + e.content };
              } else {
                parts.push({ kind: "text", text: e.content });
              }
              return { ...e0, parts };
            }); break;
          case "reasoning":
            result = patchLast((e0) => {
              const parts = [...e0.parts];
              const lastP = parts[parts.length - 1];
              if (lastP && lastP.kind === "thinking" && lastP.elapsedMs === undefined) {
                parts[parts.length - 1] = { ...lastP, text: lastP.text + e.content };
              } else {
                parts.push({ kind: "thinking", text: e.content, startedAt: Date.now() });
              }
              return { ...e0, parts };
            }); break;
          case "tool_start":
            result = patchLast((e0) => ({
              ...e0,
              parts: [
                ...finishLastThought(e0.parts),
                {
                  kind: "tool",
                  name: e.name,
                  label: toolLabel(e.name, e.args),
                  status: "running",
                  args: e.args,
                },
              ],
            })); break;
          case "tool_end":
            result = patchLast((e0) => ({
              ...e0,
              parts: e0.parts.map((p) =>
                p.kind === "tool" && p.name === e.name && p.status === "running"
                  ? { ...p, status: "done" as const, result: e.result }
                  : p
              ),
            })); break;
          case "confirm_request": {
            // «всегда разрешать» — отвечаем молча, без карточки
            if (allowedNamesRef.current.has(e.name)) {
              api.chatConfirm(targetId, e.call_id, "allow");
              return visible;
            }
            result = patchLast((e0) => ({
              ...e0,
              confirms: [
                ...(e0.confirms || []),
                { call_id: e.call_id, name: e.name, args: e.args, status: "pending" },
              ],
            })); break;
          }
          case "confirm_result":
            result = patchLast((e0) => ({
              ...e0,
              confirms: (e0.confirms || []).map((c) =>
                c.call_id === e.call_id
                  ? { ...c, status: e.decision === "allow" ? ("allowed" as const) : ("denied" as const) }
                  : c
              ),
            })); break;
          case "do_action": {
            const th = e.name === "set_theme" ? e.args?.theme : undefined;
            if (th === "light" || th === "dark" || th === "system") {
              onTheme(th);
            } else if (
              e.name === "navigate" &&
              e.args?.tab &&
              ["chat", "vacancies", "hhchats", "knowledge", "profile", "settings"].includes(e.args.tab)
            ) {
              onNavigate(e.args.tab as "chat" | "vacancies" | "hhchats" | "knowledge" | "profile" | "settings");
            }
            result = prev; break;
          }
          case "done":
            result = patchLast((e0) => {
              const closed = finishLastThought(e0.parts);
              const lastText = closed.map((p) => p.kind).lastIndexOf("text");
              const parts = closed.map((p, index) => p.kind === "text" ? { ...p, final: index === lastText } : p);
              return { ...e0, parts, streaming: false, processOpen: false, elapsedMs: e0.startedAt ? Date.now() - e0.startedAt : undefined };
            }); break;
          case "cancelled":
            result = patchLast((e0) => {
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
                elapsedMs: e0.startedAt ? Date.now() - e0.startedAt : undefined,
                parts: hasText ? finishLastThought(parts) : [...finishLastThought(parts), { kind: "text" as const, text: "_Остановлено._" }],
              };
            }); break;
          case "error":
            result = patchLast((e0) => ({ ...e0, parts: finishLastThought(e0.parts), streaming: false, processOpen: false, error: e.message })); break;
          default:
            result = prev;
        }
        entriesByChatRef.current.set(targetId, result);
        if (e.type === "done" || e.type === "error" || e.type === "cancelled") {
          runningChatsRef.current.delete(targetId);
        }
        return activeChatIdRef.current === targetId ? result : visible;
      });
      if (e.type === "done" || e.type === "error" || e.type === "cancelled") {
        setRunningChatIds(new Set(runningChatsRef.current));
      }
    },
    []
  );

  async function send() {
    const message = text.trim();
    const targetId = currentId ?? newChatId();
    if (!message || runningChatsRef.current.has(targetId)) return;

    const id = targetId;
    setCurrentId(id);
    runningChatsRef.current.add(id);
    setRunningChatIds(new Set(runningChatsRef.current));
    setText("");
    setStreaming(true);
    stickBottomRef.current = true;
    setEntries((prev) => {
      const next = [
      ...prev,
      { role: "user", parts: [{ kind: "text", text: message }] },
      // мгновенный отклик: пузырь агента с точками ещё до первого события
      { role: "assistant", parts: [], streaming: true, processOpen: true, startedAt: Date.now() },
      ] as ChatEntry[];
      entriesByChatRef.current.set(id, next);
      return next;
    });
    setChats((prev) => {
      const existing = prev.find((chat) => chat.id === id);
      const chat = existing
        ? { ...existing, updated_at: Date.now() / 1000 }
        : { id, title: message.slice(0, 48), updated_at: Date.now() / 1000 };
      return [chat, ...prev.filter((item) => item.id !== id)];
    });

    try {
      // модель хранится как «провайдер::модель» — запрос уходит её провайдеру
      const sel = parseModelValue(chatModel);
      await api.chatStartStream(id, message, sel.model, sel.provider, mode, (event) => handleEvent(id, event));
    } catch (e) {
      handleEvent(id, { type: "error", message: String(e) });
    } finally {
      runningChatsRef.current.delete(id);
      setRunningChatIds(new Set(runningChatsRef.current));
      setStreaming(runningChatsRef.current.has(activeChatIdRef.current || ""));
      refreshChats();
    }
  }

  function stop() {
    if (currentId && runningChatsRef.current.has(currentId)) api.chatStop(currentId);
  }

  // «Всегда разрешать» — в рамках чата запоминаем выбранный тип действия
  function decide(c: ConfirmRun, decision: "allow" | "allow_always" | "deny") {
    if (decision === "allow_always") {
      allowedNamesRef.current.add(c.name);
    }
    if (currentId) handleEvent(currentId, { type: "confirm_result", call_id: c.call_id, decision: decision === "deny" ? "deny" : "allow" });
    if (currentId) api.chatConfirm(currentId, c.call_id, decision === "deny" ? "deny" : "allow");
  }

  function pickModel(m: string) {
    setChatModel(m);
    localStorage.setItem("chat_model", m);
  }

  // пересчёт высоты поля ввода и отслеживание многострочности
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (text.includes("\n")) {
      setIsMultiline(true);
    } else {
      el.style.height = "auto";
      setIsMultiline(el.scrollHeight > 38);
    }
  }, [text]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const needed = el.scrollHeight;
    const maxHeight = 220;
    el.style.height = Math.min(needed, maxHeight) + "px";
    el.style.overflowY = needed > maxHeight ? "auto" : "hidden";
  }, [text, isMultiline]);

  const empty = entries.length === 0;
  const currentChat = chats.find((c) => c.id === currentId);
  const currentModeInfo = AGENT_MODES.find((m) => m.id === mode) || AGENT_MODES[0];
  const CurrentModeIcon = getModeIcon(mode);

  const modeSelector = (
    <div className="composer-mode-wrap" ref={modeMenuRef}>
      <button
        type="button"
        className={"composer-mode-btn" + (modeMenuOpen ? " open" : "")}
        onClick={() => setModeMenuOpen((o) => !o)}
        title={currentModeInfo.hint}
        aria-expanded={modeMenuOpen}
      >
        <CurrentModeIcon size={15} />
        <span>{currentModeInfo.label}</span>
        <ChevronDown size={13} className={"composer-mode-chevron" + (modeMenuOpen ? " open" : "")} />
      </button>
      {modeMenuOpen && (
        <div className="composer-mode-menu">
          <div className="composer-mode-menu-header">Режим агента</div>
          {AGENT_MODES.map((m) => {
            const Icon = getModeIcon(m.id);
            const isSel = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                className={"composer-mode-item" + (isSel ? " active" : "")}
                onClick={() => {
                  onMode(m.id);
                  setModeMenuOpen(false);
                }}
              >
                <div className="composer-mode-item-icon">
                  <Icon size={16} />
                </div>
                <div className="composer-mode-item-info">
                  <div className="composer-mode-item-title">{m.label}</div>
                  <div className="composer-mode-item-desc">{m.hint}</div>
                </div>
                {isSel && <Check size={16} className="composer-mode-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const composerRight = (
    <div className="chat-composer-right">
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
        <button className="send-btn stop" onClick={stop} title="Остановить генерацию">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          className="send-btn"
          onClick={send}
          disabled={!text.trim()}
          title="Отправить (Enter)"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 20V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );

  return (
    <div className="chat-layout">
      <aside className={"chat-sidebar" + (!sidebarOpen ? " collapsed" : "")}>
        <div className="sidebar-inner">
          <div className="sidebar-header">
            <span className="sidebar-header-title">Задачи</span>
            <button
              className="sidebar-collapse-btn"
              onClick={() => toggleSidebar(false)}
              title="Свернуть панель"
              aria-label="Свернуть панель"
            >
              <PanelLeftClose size={17} />
            </button>
          </div>
          <button className="new-task-btn" onClick={newChat}>
            <Plus size={16} />
            <span>Новая задача</span>
          </button>
          <div className="sidebar-title">История задач</div>
          {chats.map((c) => (
            <div
              key={c.id}
              className={"chat-item" + (c.id === currentId ? " current" : "")}
              onClick={() => openChat(c.id)}
              title={c.title}
            >
              {runningChatIds.has(c.id) && <span className="chat-item-live" role="img" aria-label="Агент работает" />}
              <span className="chat-item-label">{c.title}</span>
              <button
                className="chat-item-del"
                title="Удалить задачу"
                onClick={(e) => deleteChat(c.id, e)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          {chats.length === 0 && <p className="sidebar-empty">Пока пусто</p>}
        </div>
      </aside>

      <div className="chat-main">
        <div className="chat-topbar">
          <div className="chat-topbar-left">
            {!sidebarOpen && (
              <button
                className="sidebar-toggle-btn"
                onClick={() => toggleSidebar(true)}
                title="Развернуть панель задач"
                aria-label="Развернуть панель задач"
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            {!sidebarOpen && (
              <button
                className="topbar-new-task-btn"
                onClick={newChat}
                title="Новая задача"
              >
                <Plus size={14} />
                <span>Новая задача</span>
              </button>
            )}
            <span className="chat-topbar-title">
              {currentChat ? currentChat.title : (entries.length > 0 ? "Текущая задача" : "Новая задача")}
            </span>
          </div>
        </div>

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
          <div className={"chat-composer" + (isMultiline ? " multiline" : "")}>
            {!isMultiline ? (
              <>
                {modeSelector}
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
                  placeholder="Напишите сообщение… (Enter — отправить, Shift+Enter — перенос)"
                />
                {composerRight}
              </>
            ) : (
              <>
                <textarea
                  ref={inputRef}
                  className="chat-textarea"
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Напишите сообщение… (Enter — отправить, Shift+Enter — перенос)"
                />
                <div className="chat-composer-footer">
                  {modeSelector}
                  {composerRight}
                </div>
              </>
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
  const restoreScrollTop = useRef<number | null>(null);
  const hasDetails = Boolean(
    (part.args && Object.keys(part.args).length > 0) || part.result
  );
  useLayoutEffect(() => {
    if (restoreScrollTop.current === null) return;
    const top = restoreScrollTop.current;
    restoreScrollTop.current = null;
    const scroller = document.querySelector<HTMLElement>(".chat-scroll");
    if (scroller) scroller.scrollTop = top;
  }, [open]);
  return (
    <div className={"tool-call" + (part.status === "running" ? " running" : "")}>
      <button type="button" className="tool-call-row" onClick={(event) => {
        if (!hasDetails) return;
        const scroller = event.currentTarget.closest<HTMLElement>(".chat-scroll");
        restoreScrollTop.current = scroller?.scrollTop ?? null;
        setOpen((o) => !o);
      }} aria-expanded={open}>
        {(() => { const Icon = toolIcon(part.name); return <Icon className="tool-call-icon" size={16} strokeWidth={1.8} aria-hidden="true" />; })()}
        <span className="tool-call-title">{part.label}</span>
        {part.status === "running" && <span className="tool-spinner" aria-label="Выполняется" />}
        {hasDetails && <ChevronDown className={"tool-call-chevron" + (open ? " open" : "")} size={15} aria-hidden="true" />}
      </button>
      {hasDetails && (
        <div className={"tool-details-clip" + (open ? " expanded" : "")}>
        <div className="tool-details-plain">
          {part.args && Object.keys(part.args).length > 0 && (
            <>
              <div className="tool-details-label">Аргументы</div>
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
        </div>
      )}
    </div>
  );
}

function ThinkingPartView({ part, streaming }: {
  part: Extract<Part, { kind: "thinking" }>;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const restoreScrollTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (restoreScrollTop.current === null) return;
    const top = restoreScrollTop.current;
    restoreScrollTop.current = null;
    const scroller = document.querySelector<HTMLElement>(".chat-scroll");
    if (scroller) scroller.scrollTop = top;
  }, [open]);
  return (
    <div className="thinking-step">
      <button type="button" className="thinking-row" onClick={(event) => {
        const scroller = event.currentTarget.closest<HTMLElement>(".chat-scroll");
        restoreScrollTop.current = scroller?.scrollTop ?? null;
        setOpen((value) => !value);
      }} aria-expanded={open}>
        <BrainCircuit size={16} strokeWidth={1.8} aria-hidden="true" />
        <span className="thinking-label">{streaming ? "Размышляет" : "Размышлял"}</span>
        {streaming && part.elapsedMs === undefined
          ? <span className="thinking-preview">{thoughtTail(part.text)}</span>
          : <span className="thinking-duration">{part.elapsedMs !== undefined ? `${Math.max(1, Math.round(part.elapsedMs / 1000))} сек.` : ""}</span>}
        <ChevronDown className={"thinking-chevron" + (open ? " open" : "")} size={15} aria-hidden="true" />
      </button>
      <div className={"thinking-details-clip" + (open ? " expanded" : "")}><div className="thinking-details">{part.text}</div></div>
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
  const [copied, setCopied] = useState(false);
  const process = m.parts.filter((p) => p.kind !== "text");
  const working = m.streaming;
  const finalTexts = m.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text" && Boolean(p.final));
  const allFinalText = finalTexts.map((p) => p.text).join("\n\n");

  function copyAnswer() {
    if (!allFinalText) return;
    navigator.clipboard.writeText(allFinalText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="msg-agent">
      <div className="msg-agent-header">
        <div className="msg-agent-badge">
          <BrainCircuit size={15} />
          <span>HH-bot</span>
        </div>
        {allFinalText && !working && (
          <div className="msg-agent-actions">
            <button
              type="button"
              className="msg-copy-btn"
              onClick={copyAnswer}
              title="Скопировать ответ"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Скопировано" : "Копировать"}</span>
            </button>
          </div>
        )}
      </div>

      {process.length > 0 && (
        <div className={"work-process" + (m.processOpen ? " open" : "")}>
          <button type="button" className="work-process-head" onClick={(event) => {
            const scroller = event.currentTarget.closest<HTMLElement>(".chat-scroll");
            const top = scroller?.scrollTop;
            onToggle();
            if (scroller && top !== undefined) requestAnimationFrame(() => { scroller.scrollTop = top; });
          }} aria-expanded={Boolean(m.processOpen)}>
            Ход работы
            {!m.streaming && m.elapsedMs !== undefined && <span className="work-process-summary">{Math.max(1, Math.round(m.elapsedMs / 1000))} сек.</span>}
            <ChevronDown className="work-process-chevron" size={16} aria-hidden="true" />
          </button>
          <div className="work-process-body" aria-hidden={!m.processOpen}>
            <div className="work-process-inner">
            {m.parts.filter((p) => p.kind !== "text" || !p.final).map((p, j) => p.kind === "text" ? (
              <div className="agent-intermediate" key={j}><Markdown text={p.text} /></div>
            ) : p.kind === "tool" ? (
              <ToolPartView key={j} part={p} />
            ) : (
              <ThinkingPartView key={j} part={p} streaming={Boolean(m.streaming && p.elapsedMs === undefined)} />
            ))}
            </div>
          </div>
        </div>
      )}

      {m.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text" && Boolean(p.final)).map((p, j) => (
        <div className="agent-final" key={`final-${j}`}><Markdown text={p.text} /></div>
      ))}

      {working && m.parts.length === 0 && (
        <div className="thinking" aria-label="Агент печатает">
          <span className="thinking-text">Думаю…</span>
        </div>
      )}
      {working && process.length > 0 && !m.parts.some((p) => p.kind === "text") && (
        <div className="thinking inline" aria-label="Агент печатает">
          <span className="thinking-text">Думаю…</span>
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
