// Демо-режим для предпросмотра интерфейса без Tauri (?demo в адресе)
// демо-режим для предпросмотра интерфейса без Tauri (?demo в адресе)
export const isDemo = typeof location !== "undefined" && location.search.includes("demo");
const demo = isDemo;

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
  profile_load: {
    contacts: { full_name: "Иван Иванов", city: "Москва" },
    positions: {
      desired_title: "Senior frontend-разработчик",
      area: "Москва",
      salary: "350000",
      employment: ["full"],
      schedule: ["remote", "flexible"],
    },
    experience: [
      {
        company: "ООО «Технологии»",
        position: "Senior frontend-разработчик",
        period: "2021 — сейчас",
        description: "B2B-платформа: архитектура фронтенда, менторство команды.",
        achievements: "Сократил время загрузки интерфейса в 3 раза.",
      },
    ],
    education: [{ institution: "МГТУ им. Баумана", specialty: "Прикладная математика", period: "2013 — 2017" }],
    skills: ["React", "TypeScript", "Node.js"],
    projects: [],
    about: "Веду проекты от архитектуры до релиза, люблю чистый код и понятные интерфейсы.",
    notes: [
      { topic: "здоровье", text: "Дистанционная работа важна из-за аллергии на пыль в офисах.", added_at: 1 },
      { topic: "семья", text: "Двое детей, важен график с возможностью забирать из школы.", added_at: 2 },
    ],
  },
  agent_test: { models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "o3-mini"] },
  search_vacancies: (() => {
    const titles = ["Senior frontend-разработчик", "Frontend-разработчик (React)", "React / TypeScript разработчик", "Ведущий frontend-разработчик", "Frontend-разработчик (Vue)", "Fullstack-разработчик", "Frontend-разработчик (Junior+)", "Web-разработчик", "Frontend-разработчик в продуктовую команду", "Разработчик интерфейсов"];
    const employers = ["ООО «Технологии»", "Аксиома", "Яндекс", "Сбер", "Т-Банк", "Авито", "Ozon", "VK"];
    const areas = ["Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург"];
    const sched = ["Удалённая работа", "Гибкий график", "Полный день", "Гибрид"];
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: "vac-" + i, name: titles[i % titles.length], alternate_url: "https://hh.ru/vacancy/" + (i + 1),
      published_at: "2026-10-0" + ((i % 6) + 1) + "T10:00:00",
      salary: i % 3 === 0 ? { from: 150000 + i * 20000, to: 250000 + i * 20000, currency: "RUR" } : i % 3 === 1 ? { from: 180000, to: null, currency: "RUR" } : null,
      employer: { name: employers[i % employers.length] }, area: { name: areas[i % areas.length] },
      schedule: { name: sched[i % sched.length] },
      snippet: { requirement: "Уверенное знание React и TypeScript, опыт продуктовой разработки от двух лет" },
    }));
    return { found: 127, page: 0, pages: 13, items };
  })(),
  get_areas: [
    { id: "1", name: "Москва" },
    { id: "2", name: "Санкт-Петербург" },
  ],
  get_professional_roles: [
    {
      id: "1", name: "Информационные технологии",
      roles: [
        { id: "156", name: "Разработчик" },
        { id: "258", name: "Аналитик" },
        { id: "96", name: "Тестировщик" },
      ],
    },
    {
      id: "4", name: "Продажи",
      roles: [{ id: "107", name: "Менеджер по продажам" }],
    },
  ],
  get_dictionaries: {
    work_format: [
      { id: "ON_SITE", name: "На месте работодателя" },
      { id: "REMOTE", name: "Удалённо" },
      { id: "HYBRID", name: "Гибрид" },
      { id: "FIELD_WORK", name: "Разъездной" },
    ],
    working_hours: [{ id: "HOURS_4", name: "4 часа в день" }],
    working_time_modes: [{ id: "start_after_sixteen", name: "Можно начинать после 16:00" }],
    vacancy_label: [
      { id: "with_address", name: "С адресом" },
      { id: "not_from_agency", name: "Без вакансий от кадровых агентств" },
      { id: "low_performance", name: "Меньше 10 откликов" },
      { id: "accredited_it", name: "От аккредитованных ИТ-компаний" },
      { id: "accept_teens", name: "Доступные с 16 лет" },
      { id: "accept_kids", name: "Доступные с 14 лет" },
      { id: "accept_handicapped", name: "Доступные для людей с инвалидностью" },
    ],
    salary_range_frequency: [{ id: "MONTHLY", name: "Раз в месяц" }],
    vacancy_search_employment_form: [
      { id: "FULL", name: "Полная занятость" },
      { id: "PART", name: "Частичная занятость" },
      { id: "PROJECT", name: "Подработка" },
      { id: "FLY_IN_FLY_OUT", name: "Вахта" },
    ],
    driver_license_types: [
      { id: "A", name: "A" }, { id: "B", name: "B" }, { id: "C", name: "C" }, { id: "D", name: "D" },
    ],
  },
  get_industries: [
    {
      id: "7", name: "ИТ, телеком",
      industries: [{ id: "7.540", name: "ИТ-компания" }],
    },
    {
      id: "35", name: "Банки, финансы",
      industries: [{ id: "35.270", name: "Банк" }],
    },
  ],
  get_vacancy: {
    id: "vac-1", name: "Senior frontend-разработчик",
    experience: { name: "От 3 до 6 лет" },
    key_skills: [{ name: "React" }, { name: "TypeScript" }, { name: "CSS" }],
    description: "<p>Разрабатываем B2B-платформу. Ищем сильного фронтендера.</p><p><b>Что делать:</b></p><ul><li>архитектура фронтенда</li><li>код-ревью и менторство</li></ul>",
  },
  trackings_load: {
    items: [
      { id: "tr-1", name: "Frontend, удалёнка", created_at: 1, params: { text: "frontend", schedule: "remote" } },
    ],
  },
  agents_save: null,
  set_job_search_status: null,
  profile_save: null,
  web_action: null,
  chats_list: [],
  chat_get: [],
  chats_clear: null,
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
  // hh.ru у скрытого резюме отдаёт status «опубликовано» — реальная
  // видимость живёт здесь: access.type.id === "no_one" значит снято с показа
  access?: { type?: { id?: string; name?: string } };
  updated_at?: string;
  views?: number;
  new_messages?: number;
}

export function resumeHidden(r: Resume): boolean {
  return r.access?.type?.id === "no_one" || r.status?.id === "not_published";
}

// Локальный профиль пользователя — то, что агент знает о человеке и что
// идёт в резюме. Хранится в приложении, пополняется и разговором с агентом,
// и правкой вручную.
export interface ProfileData {
  contacts?: { full_name?: string; phone?: string; email?: string; city?: string; links?: string };
  positions?: {
    desired_title?: string;
    area?: string;
    salary?: string;
    employment?: string[];
    schedule?: string[];
    search_status?: string;
  };
  experience?: { company?: string; position?: string; city?: string; period?: string; description?: string; achievements?: string }[];
  education?: { institution?: string; specialty?: string; level?: string; year?: string; period?: string }[];
  languages?: string[];
  skills?: string[];
  projects?: { name?: string; role?: string; description?: string }[];
  wishes?: string;
  about?: string;
  notes?: { topic?: string | null; text: string; added_at?: number }[];
}

export interface AgentConfig {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  // лимит запросов к провайдеру в минуту; 0 — без лимита
  rate_limit?: number;
  // модели, скрытые из списков
  ignored_models?: string[];
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

// ---------------------------------------------------------------- вакансии hh.ru

// Параметры поиска /vacancies — тот же набор, что у инструмента агента
export interface VacancySearchParams {
  text?: string;
  search_field?: string;
  excluded_text?: string;
  area?: string;
  professional_role?: string;
  industry?: string;
  experience?: string;
  employment?: string;
  employment_form?: string;
  schedule?: string;
  work_format?: string;
  working_hours?: string;
  working_time_modes?: string;
  salary?: number | null;
  only_with_salary?: boolean;
  salary_frequency?: string;
  education?: string;
  driver_license_types?: string;
  label?: string[];
  search_period?: number | null;
  order_by?: string;
  page?: number;
  per_page?: number;
}

export interface Vacancy {
  id?: string;
  name?: string;
  alternate_url?: string;
  published_at?: string;
  salary?: { from?: number | null; to?: number | null; currency?: string } | null;
  employer?: { name?: string; logo_urls?: Record<string, string> | null };
  area?: { name?: string };
  snippet?: { requirement?: string; responsibility?: string };
  schedule?: { name?: string };
  employment?: { name?: string };
  experience?: { name?: string };
  // приходит только в деталях вакансии (get_vacancy)
  description?: string;
  key_skills?: { name?: string }[];
}

export interface VacancySearchResult {
  found?: number;
  page?: number;
  pages?: number;
  items?: Vacancy[];
}

// Отслеживание — сохранённые фильтры поиска с понятным именем
export interface Tracking {
  id: string;
  name: string;
  created_at?: number;
  params: VacancySearchParams;
}

export interface Area {
  id?: string;
  name?: string;
  areas?: Area[];
}

// Плоский список регионов из дерева hh.ru — для выпадающего списка
export function flattenAreas(list: Area[], depth = 0): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const a of list || []) {
    if (a.id && a.name) out.push({ id: a.id, name: a.name });
    if (a.areas?.length) out.push(...flattenAreas(a.areas, depth + 1));
  }
  return out;
}

// Специализации hh.ru: справочник приходит группами категорий
export interface RoleCategory {
  id?: string;
  name?: string;
  roles?: { id?: string; name?: string }[];
}

// hh.ru отдаёт справочник объектом { categories: [...] } — принимаем оба варианта
export function flattenRoles(data: RoleCategory[] | { categories?: RoleCategory[] }): { id: string; name: string }[] {
  const list = Array.isArray(data) ? data : data?.categories || [];
  const out: { id: string; name: string }[] = [];
  for (const c of list) {
    for (const r of c.roles || []) {
      if (r.id && r.name) out.push({ id: r.id, name: r.name });
    }
  }
  return out;
}

// Отрасли компаний hh.ru: дерево «категория → отрасли»
export interface IndustryCategory {
  id?: string;
  name?: string;
  industries?: { id?: string; name?: string }[];
}

// Словарь, приходящий из /dictionaries — имя справочника → список пунктов
export type Dictionary = Record<string, { id: string; name: string }[]>;

// ---------------------------------------------------------------- модели всех провайдеров

// Запись в общем списке моделей: модель + провайдер, у которого её брать
export interface ModelEntry {
  model: string;        // имя модели для API
  provider: number;     // индекс провайдера в store.providers
  providerName: string;
  value: string;        // ключ селектора: "provider::model"
}

export function modelValue(provider: number, model: string): string {
  return provider + "::" + model;
}

export function parseModelValue(v: string): { provider: number | null; model: string } {
  const i = v.indexOf("::");
  if (i > -1) return { provider: Number(v.slice(0, i)), model: v.slice(i + 2) };
  return { provider: null, model: v };
}

// Список моделей со всех провайдеров; игнорируемые модели вычтены,
// при недоступности одного провайдера остальные всё равно попадают в список
export async function loadAllModels(store: AgentStore): Promise<ModelEntry[]> {
  const lists = await Promise.all(
    store.providers.map(async (p, i): Promise<ModelEntry[]> => {
      try {
        const res = await api.agentTest(p);
        const name = p.name || p.base_url;
        const ignored = p.ignored_models || [];
        return (res.models || [])
          .filter((m) => !ignored.includes(m))
          .map((m) => ({
          model: m,
          provider: i,
          providerName: name,
          value: modelValue(i, m),
        }));
      } catch {
        return [];
      }
    })
  );
  return lists.flat();
}

// ---------------------------------------------------------------- чаты с работодателями hh.ru
//
// Работаем через стабильный API переписок /negotiations (у токена
// мобильного клиента нет scope на новый Chats API /common/chats).

export interface HhChatLastMessage {
  id: string;
  creation_time: string;
  sender_participant_id: string;
  sender_display_info: {
    name: string;
    is_current_participant: boolean;
    icon: string | null;
    role: "APPLICANT" | "EMPLOYER" | "BOT" | null;
  };
  payload: { text: string | null; attachments?: { url: string; title: string; content_type: string; preview?: { url?: string } | null }[] | null };
  viewed_by_opponent?: boolean;
}

export interface HhChat {
  id: string;
  type: "NEGOTIATION";
  display: { title: string; icon: string | null };
  creation_time: string;
  updated_at?: string;
  unread_message_count: number;
  muted: boolean;
  state_name?: string | null;
  messaging_status?: string | null;
  vacancy_id?: string | null;
  vacancy_name?: string | null;
  vacancy_url?: string | null;
  last_message?: HhChatLastMessage | null;
}

export interface HhChatsResponse {
  items?: HhChat[];
  found?: number;
  page?: number;
  pages?: number;
  per_page?: number;
}

export interface HhChatMessage extends HhChatLastMessage {
  can_edit?: boolean;
}

export interface HhChatMessagesResponse {
  id: string;
  display: { title: string; icon: string | null };
  messages: HhChatMessage[];
  has_more: boolean;
  page?: number;
  pages?: number;
}

export function hhMessageText(m: HhChatLastMessage): string {
  const t = m.payload?.text;
  if (t) return t;
  const a = m.payload?.attachments;
  if (a && a.length) return a.map((f) => f.title).join(", ");
  return "";
}

// демо-данные чатов: живой сценарий, отправка работает
export const demoHhChats: HhChatsResponse & { items: HhChat[] } = {
  found: 4,
  page: 0,
  pages: 1,
  per_page: 20,
  items: [
    {
      id: "chat-1", type: "NEGOTIATION", unread_message_count: 0, muted: false,
      display: { title: "ООО «Технологии»", icon: null },
      state_name: "Отклик", messaging_status: "active",
      creation_time: "2026-10-03T10:00:00+0300", updated_at: "2026-10-06T14:32:00+0300",
      vacancy_id: "vac-1", vacancy_name: "Senior frontend-разработчик",
      vacancy_url: "https://hh.ru/vacancy/vac-1",
      last_message: {
        id: "m-7", creation_time: "2026-10-06T14:32:00+0300", sender_participant_id: "me",
        sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" },
        payload: { text: "Спасибо! Готов подойти на встречу в четверг в 15:00." }, viewed_by_opponent: true,
      },
    },
    {
      id: "chat-2", type: "NEGOTIATION", unread_message_count: 2, muted: false,
      display: { title: "Яндекс", icon: null },
      state_name: "Приглашение", messaging_status: "active",
      creation_time: "2026-10-02T12:00:00+0300", updated_at: "2026-10-07T09:15:00+0300",
      vacancy_id: "vac-2", vacancy_name: "Frontend-разработчик (React)",
      vacancy_url: "https://hh.ru/vacancy/vac-2",
      last_message: {
        id: "m-9", creation_time: "2026-10-07T09:15:00+0300", sender_participant_id: "emp-2",
        sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" },
        payload: { text: "Добрый день, Иван! Рассмотрели ваш отклик — хотим пригласить на онлайн-встречу. Когда вам удобно на этой неделе?" }, viewed_by_opponent: false,
      },
    },
    {
      id: "chat-3", type: "NEGOTIATION", unread_message_count: 1, muted: false,
      display: { title: "Сбер", icon: null },
      state_name: "Отклик", messaging_status: "active",
      creation_time: "2026-09-28T09:00:00+0300", updated_at: "2026-10-05T18:40:00+0300",
      vacancy_id: "vac-3", vacancy_name: "Ведущий frontend-разработчик",
      vacancy_url: "https://hh.ru/vacancy/vac-3",
      last_message: {
        id: "m-12", creation_time: "2026-10-05T18:40:00+0300", sender_participant_id: "emp-3",
        sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" },
        payload: { text: "Прикрепил тестовое задание.", attachments: [{ url: "https://api.hh.ru/files/demo-task.pdf", title: "Тестовое задание.pdf", content_type: "application/pdf", preview: null }] },
      },
    },
    {
      id: "chat-4", type: "NEGOTIATION", unread_message_count: 0, muted: false,
      display: { title: "Аксиома", icon: null },
      state_name: "Отклик", messaging_status: "archived",
      creation_time: "2026-09-20T16:00:00+0300", updated_at: "2026-09-24T11:20:00+0300",
      vacancy_id: "vac-4", vacancy_name: "Fullstack-разработчик",
      vacancy_url: "https://hh.ru/vacancy/vac-4",
      last_message: {
        id: "m-3", creation_time: "2026-09-24T11:20:00+0300", sender_participant_id: "me",
        sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" },
        payload: { text: "Здравствуйте! Откликнулся на вашу вакансию — буду рад обсудить." }, viewed_by_opponent: true,
      },
    },
  ],
};

// сообщения демо-чатов; отправка добавляет сообщение и ответ работодателя
const demoHhMessages: Record<string, HhChatMessage[]> = {
  "chat-1": [
    { id: "m-1", creation_time: "2026-10-03T10:05:00+0300", sender_participant_id: "emp-1", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Иван, здравствуйте! Посмотрели ваше резюме — очень заинтересовало. Можете рассказать подробнее про опыт с B2B-платформами?" } },
    { id: "m-2", creation_time: "2026-10-03T13:40:00+0300", sender_participant_id: "me", sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" }, payload: { text: "Здравствуйте, Анна! Три года разрабатывал B2B-платформу на React/TypeScript: архитектура фронтенда, командная работа, ревью. Сократил время загрузки интерфейса в 3 раза." } },
    { id: "m-4", creation_time: "2026-10-06T10:12:00+0300", sender_participant_id: "emp-1", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Отлично! Предлагаем встретиться в офисе на Кутузовском. Подойдёте в четверг в 15:00?" } },
    { id: "m-7", creation_time: "2026-10-06T14:32:00+0300", sender_participant_id: "me", sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" }, payload: { text: "Спасибо! Готов подойти на встречу в четверг в 15:00." }, viewed_by_opponent: true },
  ],
  "chat-2": [
    { id: "m-8", creation_time: "2026-10-06T17:00:00+0300", sender_participant_id: "me", sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" }, payload: { text: "Добрый день! Откликнулся на вакансию frontend-разработчика, буду рад обсудить." } },
    { id: "m-9", creation_time: "2026-10-07T09:15:00+0300", sender_participant_id: "emp-2", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Добрый день, Иван! Рассмотрели ваш отклик — хотим пригласить на онлайн-встречу. Когда вам удобно на этой неделе?" } },
  ],
  "chat-3": [
    { id: "m-10", creation_time: "2026-10-05T15:00:00+0300", sender_participant_id: "emp-3", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Привет! Скинь, пожалуйста, пример кода, которым гордишься." } },
    { id: "m-11", creation_time: "2026-10-05T16:05:00+0300", sender_participant_id: "me", sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" }, payload: { text: "Отправил ссылку на pet-проект в профиле." } },
    { id: "m-12", creation_time: "2026-10-05T18:40:00+0300", sender_participant_id: "emp-3", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Посмотрел — аккуратно. Прикрепил тестовое задание.", attachments: [{ url: "https://api.hh.ru/files/demo-task.pdf", title: "Тестовое задание.pdf", content_type: "application/pdf", preview: null }] } },
  ],
  "chat-4": [
    { id: "m-2", creation_time: "2026-09-21T10:00:00+0300", sender_participant_id: "emp-4", sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" }, payload: { text: "Здравствуйте! А вы готовы к гибридному формату в Москве?" } },
    { id: "m-3", creation_time: "2026-09-24T11:20:00+0300", sender_participant_id: "me", sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" }, payload: { text: "Думаю над этим, пока ориентируюсь на удалёнку." }, viewed_by_opponent: true },
  ],
};

function demoHhChatSend(chatId: string, text: string) {
  const list = (demoHhMessages[chatId] ||= []);
  list.push({
    id: "demo-" + Date.now(),
    creation_time: new Date().toISOString(),
    sender_participant_id: "me",
    sender_display_info: { name: "Вы", is_current_participant: true, icon: null, role: "APPLICANT" },
    payload: { text },
    viewed_by_opponent: false,
  });
  const chat = demoHhChats.items.find((c) => c.id === chatId);
  if (chat) chat.last_message = list[list.length - 1];
  // через пару секунд «работодатель отвечает», чтобы демо выглядело живым
  setTimeout(() => {
    list.push({
      id: "demo-" + Date.now() + "-reply",
      creation_time: new Date().toISOString(),
      sender_participant_id: chatId + "-emp",
      sender_display_info: { name: "", is_current_participant: false, icon: null, role: "EMPLOYER" },
      payload: { text: "Приняли, спасибо! Ответим подробнее в ближайшее время." },
    });
    if (chat) chat.last_message = list[list.length - 1];
    window.dispatchEvent(new CustomEvent("demo-hh-chat-update", { detail: chatId }));
  }, 2500);
}

// демо-версия hh_chat_messages: читает demoHhMessages со страницами по 50
function demoHhChatMessages(chatId: string, page = 0): HhChatMessagesResponse {
  const all = demoHhMessages[chatId] || [];
  const chat = demoHhChats.items.find((c) => c.id === chatId);
  const perPage = 50;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const windowed = all.slice(page * perPage, (page + 1) * perPage);
  return {
    id: chatId,
    display: { title: chat?.display.title || "", icon: null },
    messages: windowed,
    has_more: page < pages - 1,
    page,
    pages,
  };
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
  publishResume: (resumeId: string) => invoke<void>("publish_resume", { resumeId }),
  openResumeEditor: (resumeId: string) => invoke<void>("open_resume_editor", { resumeId }),
  openResumeCreator: () => invoke<void>("open_resume_creator"),
  profileLoad: () => invoke<ProfileData>("profile_load"),
  profileSave: (data: ProfileData) => invoke<void>("profile_save", { data }),  agentsLoad: () => invoke<AgentStore>("agents_load"),
  agentsSave: (store: AgentStore) => invoke<void>("agents_save", { store }),
  agentTest: (config: AgentConfig) =>
    invoke<{ models: string[] }>("agent_test", { config }),
  chatsList: () => invoke<ChatSummary[]>("chats_list"),
  chatGet: (chatId: string) => invoke<StoredChatMsg[]>("chat_get", { chatId }),
  chatDelete: (chatId: string) => invoke<void>("chat_delete", { chatId }),
  chatsClear: () => invoke<void>("chats_clear"),
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
  searchVacancies: (params?: VacancySearchParams) =>
    invoke<VacancySearchResult>("search_vacancies", { params: params ?? {} }),
  getVacancy: (id: string) => invoke<Vacancy>("get_vacancy", { id }),
  getAreas: () => invoke<Area[]>("get_areas"),
  getProfessionalRoles: () =>
    invoke<RoleCategory[] | { categories?: RoleCategory[] }>("get_professional_roles"),
  getDictionaries: () => invoke<Dictionary>("get_dictionaries"),
  getIndustries: () => invoke<IndustryCategory[]>("get_industries"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  trackingsLoad: () => invoke<{ items?: Tracking[] }>("trackings_load"),
  trackingsSave: (items: Tracking[]) =>
    invoke<void>("trackings_save", { data: { items } }),
  chatConfirm: (chatId: string, callId: string, decision: "allow" | "deny") =>
    invoke<void>("chat_confirm", { chatId, callId, decision }),

  // -------------------------------------------------------------- чаты с работодателями (hh.ru)
  hhChatsList: (page = 0) => {
    if (demo) return Promise.resolve(demoHhChats);
    return invoke<HhChatsResponse>("hh_chats_list", { page });
  },
  hhChatMessages: (chatId: string, page = 0) => {
    if (demo) return Promise.resolve(demoHhChatMessages(chatId, page));
    return invoke<HhChatMessagesResponse>("hh_chat_messages", { chatId, page });
  },
  hhChatSend: (chatId: string, text: string) => {
    if (demo) {
      demoHhChatSend(chatId, text);
      return Promise.resolve({ id: "demo-" + Date.now() });
    }
    return invoke<{ id: string }>("hh_chat_send", { chatId, text });
  },
  hhChatsMarkRead: (chatId: string) => {
    if (demo) {
      for (const c of demoHhChats.items) if (c.id === chatId) c.unread_message_count = 0;
      return Promise.resolve();
    }
    return invoke<void>("hh_chats_mark_read", { chatId });
  },
  hhChatsMarkAllRead: () => {
    if (demo) {
      for (const c of demoHhChats.items) c.unread_message_count = 0;
      return Promise.resolve();
    }
    return invoke<void>("hh_chats_mark_all_read");
  },
  chatStartStream: (
    chatId: string,
    message: string,
    model: string,
    provider: number | null,
    mode: AgentMode,
    onEvent: (e: ChatEvent) => void
  ) => chatStartStream(chatId, message, model, provider, mode, onEvent),
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
  parts?: { kind: "text" | "thinking" | "tool"; text?: string; name?: string; args?: Record<string, unknown>; result?: string; label?: string; status?: string; elapsed_ms?: number }[];
  error?: string;
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
  provider: number | null,
  mode: AgentMode,
  onEvent: (e: ChatEvent) => void
): Promise<void> {
  if (demo) return demoChatStart(message, onEvent);

  const channel = new Channel((msg: unknown) => onEvent(msg as ChatEvent));
  return invoke<void>("chat_start", {
    chatId,
    message,
    model,
    provider,
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
