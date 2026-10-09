import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRight, BrainCircuit, Plus, Tag } from "lucide-react";
import { api, isDemo, AgentConfig, AgentMode, AgentStore, Me, ProfileData, Resume, resumeHidden } from "./api";
import ModelSelect from "./ModelSelect";
import type { ModelEntry } from "./api";
import { loadAllModels } from "./api";
import Chat from "./Chat";
import Vacancies from "./Vacancies";
import Chats from "./Chats";
import Knowledge from "./Knowledge";

type Screen = "loading" | "login" | "app";
type Tab = "chat" | "vacancies" | "hhchats" | "knowledge" | "profile" | "settings";

type ThemeSetting = "system" | "light" | "dark";

function useTheme() {
  const [theme, setThemeState] = useState<ThemeSetting>(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  // живёт ли webview в Tauri: там prefers-color-scheme не следует теме ОС,
  // поэтому системную тему берём у окна Tauri
  const [hasTauriTheme, setHasTauriTheme] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        const t = await win.theme();
        if (cancelled) return;
        if (t === "light" || t === "dark") {
          setHasTauriTheme(true);
          setSystemDark(t === "dark");
        }
        unlisten = await win.onThemeChanged((e) => {
          if (!cancelled) setSystemDark(e.payload === "dark");
        });
      } catch {
        // демо/браузер — остаёмся на matchMedia
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (hasTauriTheme) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [hasTauriTheme]);
  useEffect(() => {
    document.documentElement.dataset.theme =
      theme === "system" ? (systemDark ? "dark" : "light") : theme;
  }, [theme, systemDark]);
  // выбор темы сохраняем: без этого он терялся при каждом запуске
  const setTheme = (t: ThemeSetting) => {
    localStorage.setItem("theme", t);
    setThemeState(t);
  };
  return { theme, setTheme };
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

// ---------------------------------------------------------------- профиль: знания о пользователе

function Profile({ onNavigate }: { onNavigate?: (tab: Tab) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState("");
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [resErr, setResErr] = useState("");
  const [unpublishing, setUnpublishing] = useState<string | null>(null);
  const [resAction, setResAction] = useState<{ text: string; ok: boolean } | null>(null);

  const [profile, setProfile] = useState<ProfileData>({});
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState("");

  async function loadMe() {
    setMeErr("");
    try {
      setMe(await api.getMe());
    } catch (e) {
      setMeErr(String(e));
    }
  }

  async function loadResumes() {
    setResErr("");
    setResumes(null);
    setResAction(null);
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
    api
      .profileLoad()
      .then((d) => setProfile(d || {}))
      .catch(() => {});
  }, []);

  const notes = profile.notes || [];

  const topicsSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of notes) {
      const t = (n.topic || "").trim() || "Без темы";
      map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [notes]);

  // Смена статуса поиска: сразу меняем на hh.ru и сохраняем локально.
  async function changeSearchStatus(id: string) {
    const prev = profile.positions?.search_status || "";
    if (statusBusy || id === prev) return;
    setStatusBusy(true);
    setStatusErr("");
    setProfile((p) => ({ ...p, positions: { ...p.positions, search_status: id } }));
    try {
      await api.setJobSearchStatus(id);
      const next = { ...profile, positions: { ...profile.positions, search_status: id } };
      setProfile(next);
      await api.profileSave(next);
    } catch (e) {
      setProfile((p) => ({ ...p, positions: { ...p.positions, search_status: prev } }));
      setStatusErr(String(e));
    } finally {
      setStatusBusy(false);
    }
  }

  async function unpublish(r: Resume) {
    if (!r.id) return;
    setUnpublishing(r.id);
    setResAction(null);
    try {
      await api.unpublishResume(r.id);
      setResAction({ text: `Резюме «${r.title}» снято с показа на hh.ru (видимость «не показывать никому»).`, ok: true });
      await loadResumes();
    } catch (e) {
      setResAction({ text: String(e), ok: false });
    } finally {
      setUnpublishing(null);
    }
  }

  async function publish(r: Resume) {
    if (!r.id) return;
    setUnpublishing(r.id);
    setResAction(null);
    try {
      await api.publishResume(r.id);
      setResAction({ text: `Резюме «${r.title}» опубликовано (видно работодателям).`, ok: true });
      await loadResumes();
    } catch (e) {
      setResAction({ text: String(e), ok: false });
    } finally {
      setUnpublishing(null);
    }
  }

  async function editResume(r: Resume) {
    if (!r.id) return;
    setResAction(null);
    try {
      await api.openResumeEditor(r.id);
      setResAction({ text: `Открыл окно редактирования «${r.title}» на hh.ru.`, ok: true });
    } catch (e) {
      setResAction({ text: String(e), ok: false });
    }
  }

  async function createResume() {
    setResAction(null);
    try {
      await api.openResumeCreator();
      setResAction({
        text: "Открыл форму создания резюме на hh.ru. Попросите агента в чате подготовить тексты из знаний о вас — их можно вставить в форму.",
        ok: true,
      });
    } catch (e) {
      setResAction({ text: String(e), ok: false });
    }
  }

  const fullName = me
    ? [me.last_name, me.first_name, me.middle_name].filter(Boolean).join(" ")
    : "";

  const searchStatus = profile.positions?.search_status || "";

  return (
    <div className="profile-grid">
      <div className="profile-col">
        <div className="card">
          <div className="card-head">
            <h2>Информация из профиля hh.ru</h2>
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
                {me.email || "—"}{" "}
                <span className={me.is_email_verified ? "ok-badge" : "warn-badge"}>
                  {me.is_email_verified ? "почта подтверждена" : "почта не подтверждена"}
                </span>
              </div>
              <div>{me.phone || "Телефон не указан"}</div>
            </div>
          )}

          <div className="status-row">
            <span className="status-label">Статус поиска</span>
            <div className="segmented wrap">
              {[
                { id: "active_search", label: "Активно ищу работу" },
                { id: "looking_for_offers", label: "Рассматриваю предложения" },
                { id: "not_looking_for_job", label: "Не ищу работу" },
              ].map((s) => (
                <button
                  key={s.id}
                  className={searchStatus === s.id ? "seg active" : "seg"}
                  disabled={statusBusy}
                  onClick={() => changeSearchStatus(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {statusErr && <p className="status err">{statusErr}</p>}
          </div>
        </div>

        <div className="card profile-knowledge-summary-card">
          <div className="card-head">
            <div className="profile-knowledge-head-title">
              <BrainCircuit size={18} className="profile-knowledge-icon" />
              <h2>Знания о вас</h2>
              <span className="profile-knowledge-badge">
                {notes.length} {notes.length === 1 ? "факт" : notes.length >= 2 && notes.length <= 4 ? "факта" : "фактов"}
              </span>
            </div>
            {onNavigate && (
              <button
                className="ghost-btn small"
                onClick={() => onNavigate("knowledge")}
                title="Перейти к базе знаний со всеми плитками"
              >
                Все знания <ArrowRight size={13} style={{ verticalAlign: -1, marginLeft: 2 }} />
              </button>
            )}
          </div>
          <p className="hint">
            Факты, которые агент запоминает во время общения: опыт, стек, условия и цели.
            На их основе он подбирает вакансии и готовит тексты для резюме.
          </p>

          {notes.length === 0 ? (
            <div className="profile-knowledge-empty">
              <p className="hint">Пока фактов нет. Расскажите агенту о себе в чате или добавьте их вручную.</p>
              {onNavigate && (
                <button className="btn-primary small" onClick={() => onNavigate("knowledge")}>
                  <Plus size={13} /> Добавить в базу знаний
                </button>
              )}
            </div>
          ) : (
            <div className="profile-knowledge-body">
              {/* Теги категорий с количеством фактов */}
              <div className="profile-knowledge-topics">
                {topicsSummary.slice(0, 5).map(([topic, count]) => (
                  <button
                    key={topic}
                    className="profile-topic-chip"
                    onClick={() => onNavigate?.("knowledge")}
                    title={`Показать факты «${topic}» в базе знаний`}
                  >
                    <Tag size={10} />
                    <span>{topic}</span>
                    <span className="profile-topic-count">{count}</span>
                  </button>
                ))}
                {topicsSummary.length > 5 && (
                  <button
                    className="profile-topic-chip more"
                    onClick={() => onNavigate?.("knowledge")}
                  >
                    +{topicsSummary.length - 5} ещё
                  </button>
                )}
              </div>

              {/* Превью последних 2-3 фактов в виде аккуратных плашек */}
              <div className="profile-knowledge-preview-list">
                {notes.slice(-3).reverse().map((n, i) => (
                  <div
                    className="profile-knowledge-mini-tile"
                    key={i}
                    onClick={() => onNavigate?.("knowledge")}
                    title="Перейти к базе знаний для просмотра и редактирования"
                  >
                    <div className="profile-mini-tile-topic">{n.topic?.trim() || "Факт"}</div>
                    <div className="profile-mini-tile-text">{n.text}</div>
                  </div>
                ))}
              </div>

              <div className="profile-knowledge-footer-actions">
                {onNavigate && (
                  <button
                    className="btn-primary small"
                    onClick={() => onNavigate("knowledge")}
                  >
                    Перейти к базе знаний ({notes.length}) →
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Мои резюме</h2>
          <div className="row gap">
            <button className="btn-primary small" onClick={createResume} title="Открыть форму создания резюме на hh.ru">
              Создать резюме
            </button>
            <button className="ghost-btn small" onClick={loadResumes}>
              Обновить
            </button>
          </div>
        </div>
        {resErr && <p className="status err">{resErr}</p>}
        {!resumes && !resErr && <p className="hint">Загрузка…</p>}
        {resumes && resumes.length === 0 && <p className="hint">Резюме не найдены.</p>}
        {resumes && resumes.length > 0 && (
          <p className="hint">
            Резюме подгружены с hh.ru. Попросите агента в чате подготовить тексты для нового или
            обновлённого резюме — он соберёт их из знаний о вас.
          </p>
        )}
        {resumes &&
          resumes.map((r) => (
            <div className="resume-item" key={r.id || r.title}>
              <div className="title">{r.title}</div>
              <div className="meta">
                <span
                  className={
                    "badge " + (!resumeHidden(r) && r.status?.id === "published" ? "published" : "")
                  }
                >
                  {resumeHidden(r) ? "Снято с публикации" : r.status?.name || r.status?.id || ""}
                </span>
                Обновлено: {(r.updated_at || "").slice(0, 10)} · просмотры: {r.views ?? "—"} ·
                отклики: {r.new_messages ?? "—"}
              </div>
              {!resumeHidden(r) && r.status?.id === "published" && r.id && (
                <button
                  className="ghost-btn small unpublish-btn"
                  onClick={() => unpublish(r)}
                  disabled={unpublishing === r.id}
                  title="Снять резюме с публикации на hh.ru"
                >
                  {unpublishing === r.id ? "Снимаем…" : "Снять с публикации"}
                </button>
              )}
              {resumeHidden(r) && r.status?.id === "published" && r.id && (
                <button
                  className="ghost-btn small unpublish-btn"
                  onClick={() => publish(r)}
                  disabled={unpublishing === r.id}
                  title="Вернуть резюме на публикацию на hh.ru"
                >
                  {unpublishing === r.id ? "Публикуем…" : "Опубликовать"}
                </button>
              )}
              {r.id && (
                <button
                  className="ghost-btn small"
                  onClick={() => editResume(r)}
                  title="Редактировать резюме на hh.ru (откроется окно hh.ru)"
                >
                  Редактировать
                </button>
              )}
            </div>
          ))}
        {resAction && <p className={"status " + (resAction.ok ? "ok" : "err")}>{resAction.text}</p>}
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
  onSearchUrl,
}: {
  theme: ThemeSetting;
  setTheme: (t: ThemeSetting) => void;
  store: AgentStore;
  onOpenProviders: () => void;
  onAgentModel: (m: string | null) => void;
  onSearchUrl: (url: string | null) => void;
}) {
  const active =
    store.active !== null && store.active < store.providers.length
      ? store.providers[store.active]
      : null;

  // общий список моделей всех провайдеров — основную модель агента можно
  // взять у любого провайдера, а не только у активного
  const [modelEntries, setModelEntries] = useState<ModelEntry[]>([]);
  const [modelsErr, setModelsErr] = useState("");
  const providersSig = JSON.stringify(
    store.providers.map((p) => [p.base_url, p.api_key, p.ignored_models])
  );

  useEffect(() => {
    if (!store.providers.length) return;
    let cancelled = false;
    setModelsErr("");
    loadAllModels(store)
      .then((list) => !cancelled && setModelEntries(list))
      .catch((e) => !cancelled && setModelsErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [providersSig]);

  const agentModel = store.agent_model || active?.model || "";
  const selectedEntry = modelEntries.find((e) => e.model === agentModel);

  return (
    <div className="settings-col">
      <div className="card">
        <div className="card-head">
          <h2>Внешний вид</h2>
        </div>
        <div className="segmented">
          <button
            className={theme === "system" ? "seg active" : "seg"}
            onClick={() => setTheme("system")}
          >
            Системная
          </button>
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
              {modelEntries.length > 0 ? (
                <ModelSelect
                  value={selectedEntry ? selectedEntry.model : agentModel}
                  options={modelEntries.map((e) => e.model)}
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

      <SearchCard url={store.search_url || ""} onSave={onSearchUrl} />

      <ChatsCard />
    </div>
  );
}

function ChatsCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clearAll() {
    setBusy(true);
    try {
      await api.chatsClear();
      window.dispatchEvent(new Event("hh-chats-cleared"));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Чаты</h2>
      </div>
      <p className="hint">
        Полностью очищает историю чатов с агентом. Открытые сейчас переписки тоже удалятся —
        отменить это нельзя.
      </p>
      {confirming ? (
        <div className="danger-confirm">
          <span className="danger-question">Удалить всю историю чатов?</span>
          <button className="ghost-btn small" onClick={() => setConfirming(false)} disabled={busy}>
            Отмена
          </button>
          <button className="danger-btn small" onClick={clearAll} disabled={busy}>
            {busy ? "Удаляем…" : "Удалить"}
          </button>
        </div>
      ) : (
        <div className="clear-row">
          <button className="danger-btn small" onClick={() => setConfirming(true)}>
            Удалить все чаты
          </button>
        </div>
      )}
    </div>
  );
}

function SearchCard({
  url,
  onSave,
}: {
  url: string;
  onSave: (url: string | null) => void;
}) {
  const [value, setValue] = useState(url);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => setValue(url), [url]);

  async function test() {
    setTesting(true);
    setStatus(null);
    // проверяем то, что введено, даже если ещё не сохранено
    try {
      const res = await api.searchTest("свежие вакансии frontend", value.trim() || undefined);
      const first = res.results?.[0];
      setStatus({
        text: `Поиск работает через ${res.backend}. Пример: «${first?.title || "?"}»`,
        ok: true,
      });
    } catch (e) {
      setStatus({ text: String(e), ok: false });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>Поиск в интернете</h2>
        <div className="row gap">
          <button className="ghost-btn small" onClick={test} disabled={testing}>
            {testing ? "Проверяем…" : "Проверить"}
          </button>
          <button
            className="btn-primary small"
            onClick={() => onSave(value.trim() || null)}
          >
            Сохранить
          </button>
        </div>
      </div>
      <p className="hint">
        По умолчанию используется публичный поиск. Если он недоступен, укажите свой SearXNG-инстанс
        (например, <code>https://searx.example.org</code>) — поиск пойдёт через него.
      </p>
      <label>
        SearXNG URL (необязательно)
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://searx.example.org"
        />
      </label>
      {status && <p className={"status " + (status.ok ? "ok" : "err")}>{status.text}</p>}
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
      providers: [...s.providers, { name: "", base_url: "", api_key: "", model: "", rate_limit: 0, ignored_models: [] }],
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
        Лимит запросов в минуту
        <input
          type="number"
          min={0}
          value={cfg.rate_limit || 0}
          onChange={(e) =>
            onChange({ ...cfg, rate_limit: Math.max(0, Number(e.target.value) || 0) })
          }
          placeholder="0 — без лимита"
        />
      </label>
      <p className="hint">
        Ограничение запросов к этому провайдеру, чтобы не упереться в его лимиты.
        Например, 30 — не больше 30 запросов в минуту. 0 — без ограничения.
      </p>
      {models.length > 0 ? (
        <div className="ignore-models">
          <span className="ignore-title">Показывать в списке моделей</span>
          <div className="ignore-list">
            {models.map((m) => {
              const ignored = (cfg.ignored_models || []).includes(m);
              return (
                <label key={m} className="check">
                  <input
                    type="checkbox"
                    checked={!ignored}
                    onChange={() =>
                      onChange({
                        ...cfg,
                        ignored_models: ignored
                          ? (cfg.ignored_models || []).filter((x) => x !== m)
                          : [...(cfg.ignored_models || []), m],
                      })
                    }
                  />
                  <span className="check-label">{m}</span>
                </label>
              );
            })}
          </div>
          {(cfg.ignored_models || []).length > 0 && (
            <p className="hint">
              Снято с показа: {(cfg.ignored_models || []).join(", ")} — эти модели не появятся
              в списках моделей.
            </p>
          )}
        </div>
      ) : (
        <p className="hint">
          {loading
            ? "Загружаем список моделей…"
            : "Список моделей недоступен — игнорирование недоступно, модель можно указать вручную ниже."}
        </p>
      )}
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
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => (localStorage.getItem("agent_mode") as AgentMode) || "chat"
  );

  function changeAgentMode(m: AgentMode) {
    setAgentMode(m);
    localStorage.setItem("agent_mode", m);
  }

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

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

  function setAgentSearchUrl(url: string | null) {
    const next = { ...store, search_url: url };
    setStore(next);
    api.agentsSave(next).catch(() => {});
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
          {isDemo && <span className="demo-badge">Демо — данные ненастоящие</span>}
        </div>
        <nav className="pill-nav">
          <button className={"tab-btn" + (tab === "chat" ? " active" : "")} onClick={() => setTab("chat")}>
            Агент
          </button>
          <button className={"tab-btn" + (tab === "vacancies" ? " active" : "")} onClick={() => setTab("vacancies")}>
            Вакансии
          </button>
          <button className={"tab-btn" + (tab === "hhchats" ? " active" : "")} onClick={() => setTab("hhchats")}>
            Чаты
          </button>
          <button className={"tab-btn" + (tab === "knowledge" ? " active" : "")} onClick={() => setTab("knowledge")}>
            Знания
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

      <main className={
        tab === "chat" ? "chat-page" :
        tab === "vacancies" ? "vac-page" :
        tab === "hhchats" ? "hhch-page" :
        tab === "knowledge" ? "know-page" : ""
      }>
        <div style={{ display: tab === "chat" ? "contents" : "none" }}>
          <Chat
            store={store}
            mode={agentMode}
            onMode={changeAgentMode}
            onTheme={setTheme}
            onNavigate={setTab}
          />
        </div>
        {tab === "vacancies" && <Vacancies />}
        {tab === "hhchats" && <Chats />}
        {tab === "knowledge" && <Knowledge onNavigate={setTab} />}
        {tab === "profile" && <Profile onNavigate={setTab} />}
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
              onSearchUrl={setAgentSearchUrl}
            />
          ))}
      </main>
    </>
  );
}
