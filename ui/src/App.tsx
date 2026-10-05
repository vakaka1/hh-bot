import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, AgentConfig, AgentStore, Me, Resume } from "./api";

type Screen = "loading" | "login" | "app";
type Tab = "chat" | "profile" | "settings";

function useTheme() {
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem("theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return { theme, setTheme };
}

// ---------------------------------------------------------------- выбор модели

function ModelSelect({
  value,
  options,
  onChange,
  dropUp = false,
  wide = false,
  title,
}: {
  value: string;
  options: string[];
  onChange: (m: string) => void;
  dropUp?: boolean;
  wide?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const all = options.includes(value) || !value ? options : [value, ...options];

  return (
    <div className={"ms-root" + (wide ? " wide" : "")} ref={rootRef}>
      <button
        type="button"
        className={"ms-btn" + (open ? " open" : "")}
        onClick={() => setOpen((o) => !o)}
        title={title}
      >
        <span className="ms-label">{value || "Выберите модель"}</span>
        <svg className="ms-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className={"ms-menu" + (dropUp ? " up" : "")}>
          {all.map((m) => (
            <button
              type="button"
              key={m}
              className={"ms-item" + (m === value ? " selected" : "")}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              <span className="ms-item-label">{m}</span>
              {m === value && (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- вход

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  async function login() {
    setBusy(true);
    setStatus({ text: "Открываем окно входа hh.ru — введите там логин и пароль…", ok: true });
    try {
      await api.quickAuth();
      onDone();
    } catch (e) {
      setStatus({ text: String(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="login-screen">
      <div className="login-card">
        <div className="login-wordmark">
          HH-bot<span className="logo-accent">.</span>
        </div>
        <p className="login-sub">Рабочее место соискателя hh.ru</p>
        <p className="login-desc">
          Вход через hh.ru, просмотр профиля и резюме, подключение ИИ-провайдеров.
          Откроется страница hh.ru, где вы введёте свои данные обычным способом.
        </p>
        <button className="btn-primary big" onClick={login} disabled={busy}>
          {busy ? "Ждём вход на hh.ru…" : "Войти через hh.ru"}
        </button>
        {status && <p className={"status " + (status.ok ? "ok" : "err")}>{status.text}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- чат

function Chat({ store }: { store: AgentStore }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active =
    store.active !== null && store.active < store.providers.length
      ? store.providers[store.active]
      : null;

  const [models, setModels] = useState<string[]>([]);
  const [chatModel, setChatModel] = useState(
    () => localStorage.getItem("chat_model") || ""
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .agentTest(active)
      .then((res) => {
        if (cancelled) return;
        setModels(res.models || []);
        setChatModel((cur) => {
          if (cur) return cur;
          const def = store.agent_model || active.model || (res.models || [])[0] || "";
          if (def) localStorage.setItem("chat_model", def);
          return def;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active?.base_url, active?.api_key]);

  // пересчёт высоты ПОСЛЕ отрисовки нового текста — иначе поле отстаёт
  // на строку и обрезает текст
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // +2px на верхнюю и нижнюю рамку (box-sizing: border-box)
    const needed = el.scrollHeight + 2;
    el.style.height = Math.min(needed, 260) + "px";
    el.style.overflowY = needed > 260 ? "auto" : "hidden";
  }, [text]);

  function send() {
    // заглушка: отправка появится вместе с агентом
  }

  function pickModel(m: string) {
    setChatModel(m);
    localStorage.setItem("chat_model", m);
  }

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <div className="sidebar-title">История</div>
      </aside>

      <div className="chat-main">
        <div className="chat-hero">
          <div className="chat-title">
            HH-bot<span className="logo-accent">.</span>
          </div>
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
          {models.length > 0 && (
            <ModelSelect
              value={chatModel}
              options={models}
              onChange={pickModel}
              dropUp
              title="Модель для чата"
            />
          )}

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
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- профиль

function Profile() {
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState("");
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [resErr, setResErr] = useState("");

  async function loadMe() {
    setMeErr("");
    setMe(null);
    try {
      setMe(await api.getMe());
    } catch (e) {
      setMeErr(String(e));
    }
  }

  async function loadResumes() {
    setResErr("");
    setResumes(null);
    try {
      const data = await api.getResumes();
      setResumes(data.items || []);
    } catch (e) {
      setResErr(String(e));
    }
  }

  useEffect(() => {
    loadMe();
    loadResumes();
  }, []);

  const fullName = me
    ? [me.last_name, me.first_name, me.middle_name].filter(Boolean).join(" ")
    : "";

  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-head">
          <h2>Профиль</h2>
          <button className="ghost-btn small" onClick={loadMe}>
            Обновить
          </button>
        </div>
        {meErr && <p className="status err">{meErr}</p>}
        {!me && !meErr && <p className="hint">Загрузка…</p>}
        {me && (
          <div className="info-block">
            <div className="name">{fullName}</div>
            <div>
              Email: {me.email || "—"}{" "}
              <span className={me.is_email_verified ? "ok-badge" : "warn-badge"}>
                {me.is_email_verified ? "подтверждён" : "не подтверждён"}
              </span>
            </div>
            <div>Телефон: {me.phone || "—"}</div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Мои резюме</h2>
          <button className="ghost-btn small" onClick={loadResumes}>
            Обновить
          </button>
        </div>
        {resErr && <p className="status err">{resErr}</p>}
        {!resumes && !resErr && <p className="hint">Загрузка…</p>}
        {resumes && resumes.length === 0 && <p className="hint">Резюме не найдены.</p>}
        {resumes &&
          resumes.map((r, i) => (
            <div className="resume-item" key={i}>
              <div className="title">{r.title}</div>
              <div className="meta">
                <span className={"badge " + (r.status?.id === "published" ? "published" : "")}>
                  {r.status?.name || r.status?.id || ""}
                </span>
                Обновлено: {(r.updated_at || "").slice(0, 10)} · просмотры: {r.views ?? "—"} ·
                отклики: {r.new_messages ?? "—"}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- настройки

function Settings({
  theme,
  setTheme,
  store,
  onOpenProviders,
  onAgentModel,
}: {
  theme: string;
  setTheme: (t: string) => void;
  store: AgentStore;
  onOpenProviders: () => void;
  onAgentModel: (m: string | null) => void;
}) {
  const active =
    store.active !== null && store.active < store.providers.length
      ? store.providers[store.active]
      : null;

  const [models, setModels] = useState<string[]>([]);
  const [modelsErr, setModelsErr] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setModelsErr("");
    api
      .agentTest(active)
      .then((res) => !cancelled && setModels(res.models || []))
      .catch((e) => !cancelled && setModelsErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [active?.base_url, active?.api_key]);

  const agentModel = store.agent_model || active?.model || "";

  return (
    <div className="settings-col">
      <div className="card">
        <div className="card-head">
          <h2>Внешний вид</h2>
        </div>
        <div className="segmented">
          <button
            className={theme === "light" ? "seg active" : "seg"}
            onClick={() => setTheme("light")}
          >
            Светлая
          </button>
          <button
            className={theme === "dark" ? "seg active" : "seg"}
            onClick={() => setTheme("dark")}
          >
            Тёмная
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>ИИ-провайдер</h2>
          <button className="ghost-btn small" onClick={onOpenProviders}>
            Настроить
          </button>
        </div>
        {active ? (
          <>
            <div className="active-provider-row">
              <span className="active-name">{active.name || "Без названия"}</span>
              <span className="active-model">{active.base_url}</span>
            </div>
            <label>
              Основная модель агента
              {models.length > 0 ? (
                <ModelSelect
                  value={agentModel}
                  options={models}
                  onChange={(m) => onAgentModel(m || null)}
                  wide
                />
              ) : (
                <>
                  <input
                    value={agentModel}
                    onChange={(e) => onAgentModel(e.target.value || null)}
                    placeholder={modelsErr ? "Список недоступен — укажите модель вручную" : "Загрузка…"}
                  />
                  {modelsErr && <p className="status err">{modelsErr}</p>}
                </>
              )}
            </label>
          </>
        ) : (
          <p className="hint">
            Провайдер не выбран. Добавьте OpenAI-совместимый API — он понадобится для чата с агентом.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- провайдеры

function Providers({
  onBack,
  onSaved,
}: {
  onBack: () => void;
  onSaved: (store: AgentStore) => void;
}) {
  const [store, setStore] = useState<AgentStore>({ providers: [], active: null });
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    api
      .agentsLoad()
      .then(setStore)
      .catch((e) => setStatus({ text: String(e), ok: false }));
  }, []);

  function patch(i: number, cfg: AgentConfig) {
    setStore((s) => ({
      ...s,
      providers: s.providers.map((p, j) => (j === i ? cfg : p)),
    }));
  }

  function add() {
    setStore((s) => ({
      ...s,
      providers: [...s.providers, { name: "", base_url: "", api_key: "", model: "" }],
      active: s.active === null && s.providers.length === 0 ? 0 : s.active,
    }));
  }

  function del(i: number) {
    setStore((s) => {
      const providers = s.providers.filter((_, j) => j !== i);
      let active = s.active;
      if (active === i) active = null;
      else if (active !== null && active > i) active -= 1;
      return { providers, active };
    });
  }

  async function save() {
    try {
      await api.agentsSave(store);
      onSaved(store);
      setStatus({ text: "Настройки сохранены", ok: true });
    } catch (e) {
      setStatus({ text: String(e), ok: false });
    }
  }

  return (
    <div className="card wide">
      <div className="card-head">
        <div className="row gap">
          <button className="link-btn back-btn" onClick={onBack}>
            ← Настройки
          </button>
          <h2>ИИ-провайдеры</h2>
        </div>
        <button className="btn-primary small" onClick={add}>
          + Добавить
        </button>
      </div>
      <p className="hint">
        Несколько OpenAI-совместимых API. Модели считываются с провайдера автоматически;
        вручную указать можно, если провайдер не отдаёт список. Радиокнопкой отметьте активного.
      </p>
      {store.providers.length === 0 && (
        <p className="hint">Пока не добавлено ни одного провайдера.</p>
      )}
      {store.providers.map((p, i) => (
        <ProviderCard
          key={i}
          cfg={p}
          active={store.active === i}
          onChange={(cfg) => patch(i, cfg)}
          onSetActive={() => setStore((s) => ({ ...s, active: i }))}
          onDelete={() => del(i)}
        />
      ))}
      <div className="row">
        <button className="btn-primary" onClick={save}>
          Сохранить
        </button>
      </div>
      {status && <p className={"status " + (status.ok ? "ok" : "err")}>{status.text}</p>}
    </div>
  );
}

function ProviderCard({
  cfg,
  active,
  onChange,
  onSetActive,
  onDelete,
}: {
  cfg: AgentConfig;
  active: boolean;
  onChange: (cfg: AgentConfig) => void;
  onSetActive: () => void;
  onDelete: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [modelsErr, setModelsErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function fetchModels() {
    if (!cfg.base_url.trim() || !cfg.api_key.trim()) return;
    setLoading(true);
    setModelsErr("");
    try {
      const res = await api.agentTest(cfg);
      setModels(res.models || []);
      if (!cfg.model && res.models?.length) {
        onChange({ ...cfg, model: res.models[0] });
      }
    } catch (e) {
      setModels([]);
      setModelsErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  // автозагрузка при открытии; далее — по blur полей URL и ключа
  useEffect(() => {
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k: keyof AgentConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...cfg, [k]: e.target.value });

  return (
    <div className={"provider" + (active ? " active-provider" : "")}>
      <div className="provider-head">
        <label className="radio">
          <input
            type="radio"
            name="active-provider"
            checked={active}
            onChange={onSetActive}
            title="Сделать активным"
          />
          <input
            className="p-name"
            value={cfg.name}
            onChange={set("name")}
            placeholder="Название (например, OpenAI)"
          />
        </label>
        <button className="link-btn" onClick={onDelete}>
          Удалить
        </button>
      </div>
      <label>
        Base URL
        <input value={cfg.base_url} onChange={set("base_url")} onBlur={fetchModels} placeholder="https://api.openai.com/v1" />
      </label>
      <label>
        API-ключ
        <input type="password" value={cfg.api_key} onChange={set("api_key")} onBlur={fetchModels} placeholder="sk-..." />
      </label>
      <label>
        Модель
        {loading ? (
          <input value="" placeholder="Считываем модели…" disabled />
        ) : models.length > 0 ? (
          <ModelSelect
            value={cfg.model}
            options={models}
            onChange={(m) => onChange({ ...cfg, model: m })}
            wide
          />
        ) : (
          <>
            <input
              value={cfg.model}
              onChange={set("model")}
              placeholder={modelsErr ? "Список недоступен — укажите модель вручную" : "Например, gpt-4o-mini"}
            />
            {modelsErr && <p className="status err">{modelsErr}</p>}
          </>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- приложение

export default function App() {
  const { theme, setTheme } = useTheme();
  const [screen, setScreen] = useState<Screen>("loading");
  const [tab, setTab] = useState<Tab>("chat");
  const [providersOpen, setProvidersOpen] = useState(false);
  const [store, setStore] = useState<AgentStore>({ providers: [], active: null });

  useEffect(() => {
    api
      .authStatus()
      .then((st) => setScreen(st.logged_in ? "app" : "login"))
      .catch(() => setScreen("login"));
  }, []);

  useEffect(() => {
    if (screen === "app") {
      api
        .agentsLoad()
        .then(setStore)
        .catch(() => {});
    }
  }, [screen]);

  async function logout() {
    await api.logout().catch(() => {});
    setScreen("login");
    setTab("chat");
    setProvidersOpen(false);
  }

  function setAgentModel(m: string | null) {
    setStore((s) => ({ ...s, agent_model: m }));
    api.agentsSave({ ...store, agent_model: m }).catch(() => {});
  }

  if (screen === "loading") return null;

  if (screen === "login") {
    return <LoginScreen onDone={() => setScreen("app")} />;
  }

  return (
    <>
      <header>
        <div className="logo">
          <span className="logo-text">
            HH-bot<span className="logo-accent">.</span>
          </span>
        </div>
        <nav className="pill-nav">
          <button className={"tab-btn" + (tab === "chat" ? " active" : "")} onClick={() => setTab("chat")}>
            Чат
          </button>
          <button className={"tab-btn" + (tab === "profile" ? " active" : "")} onClick={() => setTab("profile")}>
            Профиль
          </button>
          <button className={"tab-btn" + (tab === "settings" ? " active" : "")} onClick={() => setTab("settings")}>
            Настройки
          </button>
        </nav>
        <div className="header-right">
          <button className="ghost-btn" onClick={logout}>
            Выйти
          </button>
        </div>
      </header>

      <main className={tab === "chat" ? "chat-page" : ""}>
        {tab === "chat" && <Chat store={store} />}
        {tab === "profile" && <Profile />}
        {tab === "settings" &&
          (providersOpen ? (
            <Providers
              onBack={() => setProvidersOpen(false)}
              onSaved={(s) => setStore(s)}
            />
          ) : (
            <Settings
              theme={theme}
              setTheme={setTheme}
              store={store}
              onOpenProviders={() => setProvidersOpen(true)}
              onAgentModel={setAgentModel}
            />
          ))}
      </main>
    </>
  );
}
