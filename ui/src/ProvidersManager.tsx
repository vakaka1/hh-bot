import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { api, AgentConfig, AgentStore, loadAllModels, ModelEntry } from "./api";
import ModelSelect from "./ModelSelect";

interface ProvidersManagerProps {
  initialStore: AgentStore;
  onBack: () => void;
  onSaved: (store: AgentStore) => void;
}

export default function ProvidersManager({
  initialStore,
  onBack,
  onSaved,
}: ProvidersManagerProps) {
  const [store, setStore] = useState<AgentStore>(initialStore);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [showKey, setShowKey] = useState(false);
  const [deleteConfirmIdx, setDeleteConfirmIdx] = useState<number | null>(null);

  // Поиск и фильтры моделей для выбранного провайдера
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState<"all" | "active" | "hidden">("all");

  // Кэш моделей по индексу провайдера
  const [modelsCache, setModelsCache] = useState<
    Record<number, { models: string[]; loading: boolean; error: string }>
  >({});

  // Общий список моделей со всех провайдеров (для выбора основной модели агента)
  const [allModels, setAllModels] = useState<ModelEntry[]>([]);

  // Статус сохранения
  const [saveStatus, setSaveStatus] = useState<{ text: string; ok: boolean } | null>(null);

  // Синхронизация при обновлении initialStore извне
  useEffect(() => {
    setStore(initialStore);
  }, [initialStore]);

  // Загрузка всех моделей для селектора основной модели агента
  useEffect(() => {
    if (!store.providers.length) {
      setAllModels([]);
      return;
    }
    let cancelled = false;
    loadAllModels(store)
      .then((list) => !cancelled && setAllModels(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [store.providers]);

  // Проверка валидности selectedIdx
  useEffect(() => {
    if (store.providers.length === 0) {
      setSelectedIdx(0);
    } else if (selectedIdx >= store.providers.length) {
      setSelectedIdx(store.providers.length - 1);
    }
  }, [store.providers.length, selectedIdx]);

  // Сброс поиска при смене провайдера
  useEffect(() => {
    setModelSearch("");
    setModelFilter("all");
    setShowKey(false);
    setDeleteConfirmIdx(null);
  }, [selectedIdx]);

  const currentProvider: AgentConfig | undefined = store.providers[selectedIdx];
  const activeProvider =
    store.active !== null && store.active < store.providers.length
      ? store.providers[store.active]
      : null;

  async function fetchModelsFor(idx: number, cfgOverride?: AgentConfig) {
    const cfg = cfgOverride || store.providers[idx];
    if (!cfg || !cfg.base_url.trim()) return;

    setModelsCache((prev) => ({
      ...prev,
      [idx]: { models: prev[idx]?.models || [], loading: true, error: "" },
    }));

    try {
      const res = await api.agentTest(cfg);
      const list = res.models || [];
      setModelsCache((prev) => ({
        ...prev,
        [idx]: { models: list, loading: false, error: "" },
      }));

      if (!cfg.model && list.length > 0) {
        patchProvider(idx, { model: list[0] });
      }
    } catch (e) {
      setModelsCache((prev) => ({
        ...prev,
        [idx]: { models: [], loading: false, error: String(e) },
      }));
    }
  }

  useEffect(() => {
    if (
      currentProvider &&
      currentProvider.base_url.trim() &&
      !modelsCache[selectedIdx]
    ) {
      fetchModelsFor(selectedIdx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdx, currentProvider?.base_url, currentProvider?.api_key]);

  function patchProvider(i: number, patch: Partial<AgentConfig>) {
    setStore((s) => {
      const updated = s.providers.map((p, j) => (j === i ? { ...p, ...patch } : p));
      return { ...s, providers: updated };
    });
  }

  function addProvider() {
    const newProvider: AgentConfig = {
      name: "",
      base_url: "",
      api_key: "",
      model: "",
      rate_limit: 0,
      ignored_models: [],
    };
    const nextList = [...store.providers, newProvider];
    const newIdx = nextList.length - 1;
    setStore((s) => ({
      ...s,
      providers: nextList,
      active: s.active === null ? newIdx : s.active,
    }));
    setSelectedIdx(newIdx);
  }

  function deleteProvider(i: number) {
    setStore((s) => {
      const providers = s.providers.filter((_, j) => j !== i);
      let active = s.active;
      if (active === i) active = null;
      else if (active !== null && active > i) active -= 1;
      return { ...s, providers, active };
    });
    setDeleteConfirmIdx(null);
    if (selectedIdx >= store.providers.length - 1) {
      setSelectedIdx(Math.max(0, store.providers.length - 2));
    }
  }

  function setActive(i: number) {
    setStore((s) => ({ ...s, active: i }));
  }

  function setAgentModel(m: string | null) {
    setStore((s) => ({ ...s, agent_model: m }));
  }

  async function save() {
    try {
      await api.agentsSave(store);
      onSaved(store);
      setSaveStatus({ text: "Настройки сохранены", ok: true });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (e) {
      setSaveStatus({ text: "Ошибка: " + String(e), ok: false });
    }
  }

  const currentModelsState = modelsCache[selectedIdx] || {
    models: [],
    loading: false,
    error: "",
  };
  const availableModels = currentModelsState.models;
  const ignoredList = currentProvider?.ignored_models || [];

  const filteredModels = useMemo(() => {
    return availableModels.filter((m) => {
      const isIgnored = ignoredList.includes(m);
      if (modelFilter === "active" && isIgnored) return false;
      if (modelFilter === "hidden" && !isIgnored) return false;

      if (modelSearch.trim()) {
        return m.toLowerCase().includes(modelSearch.trim().toLowerCase());
      }
      return true;
    });
  }, [availableModels, ignoredList, modelFilter, modelSearch]);

  const activeModelsCount = availableModels.filter((m) => !ignoredList.includes(m)).length;

  function toggleModel(model: string) {
    if (!currentProvider) return;
    const isIgnored = ignoredList.includes(model);
    const nextIgnored = isIgnored
      ? ignoredList.filter((x) => x !== model)
      : [...ignoredList, model];
    patchProvider(selectedIdx, { ignored_models: nextIgnored });
  }

  function enableAllModels() {
    if (!currentProvider) return;
    patchProvider(selectedIdx, { ignored_models: [] });
  }

  function disableAllModels() {
    if (!currentProvider) return;
    const currentModel = currentProvider.model;
    const nextIgnored = availableModels.filter((m) => m !== currentModel);
    patchProvider(selectedIdx, { ignored_models: nextIgnored });
  }

  function extractHost(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url || "";
    }
  }

  const currentAgentModel = store.agent_model || activeProvider?.model || "";

  return (
    <div className="providers-page-root">
      {/* Шапка страницы моделей */}
      <div className="providers-page-header">
        <div className="header-left-group">
          <button type="button" className="link-btn back-btn" onClick={onBack}>
            ← Настройки
          </button>
          <h2>Модели и провайдеры</h2>
        </div>
        <div className="header-right-group">
          {saveStatus && (
            <span className={"save-status-text " + (saveStatus.ok ? "ok" : "err")}>
              {saveStatus.text}
            </span>
          )}
          <button type="button" className="btn-primary" onClick={save}>
            Сохранить
          </button>
        </div>
      </div>

      {/* Блок активной модели агента — без маркеров */}
      <div className="card active-agent-model-card">
        <div className="aam-row">
          <div className="aam-info">
            <span className="aam-title">Основная модель агента</span>
            <span className="aam-desc">
              Используется по умолчанию в чатах и при анализе вакансий.
            </span>
          </div>
          <div className="aam-select-wrap">
            {allModels.length > 0 ? (
              <ModelSelect
                value={currentAgentModel}
                options={allModels.map((e) => e.model)}
                onChange={(m) => setAgentModel(m || null)}
                label={(m) => {
                  const entry = allModels.find((e) => e.model === m);
                  return entry ? `${entry.providerName}: ${m}` : m;
                }}
                wide
              />
            ) : (
              <input
                value={currentAgentModel}
                onChange={(e) => setAgentModel(e.target.value || null)}
                placeholder="Например, gpt-4o-mini"
              />
            )}
          </div>
        </div>
      </div>

      {/* Двухколоночный интерфейс: левая и правая части прокручиваются независимо */}
      <div className="providers-panes-container">
        {/* Левая колонка: список провайдеров */}
        <div className="providers-left-pane">
          <div className="pane-header">
            <span className="pane-title">Список провайдеров</span>
            <button
              type="button"
              className="ghost-btn small"
              onClick={addProvider}
              title="Добавить провайдера"
            >
              <Plus size={13} />
              <span>Добавить</span>
            </button>
          </div>

          <div className="providers-items-list">
            {store.providers.length === 0 ? (
              <div className="empty-pane-msg">Нет провайдеров</div>
            ) : (
              store.providers.map((p, i) => {
                const isSelected = selectedIdx === i;
                const isActive = store.active === i;

                return (
                  <div
                    key={i}
                    className={
                      "p-item-row" +
                      (isSelected ? " selected" : "") +
                      (isActive ? " active" : "")
                    }
                    onClick={() => setSelectedIdx(i)}
                  >
                    <label
                      className="p-radio-label"
                      onClick={(e) => e.stopPropagation()}
                      title={isActive ? "Активный провайдер" : "Сделать активным"}
                    >
                      <input
                        type="radio"
                        name="active-provider-list"
                        checked={isActive}
                        onChange={() => setActive(i)}
                      />
                    </label>

                    <div className="p-item-content">
                      <div className="p-item-name">
                        {p.name.trim() || "Без названия"}
                      </div>
                      <div className="p-item-sub">
                        {extractHost(p.base_url) || p.base_url || "URL не указан"}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Правая колонка: настройки выбранного провайдера */}
        <div className="providers-right-pane">
          {currentProvider ? (
            <div className="provider-form">
              {/* Верхняя строка формы: название, активность, удаление */}
              <div className="form-top-row">
                <input
                  className="provider-name-input"
                  value={currentProvider.name}
                  onChange={(e) => patchProvider(selectedIdx, { name: e.target.value })}
                  placeholder="Название провайдера"
                />

                <div className="form-top-actions">
                  {store.active !== selectedIdx ? (
                    <button
                      type="button"
                      className="ghost-btn small"
                      onClick={() => setActive(selectedIdx)}
                    >
                      Сделать активным
                    </button>
                  ) : (
                    <span className="active-text-label">Активный</span>
                  )}

                  {deleteConfirmIdx === selectedIdx ? (
                    <div className="delete-confirm">
                      <span>Удалить?</span>
                      <button
                        type="button"
                        className="danger-btn-mini"
                        onClick={() => deleteProvider(selectedIdx)}
                      >
                        Да
                      </button>
                      <button
                        type="button"
                        className="ghost-btn-mini"
                        onClick={() => setDeleteConfirmIdx(null)}
                      >
                        Нет
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ghost-btn small delete-btn"
                      onClick={() => setDeleteConfirmIdx(selectedIdx)}
                      title="Удалить"
                    >
                      <Trash2 size={13} />
                      <span>Удалить</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Поля API */}
              <div className="form-section">
                <div className="form-grid">
                  <label>
                    Base URL
                    <input
                      value={currentProvider.base_url}
                      onChange={(e) =>
                        patchProvider(selectedIdx, { base_url: e.target.value })
                      }
                      onBlur={() => fetchModelsFor(selectedIdx)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </label>

                  <label>
                    API-ключ
                    <div className="key-input-wrapper">
                      <input
                        type={showKey ? "text" : "password"}
                        value={currentProvider.api_key}
                        onChange={(e) =>
                          patchProvider(selectedIdx, { api_key: e.target.value })
                        }
                        onBlur={() => fetchModelsFor(selectedIdx)}
                        placeholder="sk-..."
                      />
                      <button
                        type="button"
                        className="toggle-key-btn"
                        onClick={() => setShowKey(!showKey)}
                      >
                        {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>
                  </label>
                </div>

                <label>
                  Лимит запросов в минуту (RPM)
                  <input
                    type="number"
                    min={0}
                    value={currentProvider.rate_limit || 0}
                    onChange={(e) =>
                      patchProvider(selectedIdx, {
                        rate_limit: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    placeholder="0 — без ограничения"
                  />
                </label>

                <div className="test-connection-row">
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => fetchModelsFor(selectedIdx)}
                    disabled={currentModelsState.loading || !currentProvider.base_url.trim()}
                  >
                    <RefreshCw
                      size={13}
                      className={currentModelsState.loading ? "spin" : ""}
                    />
                    <span>
                      {currentModelsState.loading
                        ? "Загружаем модели…"
                        : "Проверить соединение и загрузить модели"}
                    </span>
                  </button>

                  {currentModelsState.error ? (
                    <span className="status-note err">{currentModelsState.error}</span>
                  ) : availableModels.length > 0 ? (
                    <span className="status-note ok">
                      Доступно моделей: {availableModels.length}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Выбор основной модели этого провайдера */}
              <div className="form-section">
                <label>
                  Основная модель провайдера
                  {currentModelsState.loading ? (
                    <input value="" placeholder="Считываем модели…" disabled />
                  ) : availableModels.length > 0 ? (
                    <ModelSelect
                      value={currentProvider.model}
                      options={availableModels}
                      onChange={(m) => patchProvider(selectedIdx, { model: m })}
                      wide
                    />
                  ) : (
                    <input
                      value={currentProvider.model}
                      onChange={(e) => patchProvider(selectedIdx, { model: e.target.value })}
                      placeholder="Например, gpt-4o-mini"
                    />
                  )}
                </label>
              </div>

              {/* Управление списком моделей (показ в приложении) */}
              <div className="form-section">
                <div className="models-header-row">
                  <span className="models-header-title">
                    Показывать в списке моделей ({activeModelsCount} из {availableModels.length})
                  </span>
                  <div className="bulk-links">
                    <button type="button" className="text-action-btn" onClick={enableAllModels}>
                      Включить все
                    </button>
                    <span>·</span>
                    <button type="button" className="text-action-btn" onClick={disableAllModels}>
                      Снять все
                    </button>
                  </div>
                </div>

                {availableModels.length > 0 ? (
                  <div className="models-box-manager">
                    {/* Поиск и фильтры */}
                    <div className="models-filter-toolbar">
                      <div className="models-search-field">
                        <Search size={13} className="search-icon" />
                        <input
                          type="text"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          placeholder="Поиск по названию..."
                        />
                        {modelSearch && (
                          <button
                            type="button"
                            className="clear-search-btn"
                            onClick={() => setModelSearch("")}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>

                      <div className="models-filter-buttons">
                        <button
                          type="button"
                          className={"mf-btn" + (modelFilter === "all" ? " active" : "")}
                          onClick={() => setModelFilter("all")}
                        >
                          Все
                        </button>
                        <button
                          type="button"
                          className={"mf-btn" + (modelFilter === "active" ? " active" : "")}
                          onClick={() => setModelFilter("active")}
                        >
                          Включены
                        </button>
                        <button
                          type="button"
                          className={"mf-btn" + (modelFilter === "hidden" ? " active" : "")}
                          onClick={() => setModelFilter("hidden")}
                        >
                          Скрыты
                        </button>
                      </div>
                    </div>

                    {/* Список моделей */}
                    <div className="models-scroll-list">
                      {filteredModels.length > 0 ? (
                        filteredModels.map((m) => {
                          const isIgnored = ignoredList.includes(m);
                          const isMain = currentProvider.model === m;

                          return (
                            <div
                              key={m}
                              className={"m-row" + (isIgnored ? " ignored" : "")}
                              onClick={() => toggleModel(m)}
                            >
                              <label
                                className="m-check-wrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <input
                                  type="checkbox"
                                  checked={!isIgnored}
                                  onChange={() => toggleModel(m)}
                                />
                              </label>

                              <span className="m-name">{m}</span>

                              <div className="m-right-action" onClick={(e) => e.stopPropagation()}>
                                {isMain ? (
                                  <span className="m-main-text">(основная)</span>
                                ) : (
                                  <button
                                    type="button"
                                    className="set-main-link"
                                    onClick={() => patchProvider(selectedIdx, { model: m })}
                                  >
                                    Сделать основной
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="no-models-found">
                          {modelSearch ? "Ничего не найдено" : "Список пуст"}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="hint">
                    {currentModelsState.loading
                      ? "Загрузка списка моделей…"
                      : "Список моделей не получен. Вы можете указать основную модель вручную в поле выше."}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="empty-selection">Выберите провайдера слева</div>
          )}
        </div>
      </div>
    </div>
  );
}
