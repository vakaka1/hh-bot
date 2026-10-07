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
    // лимит запросов к провайдеру в минуту; 0 — без лимита
    #[serde(default)]
    rate_limit: u32,
    // модели, которые не показывать и не предлагать в списках
    #[serde(default)]
    ignored_models: Vec<String>,
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

// POST к api.hh.ru с OAuth-токеном, пустое тело (публикация резюме и т.п.)
async fn hh_post(app: &tauri::AppHandle, path: &str) -> Result<serde_json::Value, String> {
    let tokens = valid_token(app).await?;
    let resp = http_client()
        .post(format!("{}{}", HH_API_BASE, path))
        .bearer_auth(&tokens.access_token)
        .header("content-length", "0")
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let body: serde_json::Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).map_err(|e| format!("неожиданный ответ hh.ru: {}", e))?
    };
    if !status.is_success() {
        let desc = body["description"].as_str().unwrap_or("неизвестная ошибка");
        return Err(format!("hh.ru API {}: {}", status, desc));
    }
    Ok(body)
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
        // рабочий способ — внутренний endpoint hh.ru (hash = id резюме,
        // проверено на живой сессии): 200 и {"success":true}. Другие
        // маршруты (PUT /resumes/{id}/unpublish и пр.) у веб-API нет.
        "unpublish" => r#"[
              { url: '/shards/resume/edit/visibility', method: 'POST', json: { hash: __ARG__, accessType: 'no_one' }, expect: '"success":true' }
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
        const ok = r.ok && (!a.expect || t.includes(a.expect));
        results.push({ ok: ok, status: r.status, body: t.slice(0, 200) });
        if (ok) break;
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

// Опубликовать (вернуть на показ) резюме. У api.hh.ru это
// POST /resumes/{id}/publish; при частых переключениях hh.ru отвечает
// 429 «too often» — текст ошибки отдаётся пользователю как есть.
#[tauri::command]
async fn publish_resume(app: tauri::AppHandle, resume_id: String) -> Result<(), String> {
    let id = resume_id.trim();
    if id.is_empty() || id.contains('/') {
        return Err("Некорректный id резюме".into());
    }
    hh_post(&app, &format!("/resumes/{}/publish", id)).await.map(|_| ())
}

// Редактирование резюме: формы правки живут только на самом hh.ru,
// поэтому открываем видимое окно приложения со страницей резюме — там
// кнопка «Редактировать» и карточка видимости; сессия общая с приложением.
#[tauri::command]
async fn open_resume_editor(app: tauri::AppHandle, resume_id: String) -> Result<(), String> {
    let id = resume_id.trim();
    if id.is_empty() || id.contains('/') {
        return Err("Некорректный id резюме".into());
    }
    let url: tauri::Url = format!("https://hh.ru/resume/{}", id)
        .parse()
        .map_err(|_| "Некорректный адрес резюме".to_string())?;
    if let Some(w) = app.get_webview_window("resumeweb") {
        let _ = w.close();
    }
    tauri::WebviewWindowBuilder::new(&app, "resumeweb", tauri::WebviewUrl::External(url))
        .title("Редактирование резюме — hh.ru")
        .inner_size(1100.0, 900.0)
        .build()
        .map_err(|e| format!("Не удалось открыть окно hh.ru: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------- профиль пользователя (локальное хранилище)

fn profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("profile.json"))
}

// Разовая миграция старого «Обо мне» (about.json) в профиль.
// Старый файл сохраняется как about.json.bak.
fn load_profile(app: &tauri::AppHandle) -> serde_json::Value {
    let path = profile_path(app).unwrap_or_default();
    // профиль — единое хранилище знаний: список заметок-фактов. Всё, что
    // знает агент, видно и редактируемо на вкладке «Профиль»; удалил
    // заметку — агент этого больше не знает.
    let mut profile = json!({ "notes": [] });

    if let Some(p) = read_json::<serde_json::Value>(path.clone()) {
        // разовая конвертация старого профиля: структурные поля -> заметки
        let mut notes: Vec<serde_json::Value> = p["notes"].as_array().cloned().unwrap_or_default();
        let push_note = |topic: &str, text: String, notes: &mut Vec<serde_json::Value>| {
            let t = text.trim();
            if !t.is_empty() {
                notes.push(json!({ "topic": topic, "text": t, "added_at": now() }));
            }
        };
        for e in p["experience"].as_array().cloned().unwrap_or_default() {
            let mut text = String::new();
            let company = e["company"].as_str().unwrap_or("").trim().to_string();
            let position = e["position"].as_str().unwrap_or("").trim().to_string();
            let period = e["period"].as_str().unwrap_or("").trim().to_string();
            let head = [company, position, period].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" — ");
            if !head.is_empty() {
                text.push_str(&head);
                text.push_str(". ");
            }
            if let Some(d) = e["description"].as_str() {
                text.push_str(d.trim());
            }
            if let Some(a) = e["achievements"].as_str().filter(|s| !s.trim().is_empty()) {
                text.push_str(" Достижения: ");
                text.push_str(a.trim());
            }
            push_note("Опыт", text, &mut notes);
        }
        for e in p["education"].as_array().cloned().unwrap_or_default() {
            let text = ["institution", "specialty", "period"]
                .iter()
                .filter_map(|k| e[*k].as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" — ");
            push_note("Образование", text, &mut notes);
        }
        if let Some(arr) = p["skills"].as_array().filter(|a| !a.is_empty()) {
            let names: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
            if !names.is_empty() {
                push_note("Навыки", names.join(", "), &mut notes);
            }
        }
        if let Some(arr) = p["languages"].as_array().filter(|a| !a.is_empty()) {
            let names: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
            if !names.is_empty() {
                push_note("Языки", names.join(", "), &mut notes);
            }
        }
        {
            let pos = &p["positions"];
            let mut parts: Vec<String> = Vec::new();
            for key in ["desired_title", "area", "salary"] {
                if let Some(s) = pos[key].as_str().filter(|s| !s.trim().is_empty()) {
                    parts.push(s.trim().to_string());
                }
            }
            for key in ["employment", "schedule"] {
                if let Some(arr) = pos[key].as_array().filter(|a| !a.is_empty()) {
                    let names: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                    if !names.is_empty() {
                        parts.push(names.join(", "));
                    }
                }
            }
            if !parts.is_empty() {
                push_note("Условия работы", parts.join(" — "), &mut notes);
            }
        }
        if let Some(s) = p["wishes"].as_str() {
            push_note("Пожелания", s.to_string(), &mut notes);
        }
        if let Some(s) = p["about"].as_str() {
            push_note("О себе", s.to_string(), &mut notes);
        }
        profile["notes"] = json!(notes);
        let _ = write_json(path, &profile);
        return profile;
    }

    // профиля ещё нет — переносим данные из старого «Обо мне»
    if let Some(about) = read_json::<serde_json::Value>(about_path(app).unwrap_or_default()) {
        let mut notes: Vec<serde_json::Value> = Vec::new();
        {
            let mut parts: Vec<String> = Vec::new();
            for key in ["desired_title", "area", "salary"] {
                if let Some(s) = about[key].as_str().filter(|s| !s.trim().is_empty()) {
                    parts.push(s.trim().to_string());
                }
            }
            for key in ["employment", "schedule"] {
                if let Some(arr) = about[key].as_array() {
                    let names: Vec<String> = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                    if !names.is_empty() {
                        parts.push(names.join(", "));
                    }
                }
            }
            if !parts.is_empty() {
                notes.push(json!({ "topic": "Условия работы", "text": parts.join(" — "), "added_at": now() }));
            }
        }
        if let Some(s) = about["skills"].as_str() {
            let t = s.trim();
            if !t.is_empty() {
                notes.push(json!({ "topic": "Навыки", "text": t, "added_at": now() }));
            }
        }
        for (topic, key) in [("Опыт", "experience"), ("О себе", "about")] {
            if let Some(s) = about[key].as_str().filter(|s| !s.trim().is_empty()) {
                notes.push(json!({ "topic": topic, "text": s.trim(), "added_at": now() }));
            }
        }
        profile["notes"] = json!(notes);
        let _ = std::fs::rename(about_path(app).unwrap_or_default(), about_path(app).unwrap_or_default().with_extension("json.bak"));
    }
    let _ = write_json(path, &profile);
    profile
}

#[tauri::command]
fn profile_load(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(load_profile(&app))
}

#[tauri::command]
fn profile_save(app: tauri::AppHandle, data: serde_json::Value) -> Result<(), String> {
    write_json(profile_path(&app)?, &data)
}

// ---------------------------------------------------------------- agents (много провайдеров)

// ---------------------------------------------------------------- rate limiting (на провайдера)

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// Окна последних запросов по ключу провайдера (base_url)
fn rate_slots() -> &'static Mutex<HashMap<String, Vec<i64>>> {
    static SLOTS: std::sync::OnceLock<Mutex<HashMap<String, Vec<i64>>>> =
        std::sync::OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

// Ждёт, пока можно сделать следующий запрос, не превышая limit запросов
// в минуту для этого провайдера. limit == 0 — лимит не задан.
async fn rate_limit_wait(key: &str, limit: u32) {
    if limit == 0 {
        return;
    }
    loop {
        let wait_ms = {
            let mut slots = rate_slots().lock().expect("mutex");
            let cur = now_ms();
            let win = slots.entry(key.to_string()).or_default();
            win.retain(|t| cur - *t < 60_000);
            if (win.len() as u32) < limit {
                win.push(cur);
                0
            } else {
                // ждём, пока в окне не освободится место
                (60_000 - (cur - win[0]) + 50) as u64
            }
        };
        if wait_ms == 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
    }
}

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

// полная очистка истории чатов
#[tauri::command]
fn chats_clear(app: tauri::AppHandle) -> Result<(), String> {
    save_chats(&app, &Vec::new())
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
      "name": "read_profile",
      "description": "Прочитать локальный профиль пользователя: условия работы, навыки, опыт, образование, проекты, «о себе», заметки-факты. Используй, когда для ответа нужны сведения о пользователе.",
      "parameters": { "type": "object", "properties": {} }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "search_vacancies",
      "description": "Поиск вакансий на hh.ru. Возвращает список: название, зарплата, работодатель, регион, ссылка. Требует входа в hh.ru."
      "parameters": {
        "type": "object",
        "properties": {
          "text": { "type": "string", "description": "Поисковая фраза (название профессии, ключевые слова)" },
          "area": { "type": "string", "description": "Регион поиска — id или название области/города (например, Москва)" },
          "experience": { "type": "string", "enum": ["no_experience", "between1And3", "between3And6", "moreThan6"], "description": "Требуемый опыт" },
          "employment": { "type": "string", "enum": ["full", "part", "project", "internship"], "description": "Занятость" },
          "schedule": { "type": "string", "enum": ["full_day", "flexible", "remote", "hybrid", "shift", "fly_in_fly_out"], "description": "График" },
          "salary": { "type": "integer", "description": "Минимальная зарплата" },
          "only_with_salary": { "type": "boolean", "description": "Только вакансии с указанной зарплатой" },
          "search_field": { "type": "string", "enum": ["name", "company_name", "description"], "description": "Где искать: в названии, по компании или по описанию" },
          "per_page": { "type": "integer", "description": "Результатов на страницу (по умолчанию 10, максимум 50)" },
          "page": { "type": "integer", "description": "Номер страницы с нуля" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "prepare_resume_texts",
      "description": "Подготовить тексты для резюме hh.ru из локального профиля пользователя: название, ключевые навыки, описания мест работы, «О себе». Возвращает черновик для вставки в форму на hh.ru (API hh.ru не даёт создавать резюме автоматически).",
      "parameters": {
        "type": "object",
        "properties": {
          "position": { "type": "string", "description": "Название должности; по умолчанию берётся из профиля" },
          "skills": { "type": "array", "items": { "type": "string" }, "description": "Навыки для указания; по умолчанию берутся из профиля" },
          "about": { "type": "string", "description": "Текст «О себе»; по умолчанию берётся из профиля" }
        }
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
      "name": "read_resume",
      "description": "Прочитать полное содержимое резюме пользователя на hh.ru по id (id можно получить через list_resumes): навыки, опыт, образование, «О себе». Только чтение.",
      "parameters": {
        "type": "object",
        "properties": {
          "resume_id": { "type": "string" }
        },
        "required": ["resume_id"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "update_profile",
      "description": "Запомнить факты о пользователе: опыт, навыки, учёбу, желания, обстоятельства жизни. Каждый факт — отдельный элемент notes_add, конкретно и без сокращений. Пользователь видит и удаляет эти факты на вкладке «Профиль».",
      "parameters": {
        "type": "object",
        "properties": {
          "notes_add": { "type": "array", "items": { "type": "string" }, "description": "Факты о пользователе, по одному на элемент" },
          "notes_topic": { "type": "string", "description": "Общая тема для добавляемых фактов (например, «Опыт», «Навыки», «Пожелания», «семья»)" }
        },
        "required": ["notes_add"]
      }
    }
  },
    {
    "type": "function",
    "function": {
      "name": "unpublish_resume",
      "description": "Снять резюме с публикации на hh.ru (работодатели перестанут его видеть). Влияет на видимость резюме!",
      "parameters": {
        "type": "object",
        "properties": {
          "resume_id": { "type": "string" }
        },
        "required": ["resume_id"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "publish_resume",
      "description": "Опубликовать резюме на hh.ru — вернуть его на показ работодателям (видимость «видно всем»). Влияет на видимость резюме!",
      "parameters": {
        "type": "object",
        "properties": {
          "resume_id": { "type": "string" }
        },
        "required": ["resume_id"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit_resume",
      "description": "Открыть окно редактирования резюме на hh.ru (название, опыт, навыки, зарплата и т.д.). api.hh.ru не умеет менять содержимое резюме, поэтому правка делается пользователем в открывшемся окне. Сообщи пользователю, что окно открыто.",
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
    matches!(
        name,
        "set_theme" | "navigate" | "update_profile" | "unpublish_resume" | "publish_resume" | "edit_resume"
    )
}

async fn tool_list_resumes(app: &tauri::AppHandle) -> Result<String, String> {
    let data = hh_get(app, "/resumes/mine").await?;
    let items: Vec<serde_json::Value> = data["items"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    let hidden = r["access"]["type"]["id"] == "no_one";
                    let status_id = r["status"]["id"].as_str().unwrap_or("");
                    let status = if hidden {
                        "снято с публикации (не видно работодателям)"
                    } else {
                        r["status"]["name"].as_str().unwrap_or(status_id)
                    };
                    serde_json::json!({
                        "id": r["id"],
                        "title": r["title"],
                        "status": status,
                        "hidden": hidden,
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

async fn tool_publish_resume(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let id = args["resume_id"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("нет параметра resume_id")?;
    hh_post(app, &format!("/resumes/{}/publish", id)).await?;
    Ok("Резюме опубликовано на hh.ru (видимость «видно всем»).".into())
}

async fn tool_edit_resume(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let id = args["resume_id"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("нет параметра resume_id")?;
    open_resume_editor(app.clone(), id.to_string()).await?;
    Ok("Открыл окно редактирования резюме на hh.ru.".into())
}

// ---------------------------------------------------------------- новые hh-инструменты

async fn tool_search_vacancies(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let mut params: Vec<(String, String)> = vec![
        ("per_page".into(), args["per_page"].as_u64().unwrap_or(10).clamp(1, 50).to_string()),
        ("page".into(), args["page"].as_u64().unwrap_or(0).to_string()),
    ];
    for key in ["text", "area", "experience", "employment", "schedule", "search_field"] {
        let v = &args[key];
        let vals: Vec<String> = match v {
            serde_json::Value::String(s) if !s.trim().is_empty() => vec![s.trim().to_string()],
            serde_json::Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect(),
            _ => vec![],
        };
        for val in vals {
            params.push((key.to_string(), val));
        }
    }
    if let Some(s) = args["salary"].as_u64() {
        params.push(("salary".into(), s.to_string()));
    }
    if args["only_with_salary"].as_bool().unwrap_or(false) {
        params.push(("only_with_salary".into(), "true".into()));
    }
    let query: String = params
        .iter()
        .map(|(k, v)| {
            let enc = v.bytes().map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                b' ' => "+".to_string(),
                _ => format!("%{:02X}", b),
            }).collect::<String>();
            format!("{}={}", k, enc)
        })
        .collect::<Vec<_>>()
        .join("&");

    let data = hh_get(app, &format!("/vacancies?{}", query)).await?;
    let total = data["found"].as_u64().unwrap_or(0);
    let items: Vec<String> = data["items"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|v| {
            let salary = match (&v["salary"]["from"], &v["salary"]["to"]) {
                (f, t) if f.is_null() && t.is_null() => String::new(),
                (f, t) => format!(
                    " — {}",
                    [
                        f.as_u64().map(|x| format!("от {}", x)),
                        t.as_u64().map(|x| format!("до {}", x)),
                        v["salary"]["currency"].as_str().map(|c| c.to_string()),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ")
                ),
            };
            let snippet = v["snippet"]["requirement"]
                .as_str()
                .map(|s| {
                    let s = s.replace("<highlighttext>", "");
                    let s = s.replace("</highlighttext>", "");
                    format!(" | {}", s.chars().take(200).collect::<String>())
                })
                .unwrap_or_default();
            format!(
                "- {}{} | работодатель: {} | регион: {}{}\n  {}",
                v["name"].as_str().unwrap_or("?"),
                salary,
                v["employer"]["name"].as_str().unwrap_or("?"),
                v["area"]["name"].as_str().unwrap_or("?"),
                snippet,
                v["alternate_url"].as_str().unwrap_or("")
            )
        })
        .collect();
    if items.is_empty() {
        return Ok(format!("Вакансий не найдено (запрос: {}).", query));
    }
    Ok(format!(
        "Найдено вакансий: {}. Показаны {} (страница {}).\n\n{}",
        total,
        items.len(),
        args["page"].as_u64().unwrap_or(0),
        items.join("\n")
    ))
}

async fn tool_read_resume(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let id = args["resume_id"]
        .as_str()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("нет параметра resume_id")?;
    let r = hh_get(app, &format!("/resumes/{}", id)).await?;
    let mut out = String::new();
    let title = r["title"].as_str().unwrap_or("(без названия)");
    out.push_str(&format!("Резюме «{}» (id: {})\n", title, id));
    out.push_str(&format!("Статус: {}. Обновлено: {}\n", r["status"]["name"].as_str().unwrap_or("?"), r["updated_at"].as_str().unwrap_or("").get(..10).unwrap_or("")));
    // условия — в тех же полях, что и в резюме hh.ru
    if let Some(a) = r["salary"].as_u64().or(r["salary"]["amount"].as_u64()) {
        out.push_str(&format!("Зарплата: {} {}\n", a, r["salary"]["currency"].as_str().unwrap_or("RUR")));
    }
    if let Some(s) = r["area"]["name"].as_str() {
        out.push_str(&format!("Город: {}\n", s));
    }
    let employment: Vec<&str> = r["employment"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect()).unwrap_or_default();
    if !employment.is_empty() {
        out.push_str(&format!("Занятость: {}\n", employment.join(", ")));
    }
    let schedule: Vec<&str> = r["schedule"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect()).unwrap_or_default();
    if !schedule.is_empty() {
        out.push_str(&format!("График: {}\n", schedule.join(", ")));
    }
    let skills: Vec<&str> = r["skill_set"].as_array().map(|a| a.iter().filter_map(|s| s.as_str()).collect()).unwrap_or_default();
    if !skills.is_empty() {
        out.push_str(&format!("Ключевые навыки: {}\n", skills.join(", ")));
    }
    if let Some(s) = r["about"].as_str().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("\nО себе:\n{}\n", s.trim()));
    }
    // описания опыта не обрезаем — агент переносит их в профиль целиком
    if let Some(items) = r["experience"].as_array().filter(|a| !a.is_empty()) {
        out.push_str("\nОпыт:\n");
        for e in items {
            out.push_str(&format!(
                "\n### {} | {} | {} — {}\n",
                e["company"].as_str().unwrap_or("?"),
                e["position"].as_str().unwrap_or("?"),
                e["start"].as_str().unwrap_or("?").get(..7).unwrap_or(""),
                if e["current"].as_bool().unwrap_or(false) { "сейчас".into() } else { e["end"].as_str().unwrap_or("?").get(..7).unwrap_or("").to_string() }
            ));
            if let Some(s) = e["company_url"].as_str() {
                out.push_str(&format!("Сайт компании: {}\n", s));
            }
            if let Some(s) = e["description"].as_str().filter(|s| !s.trim().is_empty()) {
                let text: String = strip_tags(s).split_whitespace().collect::<Vec<_>>().join(" ");
                let text = text.chars().take(8000).collect::<String>();
                out.push_str(&text);
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
    }
    if let Some(items) = r["education"]["main"].as_array().filter(|a| !a.is_empty()) {
        out.push_str("\nОбразование:\n");
        for e in items {
            out.push_str(&format!(
                "- {} | {} | {}{}{}\n",
                e["name"].as_str().unwrap_or("?"),
                e["organization"].as_str().unwrap_or(""),
                e["year"].as_u64().map(|y| y.to_string()).unwrap_or_default(),
                e["specialty"].as_str().map(|s| format!(" | {}", s)).unwrap_or_default(),
                e["level"]["name"].as_str().map(|s| format!(" | {}", s)).unwrap_or_default()
            ));
        }
    }
    if let Some(items) = r["language"].as_array().filter(|a| !a.is_empty()) {
        let langs: Vec<String> = items
            .iter()
            .map(|l| {
                format!(
                    "{} — {}",
                    l["name"].as_str().unwrap_or("?"),
                    l["level"]["name"].as_str().unwrap_or("?")
                )
            })
            .collect();
        out.push_str(&format!("\nЯзыки: {}\n", langs.join(", ")));
    }
    if let Some(s) = r["citizenship"].as_array().map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty()) {
        out.push_str(&format!("Гражданство: {}\n", s));
    }
    Ok(out)
}

// Готовые тексты для резюме hh.ru из локального профиля. API hh.ru не
// даёт создавать и редактировать резюме, поэтому агент готовит тексты,
// которые пользователь вставляет в форму на hh.ru.
fn tool_prepare_resume_texts(args: &serde_json::Value) -> Result<String, String> {
    let position = args["position"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(укажите желаемую должность)".into());
    let skills: Vec<String> = args["skills"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s.as_str().map(|x| x.to_string())).collect())
        .unwrap_or_default();
    let about = args["about"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(нет текста — возьми из знаний о пользователе через read_profile)".into());
    let mut out = String::new();
    out.push_str(&format!("## Черновик резюме: {}\n\n", position));
    out.push_str("### Название резюме\n");
    out.push_str(&format!("{}\n\n", position));
    out.push_str("### Ключевые навыки (через запятую)\n");
    if skills.is_empty() {
        out.push_str("(не переданы — возьми навыки из знаний о пользователе через read_profile)\n\n");
    } else {
        out.push_str(&format!("{}\n\n", skills.join(", ")));
    }
    out.push_str("### О себе\n");
    out.push_str(&format!("{}\n", about));
    out.push_str("\nОпыт работы опиши по местам работы из знаний о пользователе (read_profile).\n");
    out.push_str("Тексты готовы для вставки в форму резюме на hh.ru (Создать резюме / Редактировать).");
    Ok(out)
}

async fn tool_update_profile(app: &tauri::AppHandle, args: &serde_json::Value) -> Result<String, String> {
    let mut profile = load_profile(app);
    let notes = profile["notes"].as_array_mut().ok_or("повреждён профиль")?;
    let topic = args["notes_topic"].as_str().unwrap_or("").trim().to_string();
    let mut n = 0;
    if let Some(items) = args["notes_add"].as_array() {
        for v in items {
            let text = v.as_str().map(|s| s.trim()).unwrap_or("");
            if text.is_empty() {
                continue;
            }
            notes.push(json!({
                "topic": if topic.is_empty() { serde_json::Value::Null } else { json!(topic) },
                "text": text,
                "added_at": now(),
            }));
            n += 1;
        }
    }
    if n == 0 {
        return Ok("Ничего не сохранено: не передано ни одного факта.".into());
    }
    write_json(profile_path(app)?, &profile)?;
    Ok(format!("Сохранено в знания: фактов {}. Удалять заметки пользователь может на вкладке «Профиль».", n))
}

// человекочитаемый список знаний для агента (read_profile и системный промпт)
fn profile_brief(profile: &serde_json::Value, max_notes: usize) -> String {
    let Some(notes) = profile["notes"].as_array() else {
        return "Знаний о пользователе пока нет.\n".into();
    };
    if notes.is_empty() {
        return "Знаний о пользователе пока нет.\n".into();
    }
    let skip = notes.len().saturating_sub(max_notes);
    let mut out = format!(
        "## Знания о пользователе{}\n\n",
        if skip > 0 { format!(" (последние {} из {})", notes.len() - skip, notes.len()) } else { String::new() }
    );
    for n in &notes[skip..] {
        let topic = n["topic"].as_str().unwrap_or("");
        let prefix = if topic.is_empty() { String::new() } else { format!("[{}] ", topic) };
        out.push_str(&format!("- {}{}\n", prefix, n["text"].as_str().unwrap_or("")));
    }
    out
}

async fn tool_read_profile(app: &tauri::AppHandle) -> Result<String, String> {
    Ok(profile_brief(&load_profile(app), 100))
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
        "read_resume" => tool_read_resume(app, args).await,
        "read_profile" => tool_read_profile(app).await,
        "update_profile" => tool_update_profile(app, args).await,
        "search_vacancies" => tool_search_vacancies(app, args).await,
        "prepare_resume_texts" => tool_prepare_resume_texts(args),
        "unpublish_resume" => tool_unpublish_resume(app, args).await,
        "publish_resume" => tool_publish_resume(app, args).await,
        "edit_resume" => tool_edit_resume(app, args).await,
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
        // hh.ru у скрытого резюме продолжает отдавать status «опубликовано»,
        // реальная видимость живёт в access.type.id
        let hidden = r["access"]["type"]["id"] == "no_one";
        let status = if hidden {
            "снято с публикации (не видно работодателям)".to_string()
        } else {
            r["status"]["name"].as_str().unwrap_or("").to_string()
        };
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

fn build_system_prompt(app: &tauri::AppHandle, model: &str) -> String {
    let profile = load_profile(app);

    let now_dt = chrono::Local::now();
    let weekdays = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
    let wd = weekdays[now_dt.weekday().num_days_from_monday() as usize];
    let mut p = format!(
        "Сегодня: {}, {}. У тебя есть инструмент current_datetime — проверяй дату, когда важна актуальность.\n\n",
        now_dt.format("%d.%m.%Y"),
        wd
    );
    let model_display = if model.trim().is_empty() { "неизвестной ИИ-модели" } else { model.trim() };
    p.push_str(&format!(
        "## Кто ты\n\n\
Ты — ИИ-агент внутри приложения HH-bot. Ты работаешь на {model_display}. \
Если пользователь спросит, кто ты или на какой модели ты работаешь, отвечай честно и прямо: \
«Я ИИ-агент, работающий на модели {model_display} внутри приложения HH-bot». \
Помогаешь пользователю с любыми задачами: отвечаешь на вопросы, ищешь информацию в интернете, \
объясняешь, пишешь тексты, а также умеешь работать с hh.ru и профилем пользователя (подробности ниже). \
Ты НЕ зациклен на поиске работы: темами труда занимаешься только когда пользователь сам \
об этом попросит, и не навязываешь вакансии, отклики и советы по резюме без запроса. \
Отвечай на русском языке, по делу, структурировано, просто и по-человечески. \
Используй Markdown: заголовки, списки, таблицы, блоки кода — где это уместно. \
Когда нужны актуальные данные, пользуйся инструментами web_search и fetch_url — \
сначала ищи, потом отвечай, не выдумывай факты и ссылки.\n\n\
## Твоя работа на hh.ru\n\n\
Ты работаешь на hh.ru от имени пользователя: под его аккаунтом ищешь вакансии, \
смотришь его резюме, готовишь тексты для форм hh.ru. Действия, влияющие на аккаунт \
(публикация, статус поиска), делаешь только с явного согласия пользователя. \
Когда пользователь просит что-то сделать на hh.ru, прямо говори, что делаешь это от его имени.\n\n\
## Что ты знаешь о пользователе\n\n",
    ));
    p.push_str(&profile_brief(&profile, 40));
    // имя и резюме из hh.ru
    {
        let cache = profile_cache().lock().expect("mutex").clone();
        let full_name = ["last_name", "first_name", "middle_name"]
            .iter()
            .filter_map(|k| cache["me"][k].as_str())
            .collect::<Vec<_>>()
            .join(" ");
        if !full_name.trim().is_empty() {
            p.push_str(&format!("\nПользователя зовут: {} (данные hh.ru).\n", full_name.trim()));
        }
        p.push_str(&resumes_summary(&cache["resumes"]));
    }
    p.push_str(
        "\n## Как пополнять знания о пользователе\n\n\
Ты должен знать о пользователе как можно больше — это твоя база для любых его просьб. \
Все знания хранятся в одном месте — заметками, и пользователь видит и удаляет их \
на вкладке «Профиль»: удалил заметку — ты этого больше не знаешь. Поэтому всё, что он \
рассказывает (опыт, навыки, учёбу, желания, обстоятельства), сохраняй через update_profile: \
каждый факт — отдельная заметка с темой («Опыт», «Навыки», «Пожелания», «семья» и т.п.), \
конкретно и без сокращений. Сохраняй только то, что пользователь реально сообщил, без домыслов. \
После сохранения кратко упомяни, что запомнил. Полный список знаний читай инструментом read_profile. \
Эти знания — рабочий материал, а не тема для разговора: не пересказывай пользователю его же данные \
(имя, статус поиска, содержимое знаний), пока он сам не спросил или это не нужно по делу \
(например, при составлении резюме). Просто используй их, чтобы отвечать точнее и без лишних вопросов.\n\n\
Ты можешь сам узнавать пользователя в стиле интервью: когда разговор естественно заходит \
о нём или данных явно не хватает, задавай короткие вопросы — 1–3 за раз, не анкету из \
десяти пунктов, и сразу складывай ответы в знания. Не превращай каждый чат в собеседование: \
спрашивай только тогда, когда это уместно и действительно пригодится.\n\n\
## Работа с hh.ru\n\n\
По просьбе пользователя:\n\
- ищи вакансии через search_vacancies;\n\
- смотри резюме через list_resumes и read_resume;\n\
- готовь тексты для формы резюме из знаний о пользователе через prepare_resume_texts \
(автоматического создания резюме у hh.ru нет — пользователь вставит их в форму сам);\n\
- при подборе вакансий учитывай знания о пользователе, но уточняй, \
если запрос неполный.\n",
    );
    p
}

// ---------------------------------------------------------------- стриминг Responses API с инструментами

struct StepResult {
    content: String,
    // вызовы инструментов в формате Responses API: call_id, name, arguments
    function_calls: Vec<serde_json::Value>,
}

// один шаг стриминга Responses API; возвращает текст и вызовы инструментов
async fn stream_step(
    base: &str,
    api_key: &str,
    model: &str,
    instructions: &str,
    input: &[serde_json::Value],
    tools: &serde_json::Value,
    cancelled: &AtomicBool,
    on_delta: &(dyn Fn(&str) + Send + Sync),
    on_reasoning: &(dyn Fn(&str) + Send + Sync),
) -> Result<StepResult, String> {
    let body = serde_json::json!({
        "model": model,
        "instructions": instructions,
        "input": input,
        "stream": true,
        "tools": tools,
    });

    let mut resp = http_client()
        .post(format!("{}/responses", base))
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
            .and_then(|v| {
                v["error"]["message"].as_str().map(|s| s.to_string())
                    .or_else(|| v["message"].as_str().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("Провайдер вернул {}: {}", status, msg));
    }

    let mut content = String::new();
    // вызовы инструментов накапливаем по item_id из событий; финальный
    // список берём из response.completed, если провайдер его прислал
    struct PendingCall {
        call_id: String,
        name: String,
        args: String,
    }
    let mut pending: Vec<(String, PendingCall)> = Vec::new(); // (item_id, call)
    let mut final_calls: Option<Vec<serde_json::Value>> = None;

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
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            let event_type = v["type"].as_str().unwrap_or("");
            match event_type {
                "response.output_text.delta" => {
                    if let Some(c) = v["delta"].as_str() {
                        if !c.is_empty() {
                            content.push_str(c);
                            on_delta(c);
                        }
                    }
                }
                // «думающие» модели: полные размышления и их краткая сводка
                "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                    if let Some(c) = v["delta"].as_str() {
                        if !c.is_empty() {
                            on_reasoning(c);
                        }
                    }
                }
                "response.output_item.added" => {
                    let item = &v["item"];
                    if item["type"] == "function_call" {
                        let item_id = item["id"].as_str().unwrap_or("").to_string();
                        pending.push((
                            item_id.clone(),
                            PendingCall {
                                call_id: item["call_id"].as_str().unwrap_or(&item_id).to_string(),
                                name: item["name"].as_str().unwrap_or("").to_string(),
                                args: item["arguments"].as_str().unwrap_or("").to_string(),
                            },
                        ));
                    }
                }
                "response.function_call_arguments.delta" => {
                    let item_id = v["item_id"].as_str().unwrap_or("");
                    if let Some(d) = v["delta"].as_str() {
                        if let Some((_, call)) = pending.iter_mut().rev().find(|(id, _)| id == item_id) {
                            call.args.push_str(d);
                        } else if let Some((_, call)) = pending.last_mut() {
                            call.args.push_str(d);
                        }
                    }
                }
                "response.output_item.done" => {
                    // финальные аргументы вызова (перекрывают накопленные дельты)
                    let item = &v["item"];
                    if item["type"] == "function_call" {
                        let item_id = item["id"].as_str().unwrap_or("").to_string();
                        let call_id = item["call_id"].as_str().unwrap_or(&item_id).to_string();
                        let name = item["name"].as_str().unwrap_or("").to_string();
                        let args = item["arguments"].as_str().unwrap_or("").to_string();
                        if let Some((_, call)) = pending.iter_mut().rev().find(|(id, _)| *id == item_id) {
                            call.call_id = call_id;
                            call.name = name;
                            call.args = args;
                        } else {
                            pending.push((item_id, PendingCall { call_id, name, args }));
                        }
                    }
                }
                "response.completed" | "response.incomplete" => {
                    let output = &v["response"]["output"];
                    if let Some(items) = output.as_array() {
                        let calls: Vec<serde_json::Value> = items
                            .iter()
                            .filter(|it| it["type"] == "function_call")
                            .map(|it| {
                                let item_id = it["id"].as_str().unwrap_or("");
                                serde_json::json!({
                                    "call_id": it["call_id"].as_str().unwrap_or(item_id),
                                    "name": it["name"],
                                    "arguments": it["arguments"].as_str().unwrap_or(""),
                                })
                            })
                            .collect();
                        final_calls = Some(calls);
                    }
                }
                "response.failed" | "error" | "response.error" => {
                    let msg = v["response"]["status_details"]["error"]["message"]
                        .as_str()
                        .or_else(|| v["response"]["error"]["message"].as_str())
                        .or_else(|| v["message"].as_str())
                        .or_else(|| v["error"]["message"].as_str())
                        .unwrap_or("неизвестная ошибка провайдера");
                    return Err(format!("Провайдер: {}", msg));
                }
                _ => {}
            }
        }
    }

    let function_calls = final_calls
        .unwrap_or_else(|| {
            pending
                .into_iter()
                .filter(|(_, c)| !c.name.is_empty())
                .map(|(_, c)| {
                    serde_json::json!({
                        "call_id": c.call_id,
                        "name": c.name,
                        "arguments": c.args,
                    })
                })
                .collect()
        })
        .into_iter()
        .filter(|c| !c["name"].as_str().unwrap_or("").is_empty())
        .collect();

    Ok(StepResult { content, function_calls })
}

#[tauri::command]
async fn chat_start(
    app: tauri::AppHandle,
    chat_id: String,
    message: String,
    model: Option<String>,
    mode: Option<String>,
    provider: Option<usize>,
    on_event: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let mode = mode.unwrap_or_else(|| "chat".into());
    let store: AgentStore = read_json(agents_path(&app)?).ok_or("Провайдеры не настроены")?;
    // провайдер выбирается под модель: если модель чужого провайдера —
    // запрос пойдёт к нему, а не к активному
    let (_, active) = match provider.and_then(|i| store.providers.get(i).cloned().map(|p| (i, p))) {
        Some((i, p)) => (i, p),
        None => match store.active.and_then(|i| store.providers.get(i).cloned()).map(|p| (store.active.unwrap_or(0), p)) {
            Some(x) => x,
            None => return Err("Не выбран ИИ-провайдер — добавьте его в Настройках".into()),
        },
    };
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
        active.rate_limit,
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
    rate_limit: u32,
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

    // ---- цикл агента (Responses API: instructions + input-элементы)
    let instructions = build_system_prompt(app, model);
    // content — простая строка: часть OpenAI-совместимых серверов (vLLM и др.)
    // не принимает массив частей, а строка валидна и для OpenAI
    let to_user_item = |text: &str| -> serde_json::Value {
        serde_json::json!({ "role": "user", "content": text })
    };
    let to_assistant_item = |text: &str| -> serde_json::Value {
        serde_json::json!({ "role": "assistant", "content": text })
    };
    let mut input: Vec<serde_json::Value> = Vec::new();
    // history — только user/assistant с непустым текстом, в хронологическом порядке
    for m in &history {
        let role = m["role"].as_str().unwrap_or("");
        let text = m["content"].as_str().unwrap_or("");
        if text.trim().is_empty() {
            continue;
        }
        input.push(if role == "assistant" { to_assistant_item(text) } else { to_user_item(text) });
    }
    input.push(to_user_item(message));

    // набор инструментов зависит от режима:
    //   chat — только поиск в сети; confirm/full — плюс действия в приложении
    // объявления инструментов в TOOLS_JSON даны во вложенном формате
    // chat/completions; приводим к плоскому формату Responses API
    // ({type, name, description, parameters})
    let collect_tools = |src: &str| -> Vec<serde_json::Value> {
        serde_json::from_str::<serde_json::Value>(src)
            .unwrap_or(json!([]))
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|t| {
                // из вложенного формата chat/completions в плоский Responses
                match t.get("function").cloned() {
                    Some(f) => json!({
                        "type": "function",
                        "name": f["name"],
                        "description": f["description"],
                        "parameters": f["parameters"],
                    }),
                    None => t,
                }
            })
            .collect()
    };
    let mut tools = collect_tools(TOOLS_JSON);
    if mode == "confirm" || mode == "full" {
        tools.extend(collect_tools(APP_TOOLS_JSON));
    }
    let tools = json!(tools);

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
            // каждый шаг — один запрос к провайдеру, вписываемся в его лимит
            rate_limit_wait(base, rate_limit).await;
            let log = &parts_log;
            stream_step(
                base,
                api_key,
                model,
                &instructions,
                &input,
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
            Ok(r) => r,
            Err(e) => break Err(e),
        };

        if !result.function_calls.is_empty() {
            // текст перед вызовами инструментов уже отдан дельтами; в input
            // ничего не добавляем — ответы уходят как function_call_output
            for call in &result.function_calls {
                let name = call["name"].as_str().unwrap_or("?").to_string();
                let args_s = call["arguments"].as_str().unwrap_or("{}").to_string();
                let args: serde_json::Value = serde_json::from_str(&args_s).unwrap_or(json!({}));
                let call_id = call["call_id"].as_str().unwrap_or("call").to_string();

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
                    input.push(serde_json::json!({
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": "Пользователь отклонил это действие. Не повторяй его без явной просьбы.",
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
                input.push(serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
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
            publish_resume,
            open_resume_editor,
            profile_load,
            profile_save,
            agents_load,
            agents_save,
            agent_test,
            chats_list,
            chat_get,
            chat_delete,
            chats_clear,
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
