import { useCallback, useEffect, useRef, useState } from "react";
import {
  HhChat,
  HhChatMessage,
  HhChatMessagesResponse,
  HhChatsResponse,
  api,
  hhMessageText,
} from "./api";

// демо-режим: событие «работодатель ответил» приходит из api.ts
const isDemoChatUpdate =
  typeof location !== "undefined" && location.search.includes("demo");

// ---------------------------------------------------------------- утилиты

// «14:32» / «вчера» / «3 окт» — как в мессенджерах
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "вчера";
  if (now.getFullYear() === d.getFullYear())
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" });
}

function fullTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Сегодня";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

// ---------------------------------------------------------------- вкладка «Чаты»

export default function Chats() {
  const [chats, setChats] = useState<HhChat[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [search, setSearch] = useState("");

  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<HhChatMessage[]>([]);
  const [msgsLoading, setMsgsLoading] = useState(false);
  const [msgsError, setMsgsError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  // самая старая загруженная страница переписки; 0 — старых страниц нет
  const oldestPageRef = useRef(0);
  // есть ли ещё более старые сообщения («Показать ещё»)
  const [hasMore, setHasMore] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // черновики по чатам: не терять набранное при переключении
  const draftsRef = useRef<Record<string, string>>({});
  const activeIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // ---------------------------------------------------------- список чатов

  const loadList = useCallback(async () => {
    try {
      const r: HhChatsResponse = await api.hhChatsList(0);
      setChats(r.items || []);
      setListError(null);
    } catch (e) {
      setListError(String(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  // локально гасим бейдж непрочитанных сразу, отметка «прочитано» остаётся
  // и после перезагрузки списка (хранится в Rust-части)
  const markRead = useCallback(async (chatId: string) => {
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, unread_message_count: 0 } : c))
    );
    try {
      await api.hhChatsMarkRead(chatId);
    } catch {
      // не критично: бейдж вернётся, отметку можно повторить
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setChats((prev) => prev.map((c) => ({ ...c, unread_message_count: 0 })));
    try {
      await api.hhChatsMarkAllRead();
    } catch (e) {
      setListError(String(e));
    }
  }, []);

  // ---------------------------------------------------------- открытый чат

  const loadMessages = useCallback(async (chatId: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setMsgsLoading(true);
    try {
      let r = await api.hhChatMessages(chatId, 0);
      // переписка больше одной страницы: сразу берём последнюю (самые свежие)
      const pages = r.pages || 1;
      if (pages > 1) r = await api.hhChatMessages(chatId, pages - 1);
      oldestPageRef.current = r.page ?? pages - 1;
      setHasMore(r.has_more);
      const fresh = r.messages || [];
      setMessages((prev) => {
        if (!opts?.silent || chatId !== activeIdRef.current) return fresh;
        // при тихом обновлении подмешиваем новые сообщения к уже показанным
        const known = new Set(prev.map((m) => m.id));
        return [...prev, ...fresh.filter((m) => !known.has(m.id))].sort((a, b) =>
          a.creation_time.localeCompare(b.creation_time)
        );
      });
      setMsgsError(null);
    } catch (e) {
      setMsgsError(String(e));
    } finally {
      setMsgsLoading(false);
    }
  }, []);

  const openChat = useCallback(
    (id: string) => {
      if (id === activeId) return;
      draftsRef.current[activeId || ""] = draft;
      setActiveId(id);
      setDraft(draftsRef.current[id] || "");
      setMsgsError(null);
      setMessages([]);
      loadMessages(id);
      markRead(id);
    },
    [activeId, draft, loadMessages, markRead]
  );

  // при открытии вкладки: список
  useEffect(() => {
    loadList();
  }, [loadList]);

  // поллинг: список и открытая переписка обновляются, пока вкладка открыта
  useEffect(() => {
    const t = setInterval(() => {
      loadList();
      if (activeIdRef.current) {
        loadMessages(activeIdRef.current, { silent: true });
        // открытая переписка считается прочитанной (в т.ч. новые сообщения)
        markRead(activeIdRef.current);
      }
    }, 15000);
    return () => clearInterval(t);
  }, [loadList, loadMessages, markRead]);

  // в демо-режиме «работодатель отвечает» через событие
  useEffect(() => {
    if (!isDemoChatUpdate) return;
    const h = (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      if (id === activeIdRef.current) loadMessages(activeIdRef.current, { silent: true });
      loadList();
    };
    window.addEventListener("demo-hh-chat-update", h);
    return () => window.removeEventListener("demo-hh-chat-update", h);
  }, [loadList, loadMessages]);

  // ---------------------------------------------------------- отправка

  async function send() {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setSending(true);
    try {
      await api.hhChatSend(activeId, text);
      setDraft("");
      draftsRef.current[activeId] = "";
      await loadMessages(activeId, { silent: true });
      markRead(activeId);
      loadList();
    } catch (e) {
      setMsgsError(String(e));
    } finally {
      setSending(false);
      draftRef.current?.focus();
    }
  }

  // ---------------------------------------------------------- «показать ещё»

  async function loadOlder() {
    const chatId = activeId;
    if (!chatId || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      const prevPage = oldestPageRef.current - 1;
      const r = await api.hhChatMessages(chatId, Math.max(0, prevPage));
      oldestPageRef.current = r.page ?? Math.max(0, prevPage);
      setHasMore(r.has_more);
      const known = new Set(messages.map((m) => m.id));
      const older = (r.messages || []).filter((m) => !known.has(m.id));
      setMessages([...older, ...messages]);
    } catch (e) {
      setMsgsError(String(e));
    } finally {
      setLoadingOlder(false);
    }
  }

  // ---------------------------------------------------------- производные данные

  const q = search.trim().toLowerCase();
  const visibleChats = chats
    .filter((c) => (onlyUnread ? c.unread_message_count > 0 : true))
    .filter((c) => (q ? c.display.title.toLowerCase().includes(q) : true));
  const totalUnread = chats.reduce((s, c) => s + (c.unread_message_count || 0), 0);
  const activeChat = chats.find((c) => c.id === activeId) || null;
  const canWrite = activeChat?.messaging_status !== "archived";
  const writeBlockReason =
    activeChat?.messaging_status === "archived"
      ? "Вакансия в архиве — переписка недоступна."
      : null;

  // при смене выбранного чата — прокрутка вниз и фокус на поле ввода
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (activeId) draftRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, msgsLoading]);

  return (
    <div className="hhch-layout">
      {/* ---------------- список чатов ---------------- */}
      <aside className="hhch-list">
        <div className="hhch-list-head">
          <h2>Чаты с работодателями</h2>
          {totalUnread > 0 && (
            <button
              className="ghost-btn small hhch-unread-all-btn"
              onClick={markAllRead}
              title="Счётчик hh.ru не сбрасывается сам — здесь всё помечается прочитанным"
            >
              Прочитать все ({totalUnread})
            </button>
          )}
        </div>
        <input
          className="hhch-search"
          type="text"
          placeholder="Поиск по чатам"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="hhch-unread-toggle">
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(e) => setOnlyUnread(e.target.checked)}
          />
          Только непрочитанные
        </label>

        {listLoading && <p className="hhch-note">Загружаем чаты…</p>}
        {listError && <p className="hhch-error">Не удалось загрузить чаты: {listError}</p>}
        {!listLoading && !listError && visibleChats.length === 0 && (
          <p className="hhch-note">
            {chats.length === 0
              ? "Пока нет переписок. Откликнитесь на вакансию — здесь появится чат с работодателем."
              : "Ничего не найдено."}
          </p>
        )}

        <div className="hhch-items">
          {visibleChats.map((c) => {
            const preview = c.last_message ? hhMessageText(c.last_message) : "";
            const mine = c.last_message?.sender_display_info?.is_current_participant;
            return (
              <button
                key={c.id}
                className={"hhch-item" + (c.id === activeId ? " active" : "")}
                onClick={() => openChat(c.id)}
              >
                <span className="hhch-item-main">
                  <span className="hhch-item-top">
                    <span className="hhch-item-title">{c.display.title}</span>
                    {c.last_message && (
                      <span className="hhch-item-time">{shortTime(c.last_message.creation_time)}</span>
                    )}
                  </span>
                  <span className="hhch-item-sub">
                    {c.vacancy_name}
                    {c.state_name ? ` · ${c.state_name}` : ""}
                  </span>
                  <span className="hhch-item-bottom">
                    <span className="hhch-item-preview">
                      {mine && preview ? "Вы: " : ""}
                      {preview || "Нет сообщений"}
                    </span>
                    {c.unread_message_count > 0 && (
                      <span className="hhch-badge">{c.unread_message_count}</span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ---------------- переписка ---------------- */}
      <section className="hhch-convo">
        {!activeId && (
          <div className="hhch-placeholder">
            <p>Выберите чат слева, чтобы читать переписку и отвечать работодателю.</p>
          </div>
        )}

        {activeId && (
          <>
            <div className="hhch-convo-head">
              <div className="hhch-convo-titlebox">
                <div className="hhch-convo-title">{activeChat?.display.title || "Чат"}</div>
                {activeChat?.vacancy_name && (
                  <div className="hhch-convo-sub">
                    {activeChat.vacancy_name}
                    {activeChat.state_name ? ` · ${activeChat.state_name}` : ""}
                  </div>
                )}
              </div>
              {activeChat?.vacancy_url && (
                <button
                  className="ghost-btn hhch-vac-link"
                  onClick={() =>
                    api.openUrl(activeChat.vacancy_url!).catch((e) => setMsgsError(String(e)))
                  }
                >
                  Открыть вакансию
                </button>
              )}
            </div>

            {msgsError && <p className="hhch-error hhch-error-pane">Ошибка: {msgsError}</p>}

            <div className="hhch-scroll" ref={scrollRef}>
              {msgsLoading && <p className="hhch-note">Загружаем сообщения…</p>}
              {!msgsLoading && messages.length === 0 && (
                <p className="hhch-note">Сообщений пока нет — напишите первым.</p>
              )}
              {hasMore && messages.length > 0 && (
                <div className="hhch-older">
                  <button className="ghost-btn" onClick={loadOlder} disabled={loadingOlder}>
                    {loadingOlder ? "Загружаем…" : "Показать ещё"}
                  </button>
                </div>
              )}
              {messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const showDay =
                  !prev || dayLabel(prev.creation_time) !== dayLabel(m.creation_time);
                const mine = m.sender_display_info?.is_current_participant;
                return (
                  <div key={m.id} className="hhch-msg-wrap">
                    {showDay && <div className="hhch-day">{dayLabel(m.creation_time)}</div>}
                    <div className={"hhch-msg" + (mine ? " mine" : "")}>
                      {hhMessageText(m) && <div className="hhch-msg-text">{hhMessageText(m)}</div>}
                      <div className="hhch-msg-meta" title={fullTime(m.creation_time)}>
                        {shortTime(m.creation_time)}
                        {mine && m.viewed_by_opponent ? " · прочитано" : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hhch-compose">
              {writeBlockReason ? (
                <p className="hhch-blocked">{writeBlockReason}</p>
              ) : (
                <>
                  <textarea
                    ref={draftRef}
                    className="hhch-input"
                    placeholder="Напишите сообщение…"
                    value={draft}
                    rows={1}
                    disabled={sending}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      if (activeId) draftsRef.current[activeId] = e.target.value;
                      autoGrow(e.target);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <button
                    className="btn-primary hhch-send"
                    onClick={send}
                    disabled={sending || !draft.trim()}
                  >
                    {sending ? "Отправляем…" : "Отправить"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 140) + "px";
}
