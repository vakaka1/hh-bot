import { useEffect, useState } from "react";
import { api, AgentConfig, AgentMode, AgentStore, Me, ProfileData, Resume } from "./api";
import ModelSelect from "./ModelSelect";
import Chat from "./Chat";

type Screen = "loading" | "login" | "app";
type Tab = "chat" | "profile" | "settings";

type ThemeSetting = "system" | "light" | "dark";

function useTheme() {
  const [theme, setTheme] = useState<ThemeSetting>(() => {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme =
      theme === "system" ? (systemDark ? "dark" : "light") : theme;
  }, [theme, systemDark]);
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

// ---------------------------------------------------------------- профиль пользователя

const EMPLOYMENT_OPTIONS = [
  { id: "full", label: "Полная занятость" },
  { id: "part", label: "Частичная" },
  { id: "project", label: "Проектная" },
  { id: "internship", label: "Стажировка" },
];

const SCHEDULE_OPTIONS = [
  { id: "full_day", label: "Полный день" },
  { id: "flexible", label: "Гибкий график" },
  { id: "remote", label: "Удалённая работа" },
  { id: "hybrid", label: "Гибрид" },
  { id: "shift", label: "Сменный" },
  { id: "fly_in_fly_out", label: "Вахта" },
];

function ChipSelect({
  value,
  options,
  onChange,
  multi,
}: {
  value: string[];
  options: { id: string; label: string }[];
  onChange: (v: string[]) => void;
  multi: boolean;
}) {
  function toggle(id: string) {
    if (!multi) {
      onChange(value.includes(id) ? [] : [id]);
      return;
    }
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  }
  return (
    <div className="chip-select">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={"chip" + (value.includes(o.id) ? " active" : "")}
          onClick={() => toggle(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// редактируемый элемент списка (место работы, учёба, проект)
function ListCard({
  title,
  fields,
  value,
  onChange,
  onDelete,
}: {
  title: string;
  fields: { key: string; label: string; long?: boolean }[];
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  onDelete: () => void;
}) {
  const filled = fields.some((f) => (value[f.key] || "").trim());
  return (
    <div className="list-card">
      <div className="list-card-head">
        <span className="list-card-title">{filled ? title : "Новая запись"}</span>
        <button className="link-btn" onClick={onDelete}>
          Удалить
        </button>
      </div>
      {fields.map((f) =>
        f.long ? (
          <label key={f.key}>
            {f.label}
            <textarea
              rows={2}
              value={value[f.key] || ""}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
          </label>
        ) : (
          <label key={f.key}>
            {f.label}
            <input
              value={value[f.key] || ""}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
          </label>
        )
      )}
    </div>
  );
}

const EXPERIENCE_FIELDS = [
  { key: "company", label: "Компания" },
  { key: "position", label: "Должность" },
  { key: "period", label: "Период (например, 2021 — сейчас)" },
  { key: "description", label: "Чем занимались", long: true },
  { key: "achievements", label: "Достижения", long: true },
];

const EDUCATION_FIELDS = [
  { key: "institution", label: "Учебное заведение" },
  { key: "specialty", label: "Специальность" },
  { key: "period", label: "Годы учёбы" },
];

const PROJECT_FIELDS = [
  { key: "name", label: "Название проекта" },
  { key: "role", label: "Ваша роль" },
  { key: "description", label: "О проекте", long: true },
];

function Profile() {
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState("");
  const [resumes, setResumes] = useState<Resume[] | null>(null);
  const [resErr, setResErr] = useState("");
  const [unpublishing, setUnpublishing] = useState<string | null>(null);
  const [resAction, setResAction] = useState<{ text: string; ok: boolean } | null>(null);

  const [profile, setProfile] = useState<ProfileData>({});
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileErr, setProfileErr] = useState("");
  const [saving, setSaving] = useState(false);
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

  function patch(p: Partial<ProfileData>) {
    setProfile((prev) => ({ ...prev, ...p }));
    setProfileSaved(false);
  }

  function patchPositions(p: Partial<NonNullable<ProfileData["positions"]>>) {
    setProfile((prev) => ({ ...prev, positions: { ...prev.positions, ...p } }));
    setProfileSaved(false);
  }

  // обновить элемент или добавить новый, если index за пределами списка
  function patchItem<K extends "experience" | "education" | "projects">(
    key: K,
    index: number,
    value: Record<string, string> | null
  ) {
    setProfile((prev) => {
      const list = [...((prev[key] || []) as Record<string, string>[])];
      if (value === null) list.splice(index, 1);
      else list[index] = value;
      return { ...prev, [key]: list };
    });
    setProfileSaved(false);
  }

  function addNote() {
    setProfile((prev) => ({
      ...prev,
      notes: [...(prev.notes || []), { topic: "", text: "", added_at: Date.now() / 1000 }],
    }));
    setProfileSaved(false);
  }

  function patchNote(index: number, text: string, topic: string) {
    setProfile((prev) => ({
      ...prev,
      notes: (prev.notes || []).map((n, i) => (i === index ? { ...n, text, topic } : n)),
    }));
    setProfileSaved(false);
  }

  function removeNote(index: number) {
    setProfile((prev) => ({ ...prev, notes: (prev.notes || []).filter((_, i) => i !== index) }));
    setProfileSaved(false);
  }

  async function saveProfile() {
    setSaving(true);
    setProfileErr("");
    try {
      await api.profileSave(profile);
      setProfileSaved(true);
    } catch (e) {
      setProfileErr(String(e));
    } finally {
      setSaving(false);
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

  // Смена статуса поиска: сразу меняем на hh.ru и сохраняем локально для
  // агента. При ошибке откатываем выбор.
  async function changeSearchStatus(id: string) {
    const prev = profile.positions?.search_status || "";
    if (statusBusy || id === prev) return;
    setStatusBusy(true);
    setStatusErr("");
    patchPositions({ search_status: id });
    try {
      await api.setJobSearchStatus(id);
      const next = { ...profile, positions: { ...profile.positions, search_status: id } };
      setProfile(next);
      await api.profileSave(next);
      setProfileSaved(true);
    } catch (e) {
      patchPositions({ search_status: prev });
      setStatusErr(String(e));
    } finally {
      setStatusBusy(false);
    }
  }

  const fullName = me
    ? [me.last_name, me.first_name, me.middle_name].filter(Boolean).join(" ")
    : "";

  const positions = profile.positions || {};
  const searchStatus = positions.search_status || "";
  const skillsText = (profile.skills || []).join(", ");

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
            {!searchStatus && !statusErr && (
              <p className="hint">Укажите статус — он изменится и на hh.ru, и для агента.</p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Профиль</h2>
            <button
              className="btn-primary small"
              onClick={saveProfile}
              disabled={saving || profileSaved}
            >
              {saving ? "Сохраняем…" : profileSaved ? "Сохранено" : "Сохранить"}
            </button>
          </div>
          <p className="hint">
            Это то, что агент знает о вас и чем заполнит резюме. Рассказывайте о себе в чате —
            агент пополнит профиль сам; здесь можно проверить и поправить.
          </p>

          <div className="about-form">
            <div className="field-label">Условия работы</div>
            <label>
              Желаемая должность
              <input
                value={positions.desired_title || ""}
                onChange={(e) => patchPositions({ desired_title: e.target.value })}
                placeholder="Например, frontend-разработчик"
              />
            </label>
            <div className="about-two-col">
              <label>
                Город
                <input
                  value={positions.area || ""}
                  onChange={(e) => patchPositions({ area: e.target.value })}
                  placeholder="Например, Москва"
                />
              </label>
              <label>
                Зарплата, ₽/мес
                <input
                  inputMode="numeric"
                  value={positions.salary || ""}
                  onChange={(e) => patchPositions({ salary: e.target.value.replace(/[^\d\s]/g, "") })}
                  placeholder="Например, 250000"
                />
              </label>
            </div>
            <div className="field-label">Занятость</div>
            <ChipSelect
              value={positions.employment || []}
              options={EMPLOYMENT_OPTIONS}
              onChange={(v) => patchPositions({ employment: v })}
              multi
            />
            <div className="field-label">График</div>
            <ChipSelect
              value={positions.schedule || []}
              options={SCHEDULE_OPTIONS}
              onChange={(v) => patchPositions({ schedule: v })}
              multi
            />
          </div>

          <div className="about-form">
            <div className="field-label">Навыки</div>
            <input
              value={skillsText}
              onChange={(e) =>
                patch({
                  skills: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="Через запятую: React, TypeScript, SQL"
            />
          </div>

          <div className="about-form">
            <div className="list-head">
              <div className="field-label">Опыт работы</div>
              <button
                className="ghost-btn small"
                onClick={() => patchItem("experience", (profile.experience || []).length, {})}
              >
                + Добавить
              </button>
            </div>
            {(profile.experience || []).length === 0 && (
              <p className="hint">Пока пусто — добавьте места работы или расскажите о них агенту.</p>
            )}
            {(profile.experience || []).map((item, i) => (
              <ListCard
                key={i}
                title={[item.company, item.position].filter(Boolean).join(" — ") || "Место работы"}
                fields={EXPERIENCE_FIELDS}
                value={item as Record<string, string>}
                onChange={(v) => patchItem("experience", i, v)}
                onDelete={() => patchItem("experience", i, null)}
              />
            ))}
          </div>

          <div className="about-form">
            <div className="list-head">
              <div className="field-label">Образование</div>
              <button
                className="ghost-btn small"
                onClick={() => patchItem("education", (profile.education || []).length, {})}
              >
                + Добавить
              </button>
            </div>
            {(profile.education || []).map((item, i) => (
              <ListCard
                key={i}
                title={item.institution || "Учебное заведение"}
                fields={EDUCATION_FIELDS}
                value={item as Record<string, string>}
                onChange={(v) => patchItem("education", i, v)}
                onDelete={() => patchItem("education", i, null)}
              />
            ))}
          </div>

          <div className="about-form">
            <div className="list-head">
              <div className="field-label">Проекты</div>
              <button
                className="ghost-btn small"
                onClick={() => patchItem("projects", (profile.projects || []).length, {})}
              >
                + Добавить
              </button>
            </div>
            {(profile.projects || []).map((item, i) => (
              <ListCard
                key={i}
                title={item.name || "Проект"}
                fields={PROJECT_FIELDS}
                value={item as Record<string, string>}
                onChange={(v) => patchItem("projects", i, v)}
                onDelete={() => patchItem("projects", i, null)}
              />
            ))}
          </div>

          <div className="about-form">
            <label>
              Коротко о себе
              <textarea
                rows={3}
                value={profile.about || ""}
                onChange={(e) => patch({ about: e.target.value })}
                placeholder="Чем занимаетесь, что вам важно в работе, чего избегать"
              />
            </label>
          </div>

          <div className="about-form">
            <div className="list-head">
              <div className="field-label">Заметки — факты о вас</div>
              <button className="ghost-btn small" onClick={addNote}>
                + Добавить
              </button>
            </div>
            <p className="hint">
              Всё, что стоит помнить агенту: обстоятельства, предпочтения, важные мелочи.
              Агент добавляет их сам, когда вы что-то рассказываете.
            </p>
            {(profile.notes || []).map((n, i) => (
              <div className="note-row" key={i}>
                <input
                  className="note-topic"
                  value={n.topic || ""}
                  onChange={(e) => patchNote(i, n.text, e.target.value)}
                  placeholder="Тема"
                />
                <input
                  value={n.text}
                  onChange={(e) => patchNote(i, e.target.value, n.topic || "")}
                  placeholder="Факт"
                />
                <button className="link-btn" onClick={() => removeNote(i)}>
                  Удалить
                </button>
              </div>
            ))}
          </div>
          {profileErr && <p className="status err">{profileErr}</p>}
        </div>
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
        {resumes && resumes.length > 0 && (
          <p className="hint">
            Резюме подгружены с hh.ru. Попросите агента в чате подготовить тексты для нового или
            обновлённого резюме из вашего профиля.
          </p>
        )}
        {resumes &&
          resumes.map((r) => (
            <div className="resume-item" key={r.id || r.title}>
              <div className="title">{r.title}</div>
              <div className="meta">
                <span className={"badge " + (r.status?.id === "published" ? "published" : "")}>
                  {r.status?.name || r.status?.id || ""}
                </span>
                Обновлено: {(r.updated_at || "").slice(0, 10)} · просмотры: {r.views ?? "—"} ·
                отклики: {r.new_messages ?? "—"}
              </div>
              {r.status?.id === "published" && r.id && (
                <button
                  className="ghost-btn small unpublish-btn"
                  onClick={() => unpublish(r)}
                  disabled={unpublishing === r.id}
                  title="Снять резюме с публикации на hh.ru"
                >
                  {unpublishing === r.id ? "Снимаем…" : "Снять с публикации"}
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

      <SearchCard url={store.search_url || ""} onSave={onSearchUrl} />
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
  const [agentMode, setAgentMode] = useState<AgentMode>(
    () => (localStorage.getItem("agent_mode") as AgentMode) || "chat"
  );

  function changeAgentMode(m: AgentMode) {
    setAgentMode(m);
    localStorage.setItem("agent_mode", m);
  }

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
        <div style={{ display: tab === "chat" ? "contents" : "none" }}>
          <Chat
            store={store}
            mode={agentMode}
            onMode={changeAgentMode}
            onTheme={setTheme}
            onNavigate={setTab}
          />
        </div>
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
              onSearchUrl={setAgentSearchUrl}
            />
          ))}
      </main>
    </>
  );
}
