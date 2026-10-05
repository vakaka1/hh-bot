#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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
    hh_get(&app, "/me").await
}

#[tauri::command]
async fn get_resumes(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    hh_get(&app, "/resumes/mine").await
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
            agents_load,
            agents_save,
            agent_test,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска HH-bot");
}
