import { useEffect, useState } from "react";
import { api, Area, RoleCategory, Tracking, Vacancy, VacancySearchParams, flattenAreas, flattenRoles } from "./api";
import ModelSelect from "./ModelSelect";

// ---------------------------------------------------------------- справочники фильтров

const PER_PAGE = 10;

function vacanciesWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return "вакансий";
  if (mod10 === 1) return "вакансия";
  if (mod10 >= 2 && mod10 <= 4) return "вакансии";
  return "вакансий";
}

type Opt = { id: string; label: string };

// подписи и порядок — как на hh.ru
const EXPERIENCE: Opt[] = [
  { id: "", label: "Любой опыт" },
  { id: "no_experience", label: "Нет опыта" },
  { id: "between1And3", label: "От 1 года до 3 лет" },
  { id: "between3And6", label: "От 3 до 6 лет" },
  { id: "moreThan6", label: "Более 6 лет" },
];

const EDUCATION: Opt[] = [
  { id: "", label: "Любое" },
  { id: "not_required_or_not_specified", label: "Не требуется или не указано" },
  { id: "special_secondary", label: "Среднее профессиональное" },
  { id: "higher", label: "Высшее" },
];

const PERIOD: Opt[] = [
  { id: "", label: "За всё время" },
  { id: "1", label: "За сутки" },
  { id: "3", label: "За 3 дня" },
  { id: "7", label: "За неделю" },
  { id: "30", label: "За месяц" },
];

const ORDER_BY: Opt[] = [
  { id: "", label: "По релевантности" },
  { id: "publication_time", label: "Сначала свежие" },
  { id: "salary_desc", label: "По зарплате" },
];

// важные метки вакансий (справочник vacancy_label hh.ru)
const LABEL_WHITELIST = [
  "with_address",
  "not_from_agency",
  "low_performance",
  "accredited_it",
  "accept_teens",
  "accept_kids",
  "accept_handicapped",
];

// hh.ru присылает описания с HTML-разметкой — вычищаем до читаемого текста
function stripHtml(s: string): string {
  return s
    .replace(/<highlighttext>|<\/highlighttext>/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function salaryText(v: Vacancy): string {
  const s = v.salary;
  if (!s || (s.from == null && s.to == null)) return "";
  const parts: string[] = [];
  if (s.from != null) parts.push(`от ${s.from.toLocaleString("ru-RU")}`);
  if (s.to != null) parts.push(`до ${s.to.toLocaleString("ru-RU")}`);
  const cur = s.currency === "RUR" ? "₽" : s.currency || "";
  return parts.join(" ") + " " + cur;
}

const EMPTY_FILTERS: VacancySearchParams = {
  text: "",
  search_field: "",
  excluded_text: "",
  area: "",
  professional_role: "",
  industry: "",
  experience: "",
  schedule: "",
  work_format: "",
  working_hours: "",
  working_time_modes: "",
  salary: null,
  only_with_salary: false,
  salary_frequency: "",
  employment_form: "",
  education: "",
  driver_license_types: "",
  label: [],
  search_period: null,
  order_by: "",
};

// ---------------------------------------------------------------- вкладка «Вакансии»

export default function Vacancies() {
  const [filters, setFilters] = useState<VacancySearchParams>({ ...EMPTY_FILTERS });

  // справочники hh.ru: регионы, профобласти, отрасли, общий /dictionaries
  const [areas, setAreas] = useState<{ id: string; name: string }[]>([]);
  const [areasLoading, setAreasLoading] = useState(false);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [industries, setIndustries] = useState<{ id: string; name: string }[]>([]);
  const [industriesLoading, setIndustriesLoading] = useState(false);
  const [dicts, setDicts] = useState<Record<string, { id: string; name: string }[]>>({});
  const [dictsLoading, setDictsLoading] = useState(false);

  const [items, setItems] = useState<Vacancy[] | null>(null);
  const [found, setFound] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [trackings, setTrackings] = useState<Tracking[]>([]);
  const [activeTracking, setActiveTracking] = useState<string | null>(null);
  const [savingTracking, setSavingTracking] = useState(false);
  // id отслеживания, которое правим (null — создаём новое)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [trackingName, setTrackingName] = useState("");
  const [trackingMsg, setTrackingMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Vacancy | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const dict = (name: string): Opt[] =>
    (dicts[name] || []).map((d) => ({ id: d.id, label: d.name }));

  async function loadAreas() {
    if (areas.length || areasLoading) return;
    setAreasLoading(true);
    try {
      const tree: Area[] = await api.getAreas();
      setAreas(flattenAreas(tree).sort((a, b) => a.name.localeCompare(b.name, "ru")));
    } catch {
      // справочник не критичен: поиск работает и без него
    } finally {
      setAreasLoading(false);
    }
  }

  async function loadRoles() {
    if (roles.length || rolesLoading) return;
    setRolesLoading(true);
    try {
      const data = await api.getProfessionalRoles();
      setRoles(flattenRoles(data).sort((a, b) => a.name.localeCompare(b.name, "ru")));
    } catch {
    } finally {
      setRolesLoading(false);
    }
  }

  async function loadIndustries() {
    if (industries.length || industriesLoading) return;
    setIndustriesLoading(true);
    try {
      const tree = await api.getIndustries();
      const flat: { id: string; name: string }[] = [];
      for (const cat of tree || []) {
        if (cat.id && cat.name) flat.push({ id: cat.id, name: cat.name });
        for (const sub of cat.industries || []) {
          if (sub.id && sub.name) flat.push({ id: sub.id, name: sub.name });
        }
      }
      setIndustries(flat.sort((a, b) => a.name.localeCompare(b.name, "ru")));
    } catch {
    } finally {
      setIndustriesLoading(false);
    }
  }

  async function loadDicts() {
    if (Object.keys(dicts).length || dictsLoading) return;
    setDictsLoading(true);
    try {
      setDicts(await api.getDictionaries());
    } catch {
    } finally {
      setDictsLoading(false);
    }
  }

  async function runSearch(p: VacancySearchParams, pg: number) {
    setLoading(true);
    setErr("");
    try {
      const res = await api.searchVacancies({ ...p, page: pg, per_page: PER_PAGE });
      setItems(res.items || []);
      setFound(res.found || 0);
      setPage(res.page ?? pg);
      setPages(res.pages || 1);
    } catch (e) {
      setErr(String(e));
      setItems([]);
      setFound(0);
      setPages(1);
    } finally {
      setLoading(false);
    }
  }

  function search(p: VacancySearchParams, pg: number) {
    setOpenId(null);
    setDetail(null);
    runSearch(p, pg);
  }

  useEffect(() => {
    runSearch(EMPTY_FILTERS, 0);
    api
      .trackingsLoad()
      .then((d) => setTrackings(d.items || []))
      .catch(() => {});
    // справочники тяжёлые: грузим в фоне после первого поиска
    const t = setTimeout(() => {
      loadAreas();
      loadRoles();
      loadIndustries();
      loadDicts();
    }, 600);
    return () => clearTimeout(t);
  }, []);

  function patch(p: Partial<VacancySearchParams>) {
    const next = { ...filters, ...p };
    setFilters(next);
    // выбор фильтра сразу ищет
    if (p.text === undefined) search(next, 0);
  }

  function toggleLabel(id: string) {
    const cur = filters.label || [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    patch({ label: next });
  }

  async function applyTracking(t: Tracking) {
    const next = { ...EMPTY_FILTERS, ...t.params };
    setFilters(next);
    setActiveTracking(t.id);
    await runSearch(next, 0);
  }

  // правка: фильтры отслеживания загружаются в сайдбар — поменяли, сохранили
  function editTracking(t: Tracking) {
    setFilters({ ...EMPTY_FILTERS, ...t.params });
    setActiveTracking(t.id);
    setEditingId(t.id);
    setTrackingName(t.name);
    setSavingTracking(true);
    setTrackingMsg(null);
    runSearch({ ...EMPTY_FILTERS, ...t.params }, 0);
  }

  async function saveTracking() {
    const name = trackingName.trim();
    if (!name) {
      setTrackingMsg({ text: "Придумайте имя — например, «Frontend, удалёнка».", ok: false });
      return;
    }
    let next: Tracking[];
    if (editingId) {
      next = trackings.map((t) =>
        t.id === editingId ? { ...t, name, params: { ...filters } } : t
      );
    } else {
      // совпадение по имени — обновляем существующее, а не плодим дубли
      const existing = trackings.find((t) => t.name === name);
      next = existing
        ? trackings.map((t) => (t.name === name ? { ...t, params: { ...filters } } : t))
        : [...trackings, { id: "tr-" + Date.now(), name, params: { ...filters } }];
    }
    try {
      await api.trackingsSave(next);
      setTrackings(next);
      setTrackingName("");
      setSavingTracking(false);
      setActiveTracking(editingId || trackings.find((t) => t.name === name)?.id || null);
      setEditingId(null);
      setTrackingMsg({
        text: editingId
          ? `Отслеживание «${name}» обновлено.`
          : `Отслеживание «${name}» сохранено.`,
        ok: true,
      });
    } catch (e) {
      setTrackingMsg({ text: String(e), ok: false });
    }
  }

  // сброс к «просто все вакансии»: можно начинать новый отбор с нуля
  function resetFilters() {
    setFilters({ ...EMPTY_FILTERS });
    setActiveTracking(null);
    setSavingTracking(false);
    setEditingId(null);
    setTrackingName("");
    setTrackingMsg(null);
    search({ ...EMPTY_FILTERS }, 0);
  }

  async function deleteTracking(id: string) {
    const next = trackings.filter((t) => t.id !== id);
    try {
      await api.trackingsSave(next);
      setTrackings(next);
      if (activeTracking === id) setActiveTracking(null);
      if (editingId === id) {
        setEditingId(null);
        setSavingTracking(false);
        setTrackingName("");
      }
      setTrackingMsg(null);
    } catch (e) {
      setTrackingMsg({ text: String(e), ok: false });
    }
  }

  async function toggleDetail(v: Vacancy) {
    if (openId && openId === v.id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(v.id || null);
    setDetail(null);
    if (!v.id) return;
    setDetailLoading(true);
    try {
      setDetail(await api.getVacancy(v.id));
    } catch (e) {
      setDetail({ description: "Не удалось загрузить описание: " + String(e) });
    } finally {
      setDetailLoading(false);
    }
  }

  async function openOnHh(v: Vacancy) {
    if (!v.alternate_url) return;
    try {
      await api.openUrl(v.alternate_url);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function goToPage(pg: number) {
    setActiveTracking(null);
    await runSearch(filters, pg);
  }

  // окно номеров страниц вокруг текущей: 1 … 4 5 6 … 200
  const pageWindow: number[] = [];
  const start = Math.max(0, Math.min(page - 2, pages - 5));
  for (let i = Math.max(0, start); i <= Math.min(pages - 1, start + 4); i++) pageWindow.push(i);

  const hasFilters =
    !!filters.text || !!filters.area || !!filters.professional_role || !!filters.experience ||
    !!filters.employment_form || !!filters.schedule || !!filters.search_field ||
    !!filters.excluded_text || !!filters.industry || !!filters.work_format ||
    !!filters.working_hours || !!filters.working_time_modes ||
    !!filters.salary || !!filters.only_with_salary || !!filters.salary_frequency ||
    !!filters.education || !!filters.driver_license_types ||
    (filters.label || []).length > 0 ||
    !!filters.search_period || !!filters.order_by;

  const labelDict = dict("vacancy_label");

  return (
    <div className="vac-layout">
      <aside className="vac-sidebar">
        <div className="card">
          <div className="card-head">
            <h2>Поиск</h2>
          </div>
          <label className="vac-field">
            Поисковая фраза
            <input
              value={filters.text || ""}
              onChange={(e) => setFilters({ ...filters, text: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && search(filters, 0)}
              placeholder="Должность или слово"
            />
          </label>
          <label className="vac-field">
            Искать только
            <ModelSelect
              wide
              value={filters.search_field || ""}
              options={["", "name", "company_name", "description"]}
              label={(id) =>
                id === "name" ? "В названии вакансии"
                : id === "company_name" ? "В названии компании"
                : id === "description" ? "В описании вакансии"
                : "Везде"
              }
              onChange={(v) => patch({ search_field: v })}
            />
          </label>
          <label className="vac-field">
            Слова-исключения
            <input
              value={filters.excluded_text || ""}
              onChange={(e) => setFilters({ ...filters, excluded_text: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && search(filters, 0)}
              placeholder="Слова через пробел не искать"
            />
          </label>
          <label className="vac-field">
            Регион
            <ModelSelect
              wide
              value={filters.area || ""}
              options={["", ...areas.map((a) => a.id)]}
              label={(id) =>
                !id
                  ? areasLoading && !areas.length ? "Загрузка…" : "Все регионы"
                  : areas.find((a) => a.id === id)?.name || id
              }
              onChange={(v) => patch({ area: v })}
            />
          </label>
          <label className="vac-field">
            Специализации
            <ModelSelect
              wide
              value={filters.professional_role || ""}
              options={["", ...roles.map((r) => r.id)]}
              label={(id) =>
                !id
                  ? rolesLoading && !roles.length ? "Загрузка…" : "Любые"
                  : roles.find((r) => r.id === id)?.name || id
              }
              onChange={(v) => patch({ professional_role: v })}
            />
          </label>
          <label className="vac-field">
            Отрасль компании
            <ModelSelect
              wide
              value={filters.industry || ""}
              options={["", ...industries.map((i) => i.id)]}
              label={(id) =>
                !id
                  ? industriesLoading && !industries.length ? "Загрузка…" : "Любая"
                  : industries.find((i) => i.id === id)?.name || id
              }
              onChange={(v) => patch({ industry: v })}
            />
          </label>
          <label className="vac-field">
            Опыт работы
            <ModelSelect
              wide
              value={filters.experience || ""}
              options={EXPERIENCE.map((o) => o.id)}
              label={(id) => EXPERIENCE.find((o) => o.id === id)?.label || "Любой опыт"}
              onChange={(v) => patch({ experience: v })}
            />
          </label>
          <label className="vac-field">
            График работы
            <ModelSelect
              wide
              value={filters.schedule || ""}
              options={["", "full_day", "shift", "flexible"]}
              label={(id) =>
                id === "full_day" ? "Полный день"
                : id === "shift" ? "Сменный график"
                : id === "flexible" ? "Гибкий график"
                : "Любой график"
              }
              onChange={(v) => patch({ schedule: v })}
            />
          </label>
          <label className="vac-field">
            Формат работы
            <ModelSelect
              wide
              value={filters.work_format || ""}
              options={["", ...dict("work_format").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("work_format").length ? "Загрузка…" : "Любой")
                : dict("work_format").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ work_format: v })}
            />
          </label>
          <label className="vac-field">
            Рабочие часы в день
            <ModelSelect
              wide
              value={filters.working_hours || ""}
              options={["", ...dict("working_hours").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("working_hours").length ? "Загрузка…" : "Любые")
                : dict("working_hours").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ working_hours: v })}
            />
          </label>
          <label className="vac-field">
            Режим рабочего времени
            <ModelSelect
              wide
              value={filters.working_time_modes || ""}
              options={["", ...dict("working_time_modes").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("working_time_modes").length ? "Загрузка…" : "Любой")
                : dict("working_time_modes").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ working_time_modes: v })}
            />
          </label>
          <label className="vac-field">
            Уровень дохода от, ₽
            <input
              type="number"
              min={0}
              value={filters.salary ?? ""}
              onChange={(e) => setFilters({ ...filters, salary: e.target.value ? Number(e.target.value) : null })}
              onKeyDown={(e) => e.key === "Enter" && search(filters, 0)}
              placeholder="Не важно"
            />
          </label>
          <label className="vac-check">
            <input
              type="checkbox"
              checked={!!filters.only_with_salary}
              onChange={(e) => patch({ only_with_salary: e.target.checked })}
            />
            <span>Указан доход</span>
          </label>
          <label className="vac-field">
            Частота выплат
            <ModelSelect
              wide
              value={filters.salary_frequency || ""}
              options={["", ...dict("salary_range_frequency").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("salary_range_frequency").length ? "Загрузка…" : "Любая")
                : dict("salary_range_frequency").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ salary_frequency: v })}
            />
          </label>
          <label className="vac-field">
            Тип занятости
            <ModelSelect
              wide
              value={filters.employment_form || ""}
              options={["", ...dict("vacancy_search_employment_form").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("vacancy_search_employment_form").length ? "Загрузка…" : "Любая")
                : dict("vacancy_search_employment_form").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ employment_form: v })}
            />
          </label>
          <label className="vac-field">
            Образование
            <ModelSelect
              wide
              value={filters.education || ""}
              options={EDUCATION.map((o) => o.id)}
              label={(id) => EDUCATION.find((o) => o.id === id)?.label || "Любое"}
              onChange={(v) => patch({ education: v })}
            />
          </label>
          <label className="vac-field">
            Категория прав
            <ModelSelect
              wide
              value={filters.driver_license_types || ""}
              options={["", ...dict("driver_license_types").map((o) => o.id)]}
              label={(id) =>
                !id ? (dictsLoading && !dict("driver_license_types").length ? "Загрузка…" : "Не важно")
                : dict("driver_license_types").find((o) => o.id === id)?.label || id
              }
              onChange={(v) => patch({ driver_license_types: v })}
            />
          </label>
          <label className="vac-field">
            Размещено
            <ModelSelect
              wide
              value={filters.search_period ? String(filters.search_period) : ""}
              options={PERIOD.map((o) => o.id)}
              label={(id) => PERIOD.find((o) => o.id === id)?.label || "За всё время"}
              onChange={(v) => patch({ search_period: v ? Number(v) : null })}
            />
          </label>
          <label className="vac-field">
            Сортировка
            <ModelSelect
              wide
              value={filters.order_by || ""}
              options={ORDER_BY.map((o) => o.id)}
              label={(id) => ORDER_BY.find((o) => o.id === id)?.label || "По релевантности"}
              onChange={(v) => patch({ order_by: v })}
            />
          </label>
          {labelDict.length > 0 && (
            <div className="vac-labels">
              <span className="vac-group-title">Особые условия</span>
              {labelDict
                .filter((l) => LABEL_WHITELIST.includes(l.id))
                .map((l) => (
                  <label className="vac-check" key={l.id}>
                    <input
                      type="checkbox"
                      checked={(filters.label || []).includes(l.id)}
                      onChange={() => toggleLabel(l.id)}
                    />
                    <span>{l.label}</span>
                  </label>
                ))}
            </div>
          )}
          <button className="btn-primary vac-apply-btn" onClick={() => search(filters, 0)} disabled={loading}>
            {loading ? "Ищем…" : "Найти"}
          </button>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Отслеживания</h2>
          </div>
          <p className="hint">
            Сохранённые фильтры одним нажатием. Настройте фильтры слева и сохраните,
            попросите агента в чате — или нажмите правку на чипе, чтобы изменить
            готовое отслеживание.
          </p>
          <div className="vac-trackings-row">
            {trackings.map((t) => (
              <span key={t.id} className={"tracking-chip" + (activeTracking === t.id ? " active" : "")}>
                <button className="tracking-open" onClick={() => applyTracking(t)}>{t.name}</button>
                <button
                  className="tracking-edit"
                  onClick={() => editTracking(t)}
                  title="Изменить имя и фильтры этого отслеживания"
                >
                  {"\u270E\uFE0E"}
                </button>
                <button className="tracking-del" onClick={() => deleteTracking(t.id)} title="Удалить">×</button>
              </span>
            ))}
          </div>
          {trackings.length === 0 && !savingTracking && (
            <p className="hint">Пока отслеживаний нет.</p>
          )}
          {savingTracking ? (
            <div className="tracking-save">
              {editingId && (
                <p className="hint">
                  Меняем «{trackings.find((t) => t.id === editingId)?.name}»:
                  поправьте фильтры слева и сохраните.
                </p>
              )}
              <input
                autoFocus
                value={trackingName}
                onChange={(e) => setTrackingName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveTracking()}
                placeholder="Имя, например «Frontend, удалёнка»"
              />
              <div className="row gap">
                <button className="btn-primary small" onClick={saveTracking}>
                  {editingId ? "Сохранить изменения" : "Сохранить"}
                </button>
                <button
                  className="ghost-btn small"
                  onClick={() => { setSavingTracking(false); setEditingId(null); setTrackingName(""); }}
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <div className="tracking-buttons">
              <button
                className="ghost-btn small"
                onClick={() => { setSavingTracking(true); setTrackingMsg(null); }}
                title="Текущие фильтры слева будут сохранены как отслеживание"
              >
                + Сохранить фильтры как отслеживание
              </button>
              <button className="ghost-btn small" onClick={resetFilters} title="Сбросить все фильтры и показать все вакансии">
                Очистить фильтры
              </button>
            </div>
          )}
          {trackingMsg && <p className={"status " + (trackingMsg.ok ? "ok" : "err")}>{trackingMsg.text}</p>}
        </div>
      </aside>

      <section className="vac-results">
        <div className="vac-results-head">
          <h2>
            {loading
              ? "Ищем…"
              : found > 0
                ? `Найдено ${found.toLocaleString("ru-RU")} ${vacanciesWord(found)}`
                : items && items.length === 0 ? "Ничего не нашлось" : "Вакансии"}
          </h2>
        </div>
        {err && <p className="status err">{err}</p>}
        {loading && <div className="vac-skeletons">{Array.from({ length: 4 }, (_, i) => <div className="vac-skeleton" key={i} />)}</div>}
        {!loading && items && items.length === 0 && !err && (
          <p className="vac-empty">Попробуйте ослабить фильтры или изменить запрос.</p>
        )}
        {!loading &&
          (items || []).map((v) => (
            <div
              className={"vac-item" + (openId === v.id ? " open" : "")}
              key={v.id}
              onClick={() => toggleDetail(v)}
            >
              <div className="vac-item-row">
                <div className="vac-item-main">
                  <div className="vac-title">{v.name}</div>
                  <div className="vac-meta">
                    {[v.employer?.name, v.area?.name, v.schedule?.name].filter(Boolean).join(" · ")}
                  </div>
                  {v.snippet?.requirement && (
                    <div className="vac-snippet">{stripHtml(v.snippet.requirement)}</div>
                  )}
                </div>
                <div className="vac-item-side">
                  {salaryText(v) && <div className="vac-salary">{salaryText(v)}</div>}
                  <div className="vac-published">{(v.published_at || "").slice(0, 10)}</div>
                  <div className="vac-actions">
                    <button
                      className={"ghost-btn small" + (openId === v.id ? " active" : "")}
                      onClick={(e) => { e.stopPropagation(); toggleDetail(v); }}
                    >
                      {openId === v.id ? "Скрыть описание" : "Описание"}
                    </button>
                    {v.alternate_url && (
                      <button
                        className="ghost-btn small"
                        onClick={(e) => { e.stopPropagation(); openOnHh(v); }}
                      >
                        На hh.ru
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {openId === v.id && (
                <div className="vac-detail" onClick={(e) => e.stopPropagation()}>
                  {detailLoading && <p className="vac-detail-loading">Загружаем описание…</p>}
                  {!detailLoading && detail && (
                    <>
                      {detail.key_skills && detail.key_skills.length > 0 && (
                        <div className="vac-skills">
                          {detail.key_skills.map((s, i) => <span className="vac-skill" key={i}>{s.name}</span>)}
                        </div>
                      )}
                      {detail.experience?.name && <p className="vac-meta">Опыт: {detail.experience.name}</p>}
                      <div className="vac-description">{stripHtml(detail.description || "Описание не указано.")}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        {!loading && pages > 1 && (
          <div className="vac-pagination">
            <button className="vac-page-btn" disabled={page <= 0} onClick={() => goToPage(page - 1)}>‹</button>
            {start > 0 && (
              <>
                <button className="vac-page-btn" onClick={() => goToPage(0)}>1</button>
                {start > 1 && <span className="vac-page-dots">…</span>}
              </>
            )}
            {pageWindow.map((p) => (
              <button
                key={p}
                className={"vac-page-btn" + (p === page ? " current" : "")}
                onClick={() => p !== page && goToPage(p)}
              >
                {p + 1}
              </button>
            ))}
            {start + 5 < pages && (
              <>
                <span className="vac-page-dots">…</span>
                <button className="vac-page-btn" onClick={() => goToPage(pages - 1)}>{pages}</button>
              </>
            )}
            <button className="vac-page-btn" disabled={page >= pages - 1} onClick={() => goToPage(page + 1)}>›</button>
          </div>
        )}
      </section>
    </div>
  );
}
