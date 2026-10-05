#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::json;
use chrono::Datelike;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const HH_AUTHORIZE_URL: &str = "https://hh.ru/oauth/authorize";
const HH_TOKEN_URL: &str = "https://hh.ru/oauth/token";
const HH_API_BASE: &str = "https://api.hh.ru";
const UA: &str = "HH-bot/0.1 (https://github.com/; desktop job-search assistant)";

// Публичные ключи официального мобильного приложения hh.ru (как в
// hh-applicant-tool): позволяют войти любому пользователю без регистрации
// собственного приложения на dev.hh.ru. Redirect идёт на спец-схему
// hhandroid:// — её перехватывает окно входа внутри приложения.
const MOBILE_CLIENT_ID: &str = "HIOMIAS39CA9DICTA7JIO64LQKQJF5AGIK74G9ITJKLNEDAOH5FHS5G1JI7FOEGD";
const MOBILE_CLIENT_SECRET: &str = "V9M870DE342BGHFRUJ5FTCGCUA1482AN0DI8C5TFI9ULMA89H10N60NOP8I4JMVS";
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------- storage

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    client_id: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct AgentConfig {
    name: String,
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct AgentStore {
    #[serde(default)]
    providers: Vec<AgentConfig>,
    #[serde(default)]
    active: Option<usize>,
    // Основная модель агента (выбирается в настройках)
    #[serde(default)]
    agent_model: Option<String>,
    // Свой SearXNG-инстанс для поиска (необязательно); пусто — публичный Brave
    #[serde(default)]
    search_url: Option<String>,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .and_then(|d| {
            std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            Ok(d)
        })
}

fn read_json<T: serde::de::DeserializeOwned>(path: PathBuf) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    let s = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

fn tokens_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("tokens.json"))
}

fn agents_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("agents.json"))
}

fn about_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("about.json"))
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

// ---------------------------------------------------------------- token exchange

async fn exchange_token(form: &HashMap<&str, String>) -> Result<Tokens, String> {
    let resp: serde_json::Value = http_client()
        .post(HH_TOKEN_URL)
        .header("User-Agent", UA)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Ошибка запроса токена: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Некорректный ответ сервера токенов: {}", e))?;

    if let Some(err) = resp["error"].as_str() {
        return Err(format!(
            "hh.ru вернул ошибку: {} ({})",
            err,
            resp["error_description"].as_str().unwrap_or("?")
        ));
    }
    Ok(Tokens {
        access_token: resp["access_token"]
            .as_str()
            .ok_or("В ответе нет access_token")?
            .to_string(),
        refresh_token: resp["refresh_token"].as_str().map(|s| s.to_string()),
        expires_at: now() + resp["expires_in"].as_i64().unwrap_or(0),
        client_id: form.get("client_id").cloned().unwrap_or_default(),
    })
}

// ---------------------------------------------------------------- quick auth (окно входа внутри приложения)

#[tauri::command]
async fn quick_auth(app: tauri::AppHandle) -> Result<(), String> {
    // если окно входа уже открыто — закрываем и начинаем заново
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.close();
    }
    // ВАЖНО: redirect_uri не передаём — hh.ru сам подставляет дефолтный
    // redirect зарегистрированного приложения (hhandroid://...), как делает
    // hh-applicant-tool. Явное значение hh.ru отвергает как некорректное.
    let authorize_url = format!(
        "{}?response_type=code&client_id={}",
        HH_AUTHORIZE_URL, MOBILE_CLIENT_ID
    );
    let url: tauri::Url = authorize_url.parse().expect("некорректный URL авторизации");

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let app_nav = app.clone();
    let builder = tauri::WebviewWindowBuilder::new(&app, "login", tauri::WebviewUrl::External(url))
        .title("Вход через hh.ru")
        .inner_size(440.0, 760.0)
        .resizable(true)
        .user_agent(MOBILE_UA)
        .on_navigation(move |nav_url| {
            let s = nav_url.as_str();
            if s.starts_with("hhandroid://") {
                let code = s
                    .split(&['?', '&'][..])
                    .find_map(|p| p.strip_prefix("code="))
                    .map(urldecode)
                    .ok_or_else(|| "в редиректе нет кода".to_string());
                let _ = tx.send(code);
                if let Some(w) = app_nav.get_webview_window("login") {
                    let _ = w.close();
                }
                return false;
            }
            true
        });
    builder.build().map_err(|e| e.to_string())?;
    // tx клонирован в замыкание; когда окно закроется, замыкание умрёт
    // и канал закроется — recv вернёт ошибку ("вход отменён").

    let code = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "Вход отменён: окно закрыто до получения кода".to_string())??;

    let mut form = HashMap::new();
    form.insert("grant_type", "authorization_code".to_string());
    form.insert("client_id", MOBILE_CLIENT_ID.to_string());
    form.insert("client_secret", MOBILE_CLIENT_SECRET.to_string());
    form.insert("code", code);

    let tokens = exchange_token(&form).await?;
    write_json(tokens_path(&app)?, &tokens)
}

async fn valid_token(app: &tauri::AppHandle) -> Result<Tokens, String> {
    let mut tokens: Tokens =
        read_json(tokens_path(app)?).ok_or("Не выполнен вход в hh.ru")?;
    if tokens.expires_at - 60 <= now() {
        tokens = refresh_tokens(&tokens).await?;
        write_json(tokens_path(app)?, &tokens)?;
    }
    Ok(tokens)
}

async fn refresh_tokens(tokens: &Tokens) -> Result<Tokens, String> {
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or("Токен истёк, refresh-токена нет — войдите заново".to_string())?;
    let mut form = HashMap::new();
    form.insert("grant_type", "refresh_token".to_string());
    form.insert("refresh_token", refresh);
    form.insert("client_id", tokens.client_id.clone());

    let resp: serde_json::Value = http_client()
        .post(HH_TOKEN_URL)
        .header("User-Agent", UA)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Ошибка обновления токена: {}", e))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if resp.get("error").is_some() {
        return Err("Не удалось обновить токен — войдите заново".into());
    }
    Ok(Tokens {
        access_token: resp["access_token"].as_str().unwrap_or_default().to_string(),
        refresh_token: resp["refresh_token"].as_str().map(|s| s.to_string()),
        expires_at: now() + resp["expires_in"].as_i64().unwrap_or(0),
        client_id: tokens.client_id.clone(),
    })
}

#[tauri::command]
async fn logout(app: tauri::AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(tokens_path(&app)?);
    Ok(())
}

#[tauri::command]
async fn auth_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let tokens: Option<Tokens> = read_json(tokens_path(&app)?);
    Ok(serde_json::json!({
        "logged_in": tokens.is_some(),
        "expires_at": tokens.as_ref().map(|t| t.expires_at),
    }))
}

// ---------------------------------------------------------------- hh api

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .build()
        .expect("reqwest client")
}

async fn hh_get(app: &tauri::AppHandle, path: &str) -> Result<serde_json::Value, String> {
    let tokens = valid_token(app).await?;
    let resp = http_client()
        .get(format!("{}{}", HH_API_BASE, path))
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка: {}", e))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let desc = body["description"].as_str().unwrap_or("неизвестная ошибка");
        return Err(format!("hh.ru API {}: {}", status, desc));
    }
    Ok(body)
}

#[tauri::command]
async fn get_me(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let me = hh_get(&app, "/me").await?;
    profile_cache().lock().expect("mutex")["me"] = me.clone();
    Ok(me)
}

#[tauri::command]
async fn get_resumes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let r = hh_get(&app, "/resumes/mine").await?;
    profile_cache().lock().expect("mutex")["resumes"] = r.clone();
    Ok(r)
}

// ---------------------------------------------------------------- действия через веб-сессию hh.ru

// Смена статуса поиска и снятие резюме с публикации — соискательские
// действия, которые живут на самом hh.ru и работают на сессионных куках
// (+ CSRF-токен), а не на OAuth-токене api.hh.ru (там маршрутов нет).
// Выполняем их в скрытом веб-просмотре с той сессией, которую создал
// вход: грузим страницу hh.ru, делаем fetch из контекста страницы и
// возвращаем результат через спец-схему hhbotresult:// (перехватываем
// в on_navigation, как при входе).

fn web_action_script(kind: &str, arg: &str) -> String {
    let arg = serde_json::to_string(arg).unwrap_or_else(|_| "\"\"".into());
    let attempts = match kind {
        "job_search_status" => {
            r#"[{ url: '/shards/user_statuses/job_search_status?status=' + encodeURIComponent(__ARG__), method: 'PUT' }]"#
        }
        "unpublish" => r#"[
              { url: '/applicant/resume/edit?resume=' + encodeURIComponent(__ARG__) + '&hhtmSource=hhbot', method: 'POST', json: { accessType: [{ string: 'no_one' }] } },
              { url: '/shards/resume/edit/visibility', method: 'POST', json: { hash: __ARG__, accessType: 'no_one' } },
              { url: '/resumes/' + encodeURIComponent(__ARG__) + '/unpublish', method: 'PUT' }
            ]"#,
        _ => "[]",
    };
    r#"(async () => {
  function xsrf() {
    const h = { 'Accept': 'application/json' };
    for (const n of ['_xsrf', 'hh-xsrf', '__Host-hh-xsrf', 'xsrf']) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
      if (m) { h['X-XSRFToken'] = decodeURIComponent(m[1]); break; }
    }
    return h;
  }
  async function attempt(list) {
    const results = [];
    for (const a of list) {
      try {
        const headers = Object.assign(xsrf(), a.json ? { 'Content-Type': 'application/json' } : {});
        const r = await fetch(a.url, { method: a.method, credentials: 'include', headers, body: a.json ? JSON.stringify(a.json) : undefined });
        const t = await r.text();
        results.push({ ok: r.ok, status: r.status, body: t.slice(0, 200) });
        if (r.ok) break;
      } catch (e) {
        results.push({ ok: false, status: 0, body: String(e) });
      }
    }
    return results;
  }
  const results = await attempt(__ATTEMPTS__);
  location.href = 'hhbotresult://r/' + encodeURIComponent(JSON.stringify({ results: results }));
})();"#
    .replace("__ATTEMPTS__", attempts)
    .replace("__ARG__", &arg)
}

fn web_action_error(results: &serde_json::Value) -> String {
    let items = results["results"].as_array();
    let some_ok = items
        .map(|a| a.iter().any(|r| r["ok"].as_bool().unwrap_or(false)))
        .unwrap_or(false);
    if some_ok {
        return String::new();
    }
    let first = items.and_then(|a| a.first()).cloned().unwrap_or_default();
    let status = first["status"].as_u64().unwrap_or(0);
    if status == 401 || status == 403 {
        return "Сессия hh.ru истекла или недоступна — войдите заново и повторите.".into();
    }
    let body = first["body"].as_str().unwrap_or("").trim().to_string();
    if status == 0 {
        return format!("Не удалось выполнить запрос к hh.ru: {}", body);
    }
    format!(
        "hh.ru вернул {}{}",
        status,
        if body.is_empty() {
            String::new()
        } else {
            format!(": {}", body)
        }
    )
}

async fn run_web_action(app: &tauri::AppHandle, kind: &str, arg: &str) -> Result<(), String> {
    if !matches!(kind, "job_search_status" | "unpublish") {
        return Err("Неизвестное действие".into());
    }
    if arg.trim().is_empty() {
        return Err("Пустой аргумент действия".into());
    }
    // если окно от прошлого действия ещё живо — закрываем
    if let Some(w) = app.get_webview_window("webaction") {
        let _ = w.close();
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let script = web_action_script(kind, arg.trim());

    let start_url: tauri::Url = "https://hh.ru/applicant/resumes"
        .parse()
        .expect("корректный URL hh.ru");
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "webaction",
        tauri::WebviewUrl::External(start_url),
    )
    .title("hh.ru")
    .inner_size(520.0, 700.0)
    .visible(false)
    .on_navigation(move |nav_url| {
        if nav_url.scheme() == "hhbotresult" {
            let payload = nav_url.as_str().trim_start_matches("hhbotresult://r/");
            let parsed: serde_json::Value = serde_json::from_str(&urldecode(payload))
                .unwrap_or(serde_json::json!({}));
            let err = web_action_error(&parsed);
            let _ = tx.send(if err.is_empty() { Ok(()) } else { Err(err) });
            return false;
        }
        true
    })
    .on_page_load(move |wv, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let _ = wv.eval(&script);
        }
    });
    builder
        .build()
        .map_err(|e| format!("Не удалось открыть окно hh.ru: {}", e))?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(30))
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(w) = app.get_webview_window("webaction") {
        let _ = w.close();
    }
    match outcome {
        Ok(r) => r,
        Err(_) => Err(
            "hh.ru не ответил вовремя — проверьте соединение и попробуйте ещё раз.".into(),
        ),
    }
}

#[tauri::command]
async fn web_action(app: tauri::AppHandle, kind: String, arg: String) -> Result<(), String> {
    run_web_action(&app, &kind, &arg).await
}

// ---------------------------------------------------------------- обо мне (локальное хранилище)

#[tauri::command]
fn about_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(read_json(about_path(&app)?).unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
fn about_save(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    write_json(about_path(&app)?, &data)
}

// ---------------------------------------------------------------- agents (много провайдеров)

#[tauri::command]
fn agents_load(app: tauri::AppHandle) -> Result<AgentStore, String> {
    Ok(read_json(agents_path(&app)?).unwrap_or_default())
}

#[tauri::command]
fn agents_save(app: tauri::AppHandle, store: AgentStore) -> Result<(), String> {
    if let Some(idx) = store.active {
        if idx >= store.providers.len() {
            return Err("Активный провайдер указан неверно".into());
        }
    }
    write_json(agents_path(&app)?, &store)
}

#[tauri::command]
async fn agent_test(config: AgentConfig) -> Result<serde_json::Value, String> {
    let base = config.base_url.trim_end_matches('/');
    let resp = http_client()
        .get(format!("{}/models", base))
        .bearer_auth(config.api_key.trim())
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к {}: {}", base, e))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Провайдер вернул {}: {}",
            status,
            body["error"]["message"].as_str().unwrap_or("?")
        ));
    }
    let models: Vec<String> = body["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "ok": true, "models": models }))
}

// ---------------------------------------------------------------- чат (история диалогов)

#[derive(Serialize, Deserialize, Clone, Default)]
struct ChatMsg {
    role: String,
    #[serde(default)]
    content: String,
    // полный ход ответа для показа в истории: размышления, инструменты, текст
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parts: Option<serde_json::Value>,
    // служебные поля OpenAI для эхо-сообщений с tool_calls
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_calls: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Conversation {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    messages: Vec<ChatMsg>,
}

fn chats_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("chats.json"))
}

fn load_chats(app: &tauri::AppHandle) -> Vec<Conversation> {
    read_json(chats_path(app).unwrap_or_default()).unwrap_or_default()
}

fn save_chats(app: &tauri::AppHandle, chats: &Vec<Conversation>) -> Result<(), String> {
    write_json(chats_path(app)?, chats)
}

#[tauri::command]
fn chats_list(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let mut list: Vec<serde_json::Value> = load_chats(&app)
        .iter()
        .map(|c| serde_json::json!({ "id": c.id, "title": c.title, "updated_at": c.updated_at }))
        .collect();
    // свежие чаты сверху
    list.sort_by(|a, b| b["updated_at"].as_i64().cmp(&a["updated_at"].as_i64()));
    list
}

#[tauri::command]
fn chat_get(app: tauri::AppHandle, chat_id: String) -> Vec<ChatMsg> {
    load_chats(&app)
        .iter()
        .find(|c| c.id == chat_id)
        .map(|c| {
            c.messages
                .iter()
                .filter(|m| m.role == "user" || m.role == "assistant")
                .filter(|m| !m.content.trim().is_empty() || m.role == "user")
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn chat_delete(app: tauri::AppHandle, chat_id: String) -> Result<(), String> {
    let mut chats = load_chats(&app);
    chats.retain(|c| c.id != chat_id);
    save_chats(&app, &chats)
}

#[tauri::command]
fn chat_rename(app: tauri::AppHandle, chat_id: String, title: String) -> Result<(), String> {
    let mut chats = load_chats(&app);
    if let Some(c) = chats.iter_mut().find(|c| c.id == chat_id) {
        c.title = title.trim().to_string();
        save_chats(&app, &chats)?;
    }
    Ok(())
}

// флаги отмены активных генераций: chat_id -> флаг
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: std::sync::LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &FLAGS
}

// ожидающие подтверждения вызовы: chat_id -> (call_id -> отправитель решения)
type ConfirmTx = tokio::sync::oneshot::Sender<String>;
fn pending_confirms() -> &'static Mutex<HashMap<String, HashMap<String, ConfirmTx>>> {
    static MAP: std::sync::LazyLock<Mutex<HashMap<String, HashMap<String, ConfirmTx>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &MAP
}

// решение пользователя по конкретному вызову инструмента
// проверка поиска из настроек: возвращает первые результаты и бэкенд, который сработал
#[tauri::command]
async fn search_test(
    app: tauri::AppHandle,
    query: String,
    url: Option<String>,
) -> Result<serde_json::Value, String> {
    let store: AgentStore = read_json(agents_path(&app)?).unwrap_or_default();
    let args = json!({ "query": query });
    let configured = url.or(store.search_url);
    let mut attempts: Vec<String> = Vec::new();
    if let Some(base) = configured.as_deref().map(|s| s.trim().trim_end_matches('/')).filter(|s| !s.is_empty()) {
        match searx_json(base, &query).await {
            Ok(r) if !r.is_empty() => return Ok(json!({ "backend": format!("SearXNG ({})", base), "results": r })),
            Ok(_) => attempts.push("SearXNG: пустой ответ".into()),
            Err(e) => attempts.push(format!("SearXNG: {}", e)),
        }
    }
    match brave_search(&query).await {
        Ok(r) if !r.is_empty() => return Ok(json!({ "backend": "Brave (публичный)", "results": r })),
        Ok(_) => attempts.push("Brave: пустой ответ".into()),
        Err(e) => attempts.push(format!("Brave: {}", e)),
    }
    Err(format!("Ни один бэкенд не сработал: {}", attempts.join("; ")))
}

#[tauri::command]
fn chat_confirm(chat_id: String, call_id: String, decision: String) {
    if let Some(tx) = pending_confirms()
        .lock()
        .expect("mutex")
        .get_mut(&chat_id)
        .and_then(|m| m.remove(&call_id))
    {
        let _ = tx.send(decision);
    }
}

#[tauri::command]
fn chat_stop(chat_id: String) {
    if let Some(flag) = cancel_flags().lock().expect("mutex").get(&chat_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- инструменты агента

const MAX_TOOL_STEPS: usize = 6;
const MAX_URL_CHARS: usize = 12_000;

async fn tool_web_search(args: &serde_json::Value, search_url: Option<&str>) -> Result<String, String> {
    let query = args["query"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("нет параметра query")?;

    let mut attempts: Vec<String> = Vec::new();

    // 1) собственный SearXNG-инстанс (JSON, затем HTML)
    if let Some(base) = search_url.map(|s| s.trim().trim_end_matches('/')).filter(|s| !s.is_empty()) {
        match searx_json(base, query).await {
            Ok(r) if !r.is_empty() => return Ok(serde_json::to_string_pretty(&r).unwrap_or_default()),
            Ok(_) => attempts.push(format!("SearXNG {}: пустой ответ", base)),
            Err(e) => attempts.push(format!("SearXNG {}: {}", base, e)),
        }
        match searx_html(base, query).await {
            Ok(r) if !r.is_empty() => return Ok(serde_json::to_string_pretty(&r).unwrap_or_default()),
            Ok(_) => attempts.push(format!("SearXNG HTML {}: пустой ответ", base)),
            Err(e) => attempts.push(format!("SearXNG HTML {}: {}", base, e)),
        }
    }

    // 2) публичный Brave
    match brave_search(query).await {
        Ok(r) if !r.is_empty() => return Ok(serde_json::to_string_pretty(&r).unwrap_or_default()),
        Ok(_) => attempts.push("Brave: пустой ответ".into()),
        Err(e) => attempts.push(format!("Brave: {}", e)),
    }

    Err(format!(
        "Поиск не удался. Причины по бэкендам: {}. Настройте свой SearXNG в Настройках.",
        attempts.join("; ")
    ))
}

async fn fetch_text(
    url: String,
    ua: &str,
    timeout_secs: u64,
    extra: &[(&str, &str)],
) -> Result<String, String> {
    let mut req = http_client()
        .get(&url)
        .header("User-Agent", ua)
        .header("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.8")
        .timeout(std::time::Duration::from_secs(timeout_secs));
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!(
                "{}: не дождались ответа за {} с (инстанс отвечает медленно)",
                url, timeout_secs
            )
        } else if e.is_connect() {
            format!("{}: не удалось соединиться ({})", url, e)
        } else {
            format!("{}: {}", url, e)
        }
    })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }
    Ok(body)
}

async fn searx_json(base: &str, query: &str) -> Result<Vec<serde_json::Value>, String> {
    let body = fetch_text(
        format!("{}/search?q={}&format=json", base, urlencode(query)),
        DESKTOP_UA,
        30,
        &[("Accept", "application/json")],
    )
    .await?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|_| "ответ не JSON (на инстансе отключён format=json?)".to_string())?;
    Ok(v["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(8)
                .filter_map(|r| {
                    let url = r["url"].as_str()?.to_string();
                    Some(json!({
                        "title": r["title"].as_str().unwrap_or("").trim(),
                        "url": url,
                        "snippet": r["content"].as_str().unwrap_or("").trim(),
                    }))
                })
                .collect()
        })
        .unwrap_or_default())
}

async fn searx_html(base: &str, query: &str) -> Result<Vec<serde_json::Value>, String> {
    let body = fetch_text(
        format!("{}/search?q={}", base, urlencode(query)),
        DESKTOP_UA,
        30,
        &[],
    )
    .await?;
    let mut out = Vec::new();
    for block in body.split("<article").skip(1) {
        if out.len() >= 8 {
            break;
        }
        let Some(h3_end) = block.find("</h3>") else { continue };
        let head = &block[..h3_end];
        let Some(a_pos) = head.find("<a ") else { continue };
        let tag_end = head[a_pos..].find('>').map(|e| a_pos + e).unwrap_or(a_pos);
        let tag = &head[..tag_end];
        let href = extract_attr(tag, "href").unwrap_or_default();
        let title = strip_tags(&head[tag_end..]);
        let snippet = block
            .find("class=\"content\"")
            .or_else(|| block.find("<p class="))
            .and_then(|p| {
                let start = block[p..].find('>')? + p + 1;
                let end = block[start..].find("</p>").map(|e| start + e).unwrap_or((start + 300).min(block.len()));
                Some(strip_tags(&block[start..end]))
            })
            .unwrap_or_default();
        if href.starts_with("http") && !title.trim().is_empty() {
            out.push(json!({ "title": title.trim(), "url": href, "snippet": snippet.trim() }));
        }
    }
    Ok(out)
}

async fn brave_search(query: &str) -> Result<Vec<serde_json::Value>, String> {
    let html = fetch_text(
        format!("https://search.brave.com/search?q={}", urlencode(query)),
        DESKTOP_UA,
        20,
        &[],
    )
    .await?;
    Ok(parse_brave_results(&html, 8))
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// извлечение результатов из выдачи search.brave.com: блоки
// <div class="result-content..."> с якорем class="... l1 ..." и описанием
// в generic-snippet
fn parse_brave_results(html: &str, limit: usize) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for block in html.split("<div class=\"result-content").skip(1) {
        if out.len() >= limit {
            break;
        }
        // якорь: <a ...> с href и классом, содержащим "l1"
        let mut anchor: Option<(String, String)> = None;
        let mut rest = block;
        while let Some(p) = rest.find("<a ") {
            let Some(tag_end_rel) = rest[p..].find('>') else { break };
            let tag = &rest[p..p + tag_end_rel];
            let cls = extract_attr(tag, "class").unwrap_or_default();
            let href = extract_attr(tag, "href").unwrap_or_default();
            if cls.split_whitespace().any(|c| c == "l1") && href.starts_with("http") {
                let after_tag = &rest[p + tag_end_rel + 1..];
                let anchor_html = after_tag
                    .find("</a>")
                    .map(|e| &after_tag[..e])
                    .unwrap_or_default();
                // предпочитаем внутренний элемент с заголовком,
                // иначе весь текст якоря (там ещё имя сайта и крошки)
                let title = anchor_html
                    .find("search-snippet-title")
                    .and_then(|tp| {
                        let tail = &anchor_html[tp..];
                        let start = tail.find('>')? + 1;
                        let end = tail[start..].find("</div>")?;
                        Some(strip_tags(&tail[start..start + end]))
                    })
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| strip_tags(anchor_html));
                if !title.trim().is_empty() {
                    anchor = Some((href, title));
                    break;
                }
            }
            rest = &rest[p + tag_end_rel + 1..];
        }
        let Some((url, title)) = anchor else { continue };

        // описание: <div class="generic-snippet..."> ... <div class="content ...">текст</div>
        let snippet = block
            .find("generic-snippet")
            .and_then(|p| {
                let tail = &block[p..];
                let cpos = tail.find("class=\"content")?;
                let start = tail[cpos..].find('>')? + cpos + 1;
                let end = tail[start..].find("</div>")? + start;
                Some(strip_tags(&tail[start..end]))
            })
            .unwrap_or_default();

        if url.starts_with("http") {
            out.push(serde_json::json!({
                "title": title.trim(),
                "url": url,
                "snippet": snippet.trim(),
            }));
        }
    }
    out
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=\"", attr);
    let pos = tag.find(&needle)? + needle.len();
    let end = tag[pos..].find('"')? + pos;
    Some(tag[pos..end].to_string())
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in html.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    // распространённые html-сущности
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn tool_fetch_url(args: &serde_json::Value) -> Result<String, String> {
    let url = args["url"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .ok_or("нет корректного параметра url")?;

    let resp = http_client()
        .get(url)
        .header("User-Agent", UA)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Не удалось открыть {}: {}", url, e))?;

    let status = resp.status();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("Сайт вернул {}: {}", status, url));
    }

    let raw = if ctype.contains("text/html") || body.trim_start().starts_with('<') {
        // вырезаем script/style, потом теги
        let mut buf = body.as_str();
        let mut tmp = String::new();
        loop {
            match (buf.find("<script"), buf.find("<style")) {
                (Some(a), Some(b)) => {
                    let p = a.min(b);
                    let tag_end = buf[p..].find('>').unwrap_or(0);
                    let closer = if buf[p..].starts_with("<script") { "</script>" } else { "</style>" };
                    match buf[p + tag_end..].find(closer) {
                        Some(e) => {
                            tmp.push_str(&buf[..p]);
                            buf = &buf[p + tag_end + e + closer.len()..];
                        }
                        None => {
                            tmp.push_str(&buf[..p]);
                            buf = "";
                            break;
                        }
                    }
                }
                (Some(a), None) | (None, Some(a)) => {
                    let p = a;
                    let tag_end = buf[p..].find('>').unwrap_or(0);
                    let closer = if buf[p..].starts_with("<script") { "</script>" } else { "</style>" };
                    match buf[p + tag_end..].find(closer) {
                        Some(e) => {
                            tmp.push_str(&buf[..p]);
                            buf = &buf[p + tag_end + e + closer.len()..];
                        }
                        None => {
                            tmp.push_str(&buf[..p]);
                            buf = "";
                            break;
                        }
                    }
                }
                (None, None) => {
                    tmp.push_str(buf);
                    break;
                }
            }
        }
        strip_tags(&tmp)
    } else {
        body
    };

    let mut text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    text.truncate(MAX_URL_CHARS);
    Ok(format!("Содержимое {} (первые {} символов):\n\n{}", url, text.len(), text))
}

const TOOLS_JSON: &str = r#"[
  {
    "type": "function",
    "function": {
      "name": "current_datetime",
      "description": "Возвращает текущие дату и время на компьютере пользователя. Используй, когда важна актуальность (год, месяц, «сегодня») — например, перед поиском свежих вакансий или новостей.",
      "parameters": { "type": "object", "properties": {} }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "web_search",
      "description": "Поиск в интернете (DuckDuckGo). Возвращает список результатов: заголовок, URL, краткое описание. Используй для актуальной информации: вакансии, зарплаты, компании, новости.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Поисковый запрос" }
        },
        "required": ["query"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "fetch_url",
      "description": "Скачать СТАТИЧЕСКУЮ страницу по URL и вернуть её текст (HTML вычищается до читаемого текста). Используй после web_search. Если страница пустая/это SPA и контент подгружается JavaScript — используй render_page.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "Полный http(s) URL" }
        },
        "required": ["url"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_page",
      "description": "Открыть страницу во встроенном браузере (с выполнением JavaScript) и вернуть её видимый текст. Используй для SPA и страниц, где fetch_url вернул пустоту или заглушку (вход через логин, динамические списки).",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "Полный http(s) URL" }
        },
        "required": ["url"]
      }
    }
  }
]"#;

// инструменты приложения — доступны в режимах confirm и full
const APP_TOOLS_JSON: &str = r#"[
  {
    "type": "function",
    "function": {
      "name": "list_resumes",
      "description": "Показать резюме пользователя на hh.ru: id, название, статус публикации. Только чтение.",
      "parameters": { "type": "object", "properties": {} }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "set_theme",
      "description": "Переключить тему оформления приложения.",
      "parameters": {
        "type": "object",
        "properties": {
          "theme": { "type": "string", "enum": ["light", "dark"], "description": "Светлая или тёмная тема" }
        },
        "required": ["theme"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "navigate",
      "description": "Открыть раздел приложения: «обо мне» (профиль и резюме) или «настройки».",
      "parameters": {
        "type": "object",
        "properties": {
          "tab": { "type": "string", "enum": ["chat", "profile", "settings"] }
        },
        "required": ["tab"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "save_about",
      "description": "Сохранить данные блока «Обо мне» пользователя: желаемая должность, город, зарплата, занятость, график, навыки, опыт и т.д. Передавай только те поля, которые известны, — остальные останутся без изменений. Перед сохранением незнакомых данных сначала уточни их у пользователя.",
      "parameters": {
        "type": "object",
        "properties": {
          "search_status": { "type": "string", "enum": ["active_search", "looking_for_offers", "not_looking_for_job"], "description": "Статус поиска работы (как на hh.ru)" },
          "desired_title": { "type": "string", "description": "Желаемая должность" },
          "area": { "type": "string", "description": "Город работы" },
          "salary": { "type": "string", "description": "Ожидаемая зарплата в рублях в месяц, только число" },
          "employment": { "type": "array", "items": { "type": "string", "enum": ["full", "part", "project", "internship"] }, "description": "Занятость" },
          "schedule": { "type": "array", "items": { "type": "string", "enum": ["full_day", "flexible", "remote", "hybrid", "shift", "fly_in_fly_out"] }, "description": "График работы" },
          "skills": { "type": "string", "description": "Ключевые навыки через запятую" },
          "experience": { "type": "string", "description": "Опыт и достижения" },
          "about": { "type": "string", "description": "Коротко о себе: что важно в работе, чего избегать" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "unpublish_resume",
      "description": "Снять резюме с публикации на hh.ru. Влияет на видимость резюме для работодателей!",
      "parameters": {
        "type": "object",
        "properties": {
          "resume_id": { "type": "string" }
        },
        "required": ["resume_id"]
      }
    }
  }
]"#;

// инструменты, меняющие состояние приложения — в режиме confirm требуют подтверждения
fn is_app_action(name: &str) -> bool {
    matches!(name, "set_theme" | "navigate" | "save_about" | "unpublish_resume")
}

async fn tool_list_resumes(app: &tauri::AppHandle) -> Result<String, String> {
    let data = hh_get(app, "/resumes/mine").await?;
    let items: Vec<serde_json::Value> = data["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    serde_json::json!({
                        "id": r["id"],
                        "title": r["title"],
                        "status": r["status"]["name"],
                        "updated_at": r["updated_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        return Ok("Резюме не найдены.".into());
    }
    Ok(serde_json::to_string_pretty(&items).unwrap_or_default())
}

async fn tool_unpublish_resume(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let id = args["resume_id"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("нет параметра resume_id")?;
    run_web_action(app, "unpublish", id).await?;
    Ok("Резюме снято с показа на hh.ru (видимость «не показывать никому»).".into())
}

// Ключи, которые агент может менять в «Обо мне»; остальное игнорируем
const ABOUT_KEYS: &[&str] = &[
    "search_status",
    "desired_title",
    "area",
    "salary",
    "employment",
    "schedule",
    "skills",
    "experience",
    "about",
];

async fn tool_save_about(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let mut about = read_json::<serde_json::Value>(about_path(app)?).unwrap_or(json!({}));
    let obj = about.as_object_mut().ok_or("повреждён файл «Обо мне»")?;
    if let Some(patch) = args.as_object() {
        for (k, v) in patch {
            if !ABOUT_KEYS.contains(&k.as_str()) {
                continue;
            }
            if k == "search_status" {
                // статус поиска — только допустимые значения hh.ru
                let s = v.as_str().unwrap_or("");
                if matches!(s, "active_search" | "looking_for_offers" | "not_looking_for_job") {
                    obj.insert(k.clone(), json!(s));
                }
                continue;
            }
            if let Some(s) = v.as_str() {
                if !s.trim().is_empty() {
                    obj.insert(k.clone(), json!(s.trim()));
                }
            } else if let Some(arr) = v.as_array() {
                let items: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !items.is_empty() {
                    obj.insert(k.clone(), json!(items));
                }
            }
        }
    }
    write_json(about_path(app)?, &about)?;
    Ok("Данные «Обо мне» сохранены.".into())
}

async fn tool_current_datetime() -> String {
    let now = chrono::Local::now();
    let weekdays = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
    let wd = weekdays[now.weekday().num_days_from_monday() as usize];
    format!(
        "Сейчас: {} {}, {}. Эта дата считается текущей — не считай актуальным прошлые годы.",
        now.format("%d.%m.%Y"),
        wd,
        now.format("%H:%M %Z")
    )
}

// открыть страницу в скрытом webview (JS выполняется) и вернуть видимый текст
async fn tool_render_page(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let url = args["url"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .ok_or("нет корректного параметра url")?
        .to_string();

    if let Some(w) = app.get_webview_window("reader") {
        let _ = w.close();
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let script = r#"(function(){
  function send() {
    var t = document.body ? document.body.innerText : '';
    location.href = 'hhbotresult://r/' + encodeURIComponent(JSON.stringify({
      title: document.title || '',
      text: t.slice(0, 15000)
    }));
  }
  // дать SPA немного дорисоваться после загрузки
  setTimeout(send, 1500);
})();"#
        .to_string();

    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("некорректный URL: {}", e))?;
    let tx_nav = tx.clone();
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "reader",
        tauri::WebviewUrl::External(parsed),
    )
    .title("Чтение страницы")
    .inner_size(1000.0, 800.0)
    .visible(false)
    .on_navigation(move |nav_url| {
        if nav_url.scheme() == "hhbotresult" {
            let payload = nav_url.as_str().trim_start_matches("hhbotresult://r/");
            let parsed: serde_json::Value = serde_json::from_str(&urldecode(payload))
                .unwrap_or(serde_json::json!({}));
            let title = parsed["title"].as_str().unwrap_or("").to_string();
            let text = parsed["text"].as_str().unwrap_or("").to_string();
            let _ = tx_nav.send(Ok(format!("{}

{}", title, text)));
            return false;
        }
        true
    })
    .on_page_load(move |wv, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let _ = wv.eval(&script);
        }
    });
    builder
        .build()
        .map_err(|e| format!("Не удалось открыть окно чтения: {}", e))?;

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(45))
    })
    .await
    .map_err(|e| e.to_string())?;

    if let Some(w) = app.get_webview_window("reader") {
        let _ = w.close();
    }
    let content = match outcome {
        Ok(r) => r?,
        Err(_) => return Err("Страница не загрузилась вовремя (45 с) — возможно, она требует входа.".into()),
    };
    let mut text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    text.truncate(MAX_URL_CHARS);
    if text.trim().is_empty() {
        return Err("Страница отрендерилась в пустой текст — попробуй fetch_url.".into());
    }
    Ok(text)
}

async fn run_tool(
    app: &tauri::AppHandle,
    name: &str,
    args: &serde_json::Value,
    search_url: Option<&str>,
    on_event: &tauri::ipc::Channel<serde_json::Value>,
) -> String {
    // действия, которые делает интерфейс, дублируем событием do_action
    if name == "set_theme" || name == "navigate" {
        let _ = on_event.send(serde_json::json!({ "type": "do_action", "name": name, "args": args }));
        return match name {
            "set_theme" => format!(
                "Тема переключена: {}.",
                args["theme"].as_str().unwrap_or("?")
            ),
            "navigate" => format!(
                "Открыт раздел: {}.",
                args["tab"].as_str().unwrap_or("?")
            ),
            _ => String::new(),
        };
    }
    let res = match name {
        "web_search" => tool_web_search(args, search_url).await,
        "current_datetime" => Ok(tool_current_datetime().await),
        "fetch_url" => tool_fetch_url(args).await,
        "render_page" => tool_render_page(app, args).await,
        "list_resumes" => tool_list_resumes(app).await,
        "save_about" => tool_save_about(app, args).await,
        "unpublish_resume" => tool_unpublish_resume(app, args).await,
        _ => Err(format!("неизвестный инструмент: {}", name)),
    };
    match res {
        Ok(v) => v,
        Err(e) => format!("Ошибка инструмента: {}", e),
    }
}

// ---------------------------------------------------------------- системный промпт агента

// кэш данных hh.ru для системного промпта: имя и резюме. Обновляется
// при заходе в приложение и перед отправкой сообщения
fn profile_cache() -> &'static Mutex<serde_json::Value> {
    static CACHE: std::sync::LazyLock<Mutex<serde_json::Value>> =
        std::sync::LazyLock::new(|| Mutex::new(json!({})));
    &CACHE
}

async fn refresh_profile_cache(app: &tauri::AppHandle) {
    let me = hh_get(app, "/me").await.unwrap_or(json!({}));
    let resumes = hh_get(app, "/resumes/mine").await.unwrap_or(json!({}));
    let mut c = profile_cache().lock().expect("mutex");
    *c = json!({ "me": me, "resumes": resumes });
}

// человекочитаемая выжимка резюме для промпта
fn resumes_summary(resumes: &serde_json::Value) -> String {
    let Some(items) = resumes["items"].as_array() else { return String::new() };
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Резюме пользователя на hh.ru\n\n");
    for r in items {
        let title = r["title"].as_str().unwrap_or("(без названия)");
        let status = r["status"]["name"].as_str().unwrap_or("");
        let updated = r["updated_at"].as_str().unwrap_or("").get(..10).unwrap_or("");
        let salary = r["salary"]["amount"]
            .as_i64()
            .map(|a| format!(", зарплата: {} {}", a, r["salary"]["currency"].as_str().unwrap_or("RUR")))
            .unwrap_or_default();
        out.push_str(&format!(
            "- «{}» — статус: {}, обновлено: {}{}\n",
            title, status, updated, salary
        ));
        if let Some(skills) = r["skill_set"].as_array() {
            let names: Vec<&str> = skills.iter().filter_map(|s| s.as_str()).collect();
            if !names.is_empty() {
                out.push_str(&format!("  навыки: {}\n", names.join(", ")));
            }
        }
    }
    out
}

fn build_system_prompt(app: &tauri::AppHandle) -> String {
    let about: serde_json::Value = read_json(about_path(app).unwrap_or_default()).unwrap_or(json!({}));
    // человеческие названия полей «Обо мне» — чтобы в промпт попадали
    // русские подписи, а не ключи
    const LABELS: &[(&str, &str)] = &[
        ("search_status", "Статус поиска"),
        ("desired_title", "Желаемая должность"),
        ("area", "Город"),
        ("salary", "Ожидаемая зарплата, ₽/мес"),
        ("employment", "Занятость"),
        ("schedule", "График"),
        ("skills", "Ключевые навыки"),
        ("experience", "Опыт и достижения"),
        ("about", "Коротко о себе"),
    ];
    let field_value = |k: &str| -> Option<String> {
        let v = about.get(k)?;
        if let Some(s) = v.as_str() {
            let s = s.trim();
            if s.is_empty() { return None; }
            return Some(s.to_string());
        }
        if let Some(arr) = v.as_array() {
            let items: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            if items.is_empty() { return None; }
            return Some(items.join(", "));
        }
        None
    };

    let now_dt = chrono::Local::now();
    let weekdays = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
    let wd = weekdays[now_dt.weekday().num_days_from_monday() as usize];
    let mut p = format!(
        "Сегодня: {}, {}. У тебя есть инструмент current_datetime — проверяй дату, когда важна актуальность.\n\n",
        now_dt.format("%d.%m.%Y"),
        wd
    );
    p.push_str(
        "Ты — HH-агент, помощник по поиску работы на hh.ru внутри настольного приложения HH-bot. \
Твоя задача — помогать пользователю с поиском работы: подбором вакансий, анализом рынка, \
советами по резюме и откликам, подготовкой к собеседованиям. \
Отвечай на русском языке, по делу, структурировано. Используй Markdown: заголовки, списки, \
таблицы, блоки кода — где это уместно. \
У тебя есть инструменты web_search (поиск в интернете) и fetch_url (прочитать страницу). \
Пользуйся ими, когда нужны актуальные данные: свежие вакансии, зарплаты, информация о компании. \
Сначала ищи, потом отвечай — не выдумывай ссылки и факты о рынке.\n\n\
## Данные пользователя из профиля «Обо мне»\n\n",
    );
    for (k, label) in LABELS {
        if let Some(v) = field_value(k) {
            p.push_str(&format!("- {}: {}\n", label, v));
        } else {
            p.push_str(&format!("- {}: (не указано)\n", label));
        }
    }
    // имя и резюме из hh.ru
    {
        let cache = profile_cache().lock().expect("mutex").clone();
        let full_name = ["last_name", "first_name", "middle_name"]
            .iter()
            .filter_map(|k| cache["me"][k].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if !full_name.trim().is_empty() {
            p.push_str(&format!("\nПользователя зовут: {}.\n", full_name.trim()));
        }
        p.push_str(&resumes_summary(&cache["resumes"]));
    }
    p.push_str(
        "\n## Работа с профилем «Обо мне»\n\n\
Эти данные нужны тебе для подбора вакансий и откликов. Веди себя так:\n\
- Если данных хватает для текущего запроса — просто отвечай, ничего не спрашивай.\n\
- Если для запроса или подбора вакансий не хватает важных данных (нет желаемой должности, города, зарплаты, навыков, опыта), \
задай пользователю короткие вопросы — 1–3 уточнения за раз, не анкету из десяти пунктов.\n\
- Заполнять профиль можно и без запроса: если пользователь в разговоре упоминает свой опыт, навыки, зарплатные ожидания, \
город или график — предложи сохранить это в «Обо мне» (или сохрани через save_about, если пользователь явно не против).\n\
- Через save_about сохраняй только то, что пользователь подтвердил словами. Статус поиска \
(active_search — активно ищу, looking_for_offers — рассматриваю предложения, not_looking_for_job — не ищу работу) \
меняй, только когда пользователь прямо скажет, что изменил отношение к поиску.\n\
- После сохранения кратко сообщи, что добавлено в профиль.\n",
    );
    p
}

// ---------------------------------------------------------------- стриминг chat/completions с инструментами

#[derive(Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    // «думающие» модели (DeepSeek, GLM, Qwen и др.)
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default, alias = "reasoning")]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    function: StreamToolFn,
}

#[derive(Deserialize)]
struct StreamToolFn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: String,
}

struct StepResult {
    content: String,
    tool_calls: Vec<serde_json::Value>, // собранные tool_calls в формате API
}

// один шаг стриминга; возвращает finish_reason
async fn stream_step(
    base: &str,
    api_key: &str,
    model: &str,
    messages: &[serde_json::Value],
    tools: &serde_json::Value,
    cancelled: &AtomicBool,
    on_delta: &(dyn Fn(&str) + Send + Sync),
    on_reasoning: &(dyn Fn(&str) + Send + Sync),
) -> Result<(String, StepResult), String> {
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "tools": tools,
    });

    let mut resp = http_client()
        .post(format!("{}/chat/completions", base))
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к провайдеру: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("Провайдер вернул {}: {}", status, msg));
    }

    let mut content = String::new();
    let mut finish = String::new();
    // tool_calls собираем по index
    let mut tc: Vec<(usize, String, String, String)> = Vec::new(); // (index, id, name, args)

    let mut buf = String::new();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("__cancelled__".into());
        }
        // отмена должна срабатывать мгновенно, даже пока висим в chunk():
        // опрашиваем флаг каждые 100 мс параллельно с чтением
        let chunk = tokio::select! {
            c = resp.chunk() => c.map_err(|e| format!("Ошибка потока: {}", e))?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err("__cancelled__".into());
                }
                continue;
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // обрабатываем полные строки
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim_end().to_string();
            buf.drain(..pos + 1);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            if let Some(f) = v["choices"][0]["finish_reason"].as_str() {
                finish = f.to_string();
            }
            let delta: Option<StreamDelta> =
                serde_json::from_value(v["choices"][0]["delta"].clone()).ok();
            if let Some(d) = delta {
                if let Some(c) = d.reasoning_content.as_ref().or(d.reasoning.as_ref()) {
                    if !c.is_empty() {
                        on_reasoning(c);
                    }
                }
                if let Some(c) = &d.content {
                    if !c.is_empty() {
                        content.push_str(c);
                        on_delta(c);
                    }
                }
                if let Some(calls) = &d.tool_calls {
                    for call in calls {
                        while tc.len() <= call.index {
                            tc.push((tc.len(), String::new(), String::new(), String::new()));
                        }
                        let e = &mut tc[call.index];
                        if let Some(id) = &call.id {
                            if !id.is_empty() {
                                e.1 = id.clone();
                            }
                        }
                        if let Some(n) = &call.function.name {
                            if !n.is_empty() {
                                e.2 = n.clone();
                            }
                        }
                        e.3.push_str(&call.function.arguments);
                    }
                }
            }
        }
    }

    let tool_calls = tc
        .into_iter()
        .filter(|(_, _, name, _)| !name.is_empty())
        .map(|(i, id, name, args)| {
            serde_json::json!({
                "id": if id.is_empty() { format!("call_{}", i) } else { id },
                "type": "function",
                "function": { "name": name, "arguments": args },
            })
        })
        .collect();

    Ok((finish, StepResult { content, tool_calls }))
}

#[tauri::command]
async fn chat_start(
    app: tauri::AppHandle,
    chat_id: String,
    message: String,
    model: Option<String>,
    mode: Option<String>,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let mode = mode.unwrap_or_else(|| "chat".into());
    let store: AgentStore = read_json(agents_path(&app)?).ok_or("Провайдеры не настроены")?;
    let active = store
        .active
        .and_then(|i| store.providers.get(i))
        .ok_or("Не выбран ИИ-провайдер — добавьте его в Настройках")?;
    let base = active.base_url.trim_end_matches('/').to_string();
    let api_key = active.api_key.clone();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| {
            if !active.model.trim().is_empty() {
                active.model.clone()
            } else {
                store.agent_model.clone().unwrap_or_default()
            }
        });
    if model.is_empty() {
        return Err("Не выбрана модель".into());
    }

    // актуализируем имя/резюме для системного промпта; неудача не мешает чату
    let app2 = app.clone();
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        refresh_profile_cache(&app2),
    )
    .await;

    let cancelled = Arc::new(AtomicBool::new(false));
    cancel_flags()
        .lock()
        .expect("mutex")
        .insert(chat_id.clone(), cancelled.clone());

    let res = chat_run(
        &app,
        &chat_id,
        &message,
        &model,
        &mode,
        &base,
        &api_key,
        store.search_url.as_deref(),
        &cancelled,
        &on_event,
    )
    .await;

    cancel_flags().lock().expect("mutex").remove(&chat_id);

    match res {
        Ok(()) => Ok(()),
        Err(e) if e == "__cancelled__" => {
            let _ = on_event.send(serde_json::json!({ "type": "cancelled" }));
            Ok(())
        }
        Err(e) => {
            let _ = on_event.send(serde_json::json!({ "type": "error", "message": e }));
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn chat_run(
    app: &tauri::AppHandle,
    chat_id: &str,
    message: &str,
    model: &str,
    mode: &str,
    base: &str,
    api_key: &str,
    search_url: Option<&str>,
    cancelled: &AtomicBool,
    on_event: &tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    // ---- сохраняем сообщение пользователя и создаём чат при необходимости
    let mut chats = load_chats(app);
    let now_ts = now();
    let conv = match chats.iter_mut().find(|c| c.id == chat_id) {
        Some(c) => {
            c.updated_at = now_ts;
            c
        }
        None => {
            let title: String = message.chars().take(48).collect();
            chats.push(Conversation {
                id: chat_id.to_string(),
                title: if title.trim().is_empty() { "Новый чат".into() } else { title },
                created_at: now_ts,
                updated_at: now_ts,
                messages: vec![],
            });
            chats.last_mut().unwrap()
        }
    };

    // историю берём ДО добавления нового сообщения (последние 24)
    let history: Vec<serde_json::Value> = conv
        .messages
        .iter()
        .filter(|m| (m.role == "user" || m.role == "assistant") && !m.content.trim().is_empty())
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(24)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    conv.messages.push(ChatMsg {
        role: "user".into(),
        content: message.to_string(),
        parts: None,
        tool_calls: None,
        tool_call_id: None,
    });
    save_chats(app, &chats)?;

    // ---- цикл агента
    let mut api_messages: Vec<serde_json::Value> = Vec::new();
    api_messages.push(serde_json::json!({ "role": "system", "content": build_system_prompt(app) }));
    api_messages.extend(history);
    api_messages.push(serde_json::json!({ "role": "user", "content": message }));

    // набор инструментов зависит от режима:
    //   chat — только поиск в сети; confirm/full — плюс действия в приложении
    let mut tools: serde_json::Value =
        serde_json::from_str(TOOLS_JSON).unwrap_or(json!([]));
    if mode == "confirm" || mode == "full" {
        let app_tools: serde_json::Value =
            serde_json::from_str(APP_TOOLS_JSON).unwrap_or(json!([]));
        for t in app_tools.as_array().unwrap_or(&vec![]) {
            tools.as_array_mut().unwrap().push(t.clone());
        }
    }

    let mut final_answer = String::new();

    // журнал сегментов для истории: текст / размышления / инструменты —
    // сохраняется в chats.json, чтобы ход работы был виден и через год
    let parts_log: std::sync::Mutex<Vec<serde_json::Value>> =
        std::sync::Mutex::new(Vec::new());
    fn push_delta(log: &std::sync::Mutex<Vec<serde_json::Value>>, kind: &str, c: &str) {
        let mut v = log.lock().expect("mutex");
        match v.last_mut() {
            Some(p) if p["kind"] == kind && p["text"].is_string() => {
                let cur = p["text"].as_str().unwrap_or("").to_string();
                p["text"] = json!(format!("{}{}", cur, c));
            }
            _ => {
                v.push(json!({ "kind": kind, "text": c }));
            }
        }
    }

    let run_result: Result<(), String> = loop {
        if parts_log.lock().expect("mutex").iter().filter(|p| p["kind"] == "tool").count()
            >= MAX_TOOL_STEPS
        {
            break Ok(()); // лимит шагов — отвечаем тем, что накоплено
        }
        if cancelled.load(Ordering::Relaxed) {
            break Err("__cancelled__".into());
        }

        let step = {
            let log = &parts_log;
            stream_step(
                base,
                api_key,
                model,
                &api_messages,
                &tools,
                cancelled,
                &|c| {
                    push_delta(log, "text", c);
                    let _ = on_event.send(serde_json::json!({ "type": "delta", "content": c }));
                },
                &|c| {
                    push_delta(log, "thinking", c);
                    let _ = on_event.send(serde_json::json!({ "type": "reasoning", "content": c }));
                },
            )
            .await
        };

        let result = match step {
            Ok((_, r)) => r,
            Err(e) => break Err(e),
        };

        if !result.tool_calls.is_empty() {
            // эхо-сообщение ассистента с tool_calls
            api_messages.push(serde_json::json!({
                "role": "assistant",
                "content": result.content,
                "tool_calls": result.tool_calls,
            }));

            for call in &result.tool_calls {
                let name = call["function"]["name"].as_str().unwrap_or("?").to_string();
                let args_s = call["function"]["arguments"].as_str().unwrap_or("{}").to_string();
                let args: serde_json::Value = serde_json::from_str(&args_s).unwrap_or(json!({}));
                let call_id = call["id"].as_str().unwrap_or("call").to_string();

                // подтверждение действия в режиме confirm
                let mut approved = mode != "confirm" || !is_app_action(&name);
                if !approved {
                    let (tx, mut rx) = tokio::sync::oneshot::channel::<String>();
                    pending_confirms()
                        .lock()
                        .expect("mutex")
                        .entry(chat_id.to_string())
                        .or_default()
                        .insert(call_id.clone(), tx);
                    let _ = on_event.send(serde_json::json!({
                        "type": "confirm_request",
                        "call_id": call_id,
                        "name": name,
                        "args": args,
                    }));
                    // ждём решение пользователя, но отмена (Стоп) работает и здесь
                    let decision = loop {
                        tokio::select! {
                            r = &mut rx => {
                                break r.unwrap_or_else(|_| "deny".into());
                            }
                            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {
                                if cancelled.load(Ordering::Relaxed) {
                                    break "__cancelled__".into();
                                }
                            }
                        }
                    };
                    if decision == "__cancelled__" {
                        // прерываем и for-цикл инструментов, и внешний loop
                        cancelled.store(true, Ordering::Relaxed);
                        continue;
                    }
                    let _ = on_event.send(serde_json::json!({
                        "type": "confirm_result", "call_id": call_id, "decision": decision,
                    }));
                    approved = decision == "allow";
                }

                if !approved {
                    api_messages.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": "Пользователь отклонил это действие. Не повторяй его без явной просьбы.",
                    }));
                    parts_log.lock().expect("mutex").push(json!({
                        "kind": "tool", "name": name, "args": args,
                        "label": format!("Отклонено: {}", name),
                        "status": "done",
                    }));
                    continue;
                }

                // проверяем отмену перед каждым инструментом
                if cancelled.load(Ordering::Relaxed) {
                    continue;
                }

                let _ = on_event.send(serde_json::json!({ "type": "tool_start", "name": name, "args": args }));
                parts_log.lock().expect("mutex").push(json!({
                    "kind": "tool", "name": name, "args": args, "status": "running",
                }));
                // «Стоп» должен обрывать работающий инструмент мгновенно:
                // ожидание отмены выбрасывает run_tool вместе с его сетевым запросом
                let output = tokio::select! {
                    r = run_tool(app, &name, &args, search_url, on_event) => r,
                    _ = async {
                        loop {
                            if cancelled.load(Ordering::Relaxed) {
                                return;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        }
                    } => {
                        String::new() // недостижимо: ниже проверяем флаг
                    }
                };
                if cancelled.load(Ordering::Relaxed) {
                    let _ = on_event.send(serde_json::json!({ "type": "tool_end", "name": name }));
                    break;
                }
                // для инспекции показываем и ответ инструмента (укороченно)
                let preview: String = output.chars().take(1500).collect();
                let _ = on_event.send(serde_json::json!({
                    "type": "tool_end", "name": name, "result": preview,
                }));
                if let Some(p) = parts_log
                    .lock()
                    .expect("mutex")
                    .iter_mut()
                    .rev()
                    .find(|p| p["kind"] == "tool" && p["status"] == "running")
                {
                    *p = json!({
                        "kind": "tool", "name": name, "args": args, "status": "done",
                        "result": preview,
                    });
                }
                api_messages.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": output,
                }));
            }
            continue;
        }

        // обычный ответ (текст перед tool_calls уже отдан дельтами)
        final_answer = result.content;
        break Ok(());
    };

    let cancelled_run = matches!(&run_result, Err(e) if e == "__cancelled__");

    // лимит шагов инструментов исчерпан без ответа
    if let Err(e) = &run_result {
        if e != "__cancelled__" && final_answer.is_empty() && parts_log.lock().expect("mutex").iter().all(|p| p["kind"] != "text") {
            return Err(e.clone());
        }
    }
    if final_answer.is_empty() && !cancelled_run {
        return Err("Модель не вернула ответ".into());
    }

    // ---- сохраняем ответ ассистента (в т.ч. частичный при отмене) вместе
    // с полным ходом работы — он остаётся в chats.json навсегда
    {
        let parts = parts_log.lock().expect("mutex").clone();
        let mut chats = load_chats(app);
        if let Some(c) = chats.iter_mut().find(|c| c.id == chat_id) {
            c.updated_at = now();
            c.messages.push(ChatMsg {
                role: "assistant".into(),
                content: final_answer,
                parts: Some(json!(parts)),
                tool_calls: None,
                tool_call_id: None,
            });
            save_chats(app, &chats)?;
        }
    }

    match run_result {
        Ok(()) => {
            let _ = on_event.send(serde_json::json!({ "type": "done" }));
            Ok(())
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------- helpers

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            quick_auth,
            logout,
            auth_status,
            get_me,
            get_resumes,
            web_action,
            about_load,
            about_save,
            agents_load,
            agents_save,
            agent_test,
            chats_list,
            chat_get,
            chat_delete,
            chat_rename,
            chat_start,
            chat_stop,
            chat_confirm,
            search_test,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска HH-bot");
}

#[cfg(test)]
mod tests {
    use super::parse_brave_results;

    #[test]
    fn parses_brave_results() {
        let html = r#"
<div class="result-wrapper"><div class="result-content svelte-1rq4ngz">
<a href="https://career.habr.com/vacancies/frontend" target="_self" class="svelte-14r20fy l1"><div>Habr Career</div><div class="title search-snippet-title">Вакансии frontend</div></a>
<div class="generic-snippet svelte-1cwdgg3"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3">Актуальные вакансии для frontend-разработчиков.</div></div>
</div></div>
<div class="result-wrapper"><div class="result-content svelte-1rq4ngz">
<a href="https://hh.ru/vacancies/frontend" target="_self" class="svelte-14r20fy l1"><span>hh.ru — вакансии</span></a>
</div></div>
"#;
        let res = parse_brave_results(html, 8);
        assert_eq!(res.len(), 2);
        assert_eq!(res[0]["url"], "https://career.habr.com/vacancies/frontend");
        assert_eq!(res[0]["title"], "Вакансии frontend");
        assert!(res[0]["snippet"].as_str().unwrap().contains("Актуальные вакансии"));
        assert_eq!(res[1]["url"], "https://hh.ru/vacancies/frontend");
    }
}
