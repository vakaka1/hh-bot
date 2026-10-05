// Демо-режим для предпросмотра интерфейса без Tauri (?demo в адресе)
const demo = typeof location !== "undefined" && location.search.includes("demo");

const mock: Record<string, unknown> = {
  auth_status: { logged_in: true },
  get_me: {
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
      { title: "Senior frontend-разработчик", status: { id: "published", name: "Опубликовано" }, updated_at: "2026-10-01T12:00:00", views: 412, new_messages: 3 },
      { title: "React / TypeScript разработчик", status: { id: "draft", name: "Черновик" }, updated_at: "2026-09-18T09:30:00", views: 0, new_messages: 0 },
    ],
  },
  agent_test: { models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "o3-mini"] },
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
  title?: string;
  status?: { id?: string; name?: string };
  updated_at?: string;
  views?: number;
  new_messages?: number;
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
  agentsLoad: () => invoke<AgentStore>("agents_load"),
  agentsSave: (store: AgentStore) => invoke<void>("agents_save", { store }),
  agentTest: (config: AgentConfig) =>
    invoke<{ models: string[] }>("agent_test", { config }),
};
