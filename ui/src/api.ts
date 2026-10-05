// Демо-режим для предпросмотра интерфейса без Tauri (?demo в адресе)
const demo = typeof location !== "undefined" && location.search.includes("demo");

// Channel импортируем из пакета — в глобальном бандле Tauri v2 он
// недоступен через window.__TAURI__.ipc, из-за чего стриминг «не видел» Tauri
import { Channel } from "@tauri-apps/api/core";

const mock: Record<string, unknown> = {
  auth_status: { logged_in: true },  get_me: {
    last_name: "Иванов",
    first_name: "Иван",
    middle_name: "Иванович",
    email: "ivan@mail.ru",
    is_email_verified: true,
    phone: "+7 900 123-45-67",
    created_at: "2019-04-11T10:00:00",
  },
  get_resumes: {
    items: [
      { id: "resume-1", title: "Senior frontend-разработчик", status: { id: "published", name: "Опубликовано" }, updated_at: "2026-10-01T12:00:00", views: 412, new_messages: 3 },
      { id: "resume-2", title: "React / TypeScript разработчик", status: { id: "draft", name: "Черновик" }, updated_at: "2026-09-18T09:30:00", views: 0, new_messages: 0 },
    ],
  },
  about_load: {
    search_status: "active_search",
    desired_title: "Senior frontend-разработчик",
    area: "Москва",
    salary: "350000",
    employment: ["full"],
    schedule: ["remote", "flexible"],
    skills: "React, TypeScript, Node.js",
    experience: "8 лет коммерческой разработки, последний проект — B2B-платформа.",
    about: "Веду проекты от архитектуры до релиза, люблю чистый код и понятные интерфейсы.",
  },
  agent_test: { models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "o3-mini"] },
  set_job_search_status: null,
  about_save: null,
  web_action: null,
  chats_list: [],
  chat_get: [],
  agents_load: {
    agent_model: null,
    providers: [
      { name: "OpenAI", base_url: "https://api.openai.com/v1", api_key: "sk-...", model: "gpt-4o-mini" },
      { name: "Локальный", base_url: "http://localhost:1234/v1", api_key: "-", model: "qwen2.5-7b" },
    ],
    active: 0,
  },
};

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (demo && cmd in mock) return Promise.resolve(mock[cmd] as T);
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: Function } } }).__TAURI__;
  if (!tauri) {
    return Promise.reject("Приложение запущено вне Tauri — команды недоступны");
  }
  return tauri.core.invoke(cmd, args) as Promise<T>;
}

// ---------------------------------------------------------------- типы

export interface Me {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  email?: string;
  is_email_verified?: boolean;
  phone?: string;
  created_at?: string;
}

export interface Resume {
  id?: string;
  title?: string;
  status?: { id?: string; name?: string };
  updated_at?: string;
  views?: number;
  new_messages?: number;
}

// Данные блока «Обо мне» — описывает сам пользователь, хранятся локально
export interface AboutData {
  search_status?: string; // статус поиска работы
  desired_title?: string;
  area?: string;
  salary?: string;
  employment?: string[];
  schedule?: string[];
  skills?: string;
  experience?: string;
  about?: string;
}

export interface AgentConfig {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
}

export interface AgentStore {
  providers: AgentConfig[];
  active: number | null;
  agent_model?: string | null;
  // свой SearXNG-инстанс для веб-поиска (необязательно)
  search_url?: string | null;
}

export interface AuthStatus {
  logged_in: boolean;
  expires_at?: number;
}

// ---------------------------------------------------------------- команды

export const api = {
  authStatus: () => invoke<AuthStatus>("auth_status"),
  quickAuth: () => invoke<void>("quick_auth"),
  logout: () => invoke<void>("logout"),
  getMe: () => invoke<Me>("get_me"),
  getResumes: () => invoke<{ items?: Resume[] }>("get_resumes"),
  unpublishResume: (resumeId: string) =>
    invoke<void>("web_action", { kind: "unpublish", arg: resumeId }),
  setJobSearchStatus: (status: string) =>
    invoke<void>("web_action", { kind: "job_search_status", arg: status }),
  aboutLoad: () => invoke<AboutData>("about_load"),
  aboutSave: (data: AboutData) => invoke<void>("about_save", { data }),  agentsLoad: () => invoke<AgentStore>("agents_load"),
  agentsSave: (store: AgentStore) => invoke<void>("agents_save", { store }),
  agentTest: (config: AgentConfig) =>
    invoke<{ models: string[] }>("agent_test", { config }),
  chatsList: () => invoke<ChatSummary[]>("chats_list"),
  chatGet: (chatId: string) => invoke<StoredChatMsg[]>("chat_get", { chatId }),
  chatDelete: (chatId: string) => invoke<void>("chat_delete", { chatId }),
  chatRename: (chatId: string, title: string) =>
    invoke<void>("chat_rename", { chatId, title }),
  chatStop: (chatId: string) => {
    if (demo) {
      demoAborted = true;
      return Promise.resolve();
    }
    return invoke<void>("chat_stop", { chatId });
  },
  searchTest: (query: string, url?: string) =>
    invoke<{ backend: string; results: { title: string; url: string; snippet: string }[] }>(
      "search_test",
      { query, url: url || null }
    ),
  chatConfirm: (chatId: string, callId: string, decision: "allow" | "deny") =>
    invoke<void>("chat_confirm", { chatId, callId, decision }),
  chatStartStream: (chatId: string, message: string, model: string, mode: AgentMode, onEvent: (e: ChatEvent) => void) =>
    chatStartStream(chatId, message, model, mode, onEvent),
};

// ---------------------------------------------------------------- чат

export interface ChatSummary {
  id: string;
  title: string;
  updated_at: number;
}

export interface StoredChatMsg {
  role: "user" | "assistant";
  content: string;
  // полный ход ответа (размышления/инструменты/текст), сохранённый бэкендом
  parts?: { kind: "text" | "thinking" | "tool"; text?: string; name?: string; args?: Record<string, unknown>; result?: string; label?: string; status?: string }[];
}

export type ChatEvent =
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; name: string; args?: { query?: string; url?: string; theme?: string; tab?: string } }
  | { type: "tool_end"; name: string; result?: string }
  | { type: "confirm_request"; call_id: string; name: string; args?: Record<string, unknown> }
  | { type: "confirm_result"; call_id: string; decision: string }
  | { type: "do_action"; name: string; args?: { theme?: string; tab?: string } }
  | { type: "done" }
  | { type: "cancelled" }
  | { type: "error"; message: string };

// Режим доступа агента к приложению
export type AgentMode = "chat" | "confirm" | "full";

export const AGENT_MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: "chat", label: "Чат", hint: "Агент только отвечает — приложением не управляет" },
  { id: "confirm", label: "Подтверждение", hint: "Действия в приложении — только после вашего подтверждения" },
  { id: "full", label: "Полное доверие", hint: "Агент выполняет действия сразу, без запроса" },
];

// Отправка сообщения со стримингом ответа. Promise резолвится, когда
// генерация полностью завершена (включая циклы инструментов).
export function chatStartStream(
  chatId: string,
  message: string,
  model: string,
  mode: AgentMode,
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  if (demo) return demoChatStart(message, onEvent);

  const channel = new Channel((msg: unknown) => onEvent(msg as ChatEvent));
  return invoke<void>("chat_start", {
    chatId,
    message,
    model,
    mode,
    onEvent: channel,
  });
}

// Демо: имитация стримингового ответа с инструментами и markdown
let demoAborted = false;

function demoChatStart(
  message: string,
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  const sleep = (ms: number) =>
    new Promise<boolean>((r) =>
      setTimeout(() => r(demoAborted), ms)
    );
  demoAborted = false;
  return (async () => {
    if (await sleep(400)) {
      onEvent({ type: "cancelled" });
      return;
    }
    const thought = "Пользователь просит актуальные данные. Нужно поискать в сети свежие предложения и зарплаты, затем собрать краткую сводку с таблицей и ссылкой на hh.ru.";
    for (const word of thought.split(/(?<=\s)/)) {
      if (await sleep(30)) return onEvent({ type: "cancelled" });
      onEvent({ type: "reasoning", content: word });
    }
    if (await sleep(300)) return onEvent({ type: "cancelled" });
    onEvent({ type: "tool_start", name: "web_search", args: { query: message.slice(0, 40) } });
    if (await sleep(900)) return onEvent({ type: "cancelled" });
    onEvent({
      type: "tool_end",
      name: "web_search",
      result: JSON.stringify(
        [
          { title: "Работа frontend developer — hh.ru", url: "https://hh.ru/vacancies/frontend", snippet: "Найдено 2 340 вакансий, обновлено сегодня." },
          { title: "Вакансии frontend-разработчика — Хабр Карьера", url: "https://career.habr.com/vacancies/frontend", snippet: "10 открытых вакансий с зарплатами от 250 000 ₽." },
        ],
        null,
        2
      ),
    });
    if (await sleep(200)) return onEvent({ type: "cancelled" });
    const thought2 = "Нашёл свежие данные. Теперь соберу их в краткую сводку: таблица с ключевыми цифрами, список деталей и совет для отклика.";
    for (const word of thought2.split(/(?<=\s)/)) {
      if (await sleep(24)) return onEvent({ type: "cancelled" });
      onEvent({ type: "reasoning", content: word });
    }
    if (await sleep(150)) return onEvent({ type: "cancelled" });
    const answer = `Вот что удалось выяснить по запросу «${message}».

## Кратко

Ситуация на рынке **динамичная** — посмотрим на основные моменты:

| Параметр | Значение | Комментарий |
| --- | --- | --- |
| Вакансий за месяц | ~1 240 | рост на 8% |
| Медианная зарплата | 320 000 ₽ | по Москве |
| Удалёнка | 34% предложений | чаще гибрид |

## Детали

1. Больше всего предложений у крупных компаний.
2. Часто требуют опыт с TypeScript и SQL.
3. Важный момент: *откликаться лучше в первые 3 дня*.

Пример сниппета для отклика:

\`\`\`ts
const coverLetter = \`Здравствуйте! Мой опыт — \${years} лет. Готов обсудить детали.\`;
\`\`\`

> Совет: добавьте в резюме измеримые результаты — это повышает отклик.

Подробнее: [hh.ru — поиск вакансий](https://hh.ru/search/vacancy).`;
    for (const word of answer.split(/(?<=\s)/)) {
      if (await sleep(18)) return onEvent({ type: "cancelled" });
      onEvent({ type: "delta", content: word });
    }
    onEvent({ type: "done" });
  })();
}
