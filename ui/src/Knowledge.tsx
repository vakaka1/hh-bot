import { useEffect, useMemo, useRef, useState } from "react";
import { api, ProfileData } from "./api";
import {
  BrainCircuit,
  Calendar,
  Check,
  Copy,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";

interface KnowledgeProps {
  onNavigate?: (tab: "chat" | "vacancies" | "hhchats" | "knowledge" | "profile" | "settings") => void;
}

type NoteItem = {
  topic?: string | null;
  text: string;
  added_at?: number;
};

// Предустановленные частые категории для быстрых подсказок
const TOPIC_SUGGESTIONS = [
  "Опыт",
  "Навыки",
  "Стек",
  "Пожелания",
  "Зарплата",
  "График",
  "Условия",
  "О себе",
  "Семья",
];

// Палитра акцентных цветов тем в зависимости от названия темы
function getTopicBadgeClass(topic?: string | null): string {
  if (!topic || !topic.trim()) return "badge-topic-default";
  const t = topic.trim().toLowerCase();
  if (t.includes("опыт") || t.includes("проект") || t.includes("работа")) return "badge-topic-blue";
  if (t.includes("навык") || t.includes("стек") || t.includes("технолог") || t.includes("язык")) return "badge-topic-purple";
  if (t.includes("желани") || t.includes("зарплат") || t.includes("деньг") || t.includes("доход")) return "badge-topic-green";
  if (t.includes("график") || t.includes("услови") || t.includes("формат") || t.includes("удаленк")) return "badge-topic-amber";
  if (t.includes("семь") || t.includes("здоров") || t.includes("личн")) return "badge-topic-rose";
  return "badge-topic-cyan";
}

function formatDate(addedAt?: number): string {
  if (!addedAt) return "";
  // added_at может быть в секундах (Tauri) или миллисекундах
  const ms = addedAt < 10000000000 ? addedAt * 1000 : addedAt;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";

  const now = new Date();
  const isSameDay = d.toDateString() === now.toDateString();
  if (isSameDay) {
    return "Сегодня, " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return "Вчера, " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }

  return d.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export default function Knowledge({ onNavigate }: KnowledgeProps) {
  const [profile, setProfile] = useState<ProfileData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<string>("all");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  // Состояние создания новой заметки
  const [isCreating, setIsCreating] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newText, setNewText] = useState("");

  // Состояние редактирования отдельной плитки
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editTopic, setEditTopic] = useState("");
  const [editText, setEditText] = useState("");

  // Загрузка профиля
  useEffect(() => {
    let cancelled = false;
    api
      .profileLoad()
      .then((data) => {
        if (!cancelled) {
          setProfile(data || {});
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setSaveErr(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const notes: NoteItem[] = profile.notes || [];

  // Автосохранение при изменениях
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaving(true);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.profileSave(profileRef.current);
        setSaveErr("");
      } catch (e) {
        setSaveErr(String(e));
      } finally {
        setSaving(false);
      }
    }, 600);
  }

  function setNotes(nextNotes: NoteItem[]) {
    setProfile((prev) => ({ ...prev, notes: nextNotes }));
    scheduleSave();
  }

  // Добавление новой заметки
  function handleCreate() {
    const trimmedText = newText.trim();
    if (!trimmedText) return;

    const newNote: NoteItem = {
      topic: newTopic.trim() || null,
      text: trimmedText,
      added_at: Math.floor(Date.now() / 1000),
    };

    setNotes([newNote, ...notes]);
    setNewTopic("");
    setNewText("");
    setIsCreating(false);
  }

  // Начало редактирования
  function startEdit(index: number) {
    const note = notes[index];
    if (!note) return;
    setEditingIndex(index);
    setEditTopic(note.topic || "");
    setEditText(note.text || "");
  }

  // Сохранение изменений в плитке
  function saveEdit(index: number) {
    const trimmedText = editText.trim();
    if (!trimmedText) {
      removeNote(index);
      setEditingIndex(null);
      return;
    }

    const updated = notes.map((n, i) =>
      i === index
        ? {
            ...n,
            topic: editTopic.trim() || null,
            text: trimmedText,
          }
        : n
    );
    setNotes(updated);
    setEditingIndex(null);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditTopic("");
    setEditText("");
  }

  function removeNote(index: number) {
    setNotes(notes.filter((_, i) => i !== index));
    if (editingIndex === index) {
      setEditingIndex(null);
    }
  }

  function copyNoteText(text: string, index: number) {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedIndex(index);
    setTimeout(() => {
      setCopiedIndex(null);
    }, 1800);
  }

  // Подсчёт тем и категоризация
  const topicsSummary = useMemo(() => {
    const counts = new Map<string, number>();
    let noTopicCount = 0;

    for (const n of notes) {
      const top = (n.topic || "").trim();
      if (!top) {
        noTopicCount++;
      } else {
        counts.set(top, (counts.get(top) || 0) + 1);
      }
    }

    return {
      topics: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
      noTopicCount,
    };
  }, [notes]);

  // Фильтрация заметок
  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    return notes
      .map((note, originalIndex) => ({ note, originalIndex }))
      .filter(({ note }) => {
        // Фильтр по теме
        if (selectedTopic !== "all") {
          if (selectedTopic === "__none__") {
            if ((note.topic || "").trim() !== "") return false;
          } else {
            if ((note.topic || "").trim().toLowerCase() !== selectedTopic.toLowerCase()) {
              return false;
            }
          }
        }

        // Фильтр по поисковой строке
        if (q) {
          const matchText = (note.text || "").toLowerCase().includes(q);
          const matchTopic = (note.topic || "").toLowerCase().includes(q);
          return matchText || matchTopic;
        }

        return true;
      });
  }, [notes, selectedTopic, searchQuery]);

  return (
    <div className="knowledge-page">
      {/* Верхний заголовок и описание */}
      <div className="knowledge-hero">
        <div className="knowledge-hero-content">
          <div className="knowledge-title-row">
            <div className="knowledge-icon-wrap">
              <BrainCircuit className="knowledge-main-icon" size={24} />
            </div>
            <div>
              <div className="knowledge-title-with-badge">
                <h1>База знаний о вас</h1>
                <span className="knowledge-count-badge">
                  {notes.length} {notes.length === 1 ? "факт" : notes.length >= 2 && notes.length <= 4 ? "факта" : "фактов"}
                </span>
                {saving && <span className="knowledge-saving-badge">Сохраняем…</span>}
                {!saving && notes.length > 0 && <span className="knowledge-saved-badge">Синхронизировано</span>}
              </div>
              <p className="knowledge-subtitle">
                Агент запоминает ваши навыки, опыт, условия и пожелания во время диалогов в чате. 
                На их основе он персонализирует ответы, ищет релевантные вакансии и готовит резюме.
              </p>
            </div>
          </div>

          {/* Быстрые действия в шапке */}
          <div className="knowledge-hero-actions">
            <button
              className="btn-primary"
              onClick={() => {
                setIsCreating(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <Plus size={16} /> Добавить факт
            </button>
            {onNavigate && (
              <button
                className="ghost-btn"
                onClick={() => onNavigate("chat")}
                title="Перейти в чат с агентом"
              >
                <Sparkles size={15} /> Чат с агентом
              </button>
            )}
          </div>
        </div>
      </div>

      {saveErr && <div className="status err knowledge-banner-error">{saveErr}</div>}

      {/* Панель поиска и фильтров */}
      <div className="knowledge-toolbar">
        <div className="knowledge-search-wrapper">
          <Search className="knowledge-search-icon" size={16} />
          <input
            type="text"
            className="knowledge-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Поиск по фактам и темам..."
          />
          {searchQuery && (
            <button
              className="knowledge-search-clear"
              onClick={() => setSearchQuery("")}
              title="Очистить поиск"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Фильтры по темам */}
        <div className="knowledge-topics-bar">
          <button
            className={`topic-pill ${selectedTopic === "all" ? "active" : ""}`}
            onClick={() => setSelectedTopic("all")}
          >
            Все
            <span className="topic-pill-count">{notes.length}</span>
          </button>

          {topicsSummary.topics.map(([top, count]) => (
            <button
              key={top}
              className={`topic-pill ${selectedTopic.toLowerCase() === top.toLowerCase() ? "active" : ""}`}
              onClick={() => setSelectedTopic(top)}
            >
              {top}
              <span className="topic-pill-count">{count}</span>
            </button>
          ))}

          {topicsSummary.noTopicCount > 0 && (
            <button
              className={`topic-pill ${selectedTopic === "__none__" ? "active" : ""}`}
              onClick={() => setSelectedTopic("__none__")}
            >
              Без темы
              <span className="topic-pill-count">{topicsSummary.noTopicCount}</span>
            </button>
          )}
        </div>
      </div>

      {/* Форма создания новой плитки */}
      {isCreating && (
        <div className="knowledge-create-card">
          <div className="knowledge-create-head">
            <div className="knowledge-create-title">
              <Plus size={18} />
              <span>Новый факт о вас</span>
            </div>
            <button
              className="ghost-btn small"
              onClick={() => setIsCreating(false)}
            >
              Отмена
            </button>
          </div>

          <div className="knowledge-create-body">
            <div className="knowledge-field-group">
              <label className="knowledge-field-label">Тема / Категория (необязательно)</label>
              <input
                className="knowledge-create-topic-input"
                value={newTopic}
                onChange={(e) => setNewTopic(e.target.value)}
                placeholder="Например: Опыт, Навыки, Стек, Условия..."
              />
              <div className="knowledge-topic-suggestions">
                <span className="suggestion-label">Подсказки:</span>
                {TOPIC_SUGGESTIONS.map((sug) => (
                  <button
                    key={sug}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => setNewTopic(sug)}
                  >
                    {sug}
                  </button>
                ))}
              </div>
            </div>

            <div className="knowledge-field-group">
              <label className="knowledge-field-label">Содержание факта</label>
              <textarea
                className="knowledge-create-textarea"
                rows={3}
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Опишите факт конкретно и подробно. Например: «Более 5 лет работаю с React и TypeScript, разрабатывал дизайн-системы и микрофронтенды»..."
                autoFocus
              />
            </div>

            <div className="knowledge-create-actions">
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={!newText.trim()}
              >
                Сохранить факт
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  setIsCreating(false);
                  setNewTopic("");
                  setNewText("");
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Сетка плиток знаний */}
      {loading ? (
        <div className="knowledge-loading">
          <p className="hint">Загружаем знания о вас…</p>
        </div>
      ) : notes.length === 0 ? (
        <div className="knowledge-empty-state">
          <div className="knowledge-empty-icon-wrap">
            <Sparkles size={36} />
          </div>
          <h3>База знаний пока пуста</h3>
          <p className="knowledge-empty-desc">
            Просто общайтесь с агентом в чате: рассказывайте о своём опыте работы, стеке технологий, 
            зарплатных ожиданиях и предпочтениях — он автоматически сохранит важные факты сюда.
          </p>
          <div className="knowledge-empty-buttons">
            <button className="btn-primary" onClick={() => setIsCreating(true)}>
              <Plus size={16} /> Добавить факт вручную
            </button>
            {onNavigate && (
              <button className="ghost-btn" onClick={() => onNavigate("chat")}>
                Перейти в чат
              </button>
            )}
          </div>
        </div>
      ) : filteredNotes.length === 0 ? (
        <div className="knowledge-empty-search">
          <p>Ничего не найдено по запросу «{searchQuery}»</p>
          <button
            className="ghost-btn small"
            onClick={() => {
              setSearchQuery("");
              setSelectedTopic("all");
            }}
          >
            Сбросить фильтры
          </button>
        </div>
      ) : (
        <div className="knowledge-grid">
          {filteredNotes.map(({ note, originalIndex }) => {
            const isEditing = editingIndex === originalIndex;
            const topicClass = getTopicBadgeClass(note.topic);
            const formattedDate = formatDate(note.added_at);

            if (isEditing) {
              return (
                <div className="knowledge-tile knowledge-tile-editing" key={originalIndex}>
                  <div className="knowledge-tile-edit-head">
                    <input
                      className="knowledge-tile-edit-topic"
                      value={editTopic}
                      onChange={(e) => setEditTopic(e.target.value)}
                      placeholder="Тема факта"
                    />
                  </div>
                  <textarea
                    className="knowledge-tile-edit-text"
                    rows={4}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    placeholder="Текст факта"
                    autoFocus
                  />
                  <div className="knowledge-tile-edit-actions">
                    <button
                      className="btn-primary small"
                      onClick={() => saveEdit(originalIndex)}
                      disabled={!editText.trim()}
                    >
                      <Check size={14} /> Сохранить
                    </button>
                    <button
                      className="ghost-btn small"
                      onClick={cancelEdit}
                    >
                      <X size={14} /> Отмена
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div className="knowledge-tile" key={originalIndex}>
                <div className="knowledge-tile-top">
                  <div className="knowledge-tile-badges">
                    <span className={`knowledge-topic-badge ${topicClass}`}>
                      <Tag size={11} />
                      {note.topic?.trim() || "Без темы"}
                    </span>
                    {formattedDate && (
                      <span className="knowledge-tile-date" title="Дата сохранения">
                        <Calendar size={11} />
                        {formattedDate}
                      </span>
                    )}
                  </div>

                  <div className="knowledge-tile-menu">
                    <button
                      className="knowledge-tile-icon-btn"
                      onClick={() => copyNoteText(note.text, originalIndex)}
                      title={copiedIndex === originalIndex ? "Скопировано!" : "Скопировать текст"}
                    >
                      {copiedIndex === originalIndex ? (
                        <Check size={14} className="icon-success" />
                      ) : (
                        <Copy size={14} />
                      )}
                    </button>
                    <button
                      className="knowledge-tile-icon-btn"
                      onClick={() => startEdit(originalIndex)}
                      title="Редактировать"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="knowledge-tile-icon-btn danger"
                      onClick={() => removeNote(originalIndex)}
                      title="Удалить факт"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                <div className="knowledge-tile-content">
                  <p className="knowledge-tile-text">{note.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
