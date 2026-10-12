//! Resume writes use the applicant API. Creation is never automatically retried.
use super::*;
use tauri::Emitter;

pub(crate) fn valid_id(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Некорректный id резюме".into());
    }
    Ok(id)
}
fn payload(args: &serde_json::Value, creating: bool) -> Result<serde_json::Value, String> {
    let mut data = args["resume"]
        .as_object()
        .cloned()
        .ok_or("Нужен объект resume")?;
    const FIELDS: &[&str] = &[
        "title",
        "first_name",
        "last_name",
        "middle_name",
        "birth_date",
        "gender",
        "area",
        "contact",
        "site",
        "professional_roles",
        "salary",
        "employment_form",
        "work_format",
        "employments",
        "schedules",
        "education",
        "language",
        "experience",
        "skills",
        "skill_levels",
        "skill_set",
        "citizenship",
        "work_ticket",
        "travel_time",
        "relocation",
        "business_trip_readiness",
        "driver_license_types",
        "has_vehicle",
        "resume_locale",
    ];
    if data.is_empty() {
        return Err("Нужны поля резюме для сохранения".into());
    }
    let unsupported: Vec<&str> = data
        .keys()
        .filter(|k| !FIELDS.contains(&k.as_str()))
        .map(String::as_str)
        .collect();
    if !unsupported.is_empty() {
        return Err(format!(
            "Неподдерживаемые поля резюме: {}. Видимость меняй отдельными инструментами.",
            unsupported.join(", ")
        ));
    }
    if let Some(levels) = data.get("skill_levels") {
        validate_skill_levels(levels)?;
    }
    if let Some(education) = data.get_mut("education") {
        normalize_education(education)?;
    }
    for field in ["work_format", "employment_form"] {
        if let Some(values) = data.get(field) {
            if !values
                .as_array()
                .map(|items| {
                    !items.is_empty()
                        && items.iter().all(|item| {
                            item["id"]
                                .as_str()
                                .map(|id| !id.is_empty())
                                .unwrap_or(false)
                        })
                })
                .unwrap_or(false)
            {
                return Err(format!(
                    "{} должен содержать список объектов с id из справочника hh.ru",
                    field
                ));
            }
        }
    }
    if creating || data.contains_key("title") {
        let title = data
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !(2..=100).contains(&title.chars().count()) {
            return Err("Название должности должно содержать 2–100 символов".into());
        }
    }
    if creating {
        data.insert("access".into(), json!({"type":{"id":"no_one"}}));
    }
    Ok(json!(data))
}
fn normalize_education(education: &mut serde_json::Value) -> Result<(), String> {
    let data = education
        .as_object_mut()
        .ok_or("education должен быть объектом")?;
    if let Some(level) = data.get("level") {
        if level["id"].as_str().is_none() {
            return Err("education.level должен быть объектом {id}, а не строкой".into());
        }
    }
    for group in ["primary", "elementary", "additional", "attestation"] {
        if let Some(items) = data.get_mut(group) {
            let items = items
                .as_array_mut()
                .ok_or_else(|| format!("education.{} должен быть массивом", group))?;
            for (index, item) in items.iter_mut().enumerate() {
                let entry = item
                    .as_object_mut()
                    .ok_or("Учебное заведение должно быть объектом")?;
                if entry
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|v| v.trim().is_empty())
                    .unwrap_or(true)
                {
                    return Err(format!(
                        "education.{}[{}].name: укажи название учебного заведения",
                        group, index
                    ));
                }
                if group == "primary"
                    && entry
                        .get("education_level")
                        .and_then(|v| v["id"].as_str())
                        .is_none()
                {
                    return Err(format!("education.primary[{}].education_level: у каждого учебного заведения нужен собственный уровень {{id}} (например bachelor или special_secondary). Общий education.level его не заменяет.",index));
                }
                if let Some(year) = entry.get("year").and_then(|v| v.as_str()) {
                    let year = year
                        .parse::<u32>()
                        .map_err(|_| "Год окончания должен быть числом")?;
                    entry.insert("year".into(), json!(year));
                }
                if entry.get("year").and_then(|v| v.as_u64()).is_none() {
                    return Err(format!(
                        "education.{}[{}].year: укажи год окончания числом",
                        group, index
                    ));
                }
                entry.entry("id").or_insert(serde_json::Value::Null);
            }
        }
    }
    Ok(())
}
fn response_body(
    status: reqwest::StatusCode,
    text: &str,
    location: Option<&str>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::from_str::<serde_json::Value>(text).unwrap_or(json!({}));
    if !status.is_success() {
        let details = body
            .get("errors")
            .map(|v| v.to_string())
            .unwrap_or_else(|| text.chars().take(1200).collect());
        return Err(format!(
            "hh.ru API {}: {} {}",
            status,
            body["description"].as_str().unwrap_or("Запрос отклонён"),
            details
        ));
    }
    if let Some(location) = location {
        let path = location
            .split('?')
            .next()
            .unwrap_or(location)
            .trim_end_matches('/');
        if let Some(id) = path.rsplit('/').next().and_then(|id| valid_id(id).ok()) {
            if !body.is_object() {
                body = json!({});
            }
            body["id"] = json!(id);
        }
    }
    Ok(body)
}
async fn write(
    app: &tauri::AppHandle,
    method: reqwest::Method,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let tokens = valid_token(app).await?;
    let response = http_client().request(method, format!("{}{}", HH_API_BASE, path))
        .bearer_auth(&tokens.access_token).json(body).timeout(std::time::Duration::from_secs(40))
        .send().await.map_err(|e| format!("Не удалось получить ответ hh.ru: {}. Исход запроса неизвестен; проверь список резюме перед повторением.", e))?;
    let status = response.status();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let text = response.text().await.map_err(|e| {
        format!(
            "Ответ hh.ru не прочитан: {}. Проверь список резюме перед повторением.",
            e
        )
    })?;
    response_body(status, &text, location.as_deref())
}
fn changed(app: &tauri::AppHandle) {
    profile_cache().lock().expect("mutex")["resumes"] = json!({});
    let _ = app.emit("resumes-changed", ());
}
// The Android applicant API uses a profile wizard, not POST /resumes.
const ANDROID_API_UA: &str = "ru.hh.android/7.130.14000, Device: SM-A556B, Android OS: 14";
fn mobile_request(
    client: &reqwest::Client,
    token: &str,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .bearer_auth(token)
        .header(reqwest::header::USER_AGENT, ANDROID_API_UA)
        .header("X-HH-App-Active", "true")
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(std::time::Duration::from_secs(40))
}
async fn mobile(
    app: &tauri::AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let tokens = valid_token(app).await?;
    let client = http_client();
    let request = mobile_request(
        &client,
        &tokens.access_token,
        method,
        &format!("{}{}", HH_API_BASE, path),
    );
    let response = if let Some(body) = body { request.json(body) } else { request }.send().await
        .map_err(|e| format!("Ответ мобильного API hh.ru не получен: {}. Проверь список резюме перед повторным созданием.", e))?;
    let status = response.status();
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let text = response
        .text()
        .await
        .map_err(|e| format!("Ответ мобильного API hh.ru не прочитан: {}", e))?;
    response_body(status, &text, location.as_deref())
}
fn mobile_resume_id(response: &serde_json::Value) -> Result<&str, String> {
    response["resume"]["id"]
        .as_str()
        .or_else(|| response["id"].as_str())
        .ok_or_else(|| {
            "Мобильный API не вернул id черновика. Не создавай повторно: проверь list_resumes."
                .to_string()
        })
        .and_then(valid_id)
}
fn mobile_screen_body(
    data: &serde_json::Value,
    screen: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = screen["screen_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Мобильный API не вернул screen_id")?;
    // Only fields present in the server's screen are sent; omitted arrays stay intact.
    let fields = screen["fields_options"]
        .as_object()
        .ok_or("Мобильный API не вернул поля шага")?;
    let mut resume = serde_json::Map::new();
    let mut profile = serde_json::Map::new();
    const PROFILE_FIELDS: &[&str] = &[
        "first_name",
        "last_name",
        "middle_name",
        "birth_date",
        "gender",
        "area",
        "citizenship",
        "work_ticket",
        "education",
        "experience",
        "language",
        "relocation",
        "has_vehicle",
        "driver_license_types",
    ];
    for (key, options) in fields {
        if options["visibility"] == "hide" {
            continue;
        }
        if let Some(value) = data.get(key) {
            resume.insert(key.clone(), value.clone());
            if PROFILE_FIELDS.contains(&key.as_str()) {
                profile.insert(key.clone(), value.clone());
            }
        }
    }
    Ok(json!({"current_screen_id":id,"resume":resume,"profile":profile}))
}
async fn fill_mobile(
    app: &tauri::AppHandle,
    id: &str,
    data: &serde_json::Value,
    initial: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let screens = initial["screens"]
        .as_array()
        .ok_or("Мобильный API не вернул шаги заполнения")?
        .clone();
    let mut latest = initial;
    let mut sent = std::collections::HashSet::new();
    for screen in &screens {
        let body = mobile_screen_body(data, screen)?;
        if body["resume"]
            .as_object()
            .map(|v| v.is_empty())
            .unwrap_or(true)
        {
            continue;
        }
        for key in body["resume"].as_object().unwrap().keys() {
            sent.insert(key.clone());
        }
        latest = mobile(
            app,
            reqwest::Method::PUT,
            &format!("/resume_profile/{}", id),
            Some(&body),
        )
        .await?;
    }
    // Optional fields that do not have a separate screen are saved with the common screen.
    let remainder: serde_json::Map<String, serde_json::Value> = data
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| {
            !matches!(key.as_str(), "access" | "skill_levels") && !sent.contains(*key)
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !remainder.is_empty() {
        let common = screens
            .iter()
            .find(|s| s["screen_id"] == "common")
            .ok_or("Мобильный API не вернул основной шаг для дополнительных полей")?;
        let body = json!({"current_screen_id":common["screen_id"],"resume":remainder});
        latest = mobile(
            app,
            reqwest::Method::PUT,
            &format!("/resume_profile/{}", id),
            Some(&body),
        )
        .await?;
    }
    // Read back before reporting success: the mobile API can ignore an unsupported field.
    if let Some(levels) = data.get("skill_levels") {
        set_skill_levels(app, &json!({"resume_id":id,"levels":levels})).await?;
    }
    let saved = mobile(
        app,
        reqwest::Method::GET,
        &format!("/resume_profile/{}", id),
        None,
    )
    .await?;
    let missing: Vec<&str> = data
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, value)| {
            !matches!(key.as_str(), "access" | "skill_levels")
                && !saved_field_matches(key, value, &saved["resume"][*key])
        })
        .map(|(key, _)| key.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!("Мобильный API не подтвердил сохранение полей: {}. Черновик сохранён частично; проверь его и продолжи через update_resume.", missing.join(", ")));
    }
    // Keep the authoritative wizard response for unfinished-screen reporting.
    if saved.get("next_incomplete_screen_id").is_some() {
        latest = saved;
    }
    Ok(latest)
}
fn skill_level_id(level: &serde_json::Value) -> Result<u64, String> {
    let name = level
        .as_str()
        .or_else(|| level["id"].as_str())
        .ok_or("Укажи уровень навыка: base, middle или advanced")?;
    match name {
        "base" | "basic" => Ok(8),
        "middle" | "medium" => Ok(9),
        "advanced" => Ok(10),
        _ => Err(format!(
            "Неизвестный уровень навыка: {}. Доступны base, middle, advanced",
            name
        )),
    }
}
fn validate_skill_levels(levels: &serde_json::Value) -> Result<(), String> {
    let list = levels
        .as_array()
        .filter(|l| !l.is_empty() && l.len() <= 30)
        .ok_or("Нужен список от 1 до 30 уровней навыков")?;
    let mut names = std::collections::HashSet::new();
    for skill in list {
        let name = skill["name"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Для уровня навыка укажи name из текущего резюме")?;
        if !names.insert(name.to_lowercase()) {
            return Err(format!("Навык {} указан несколько раз", name));
        }
        skill_level_id(&skill["level"])?;
    }
    Ok(())
}
fn skill_level_plan(
    profile: &serde_json::Value,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let all = profile["skills_with_levels"]
        .as_array()
        .ok_or("Мобильный API не вернул skills_with_levels")?;
    let skills: Vec<&serde_json::Value> = all.iter().filter(|s| s["category"] == "SKILL").collect();
    let levels = if let Some(levels) = args.get("levels") {
        if args.get("level").is_some() || args.get("skill_names").is_some() {
            return Err(
                "Укажи либо levels для отдельных навыков, либо level с необязательным skill_names"
                    .into(),
            );
        }
        validate_skill_levels(levels)?;
        levels.clone()
    } else {
        skill_level_id(&args["level"])?;
        let selected: Vec<String> = if let Some(names) = args.get("skill_names") {
            names
                .as_array()
                .filter(|names| !names.is_empty() && names.len() <= 30)
                .ok_or("skill_names должен быть непустым списком названий навыков")?
                .iter()
                .map(|name| {
                    name.as_str()
                        .map(str::to_string)
                        .ok_or_else(|| "Название навыка должно быть строкой".to_string())
                })
                .collect::<Result<_, _>>()?
        } else {
            skills
                .iter()
                .filter_map(|s| s["name"].as_str().map(str::to_string))
                .collect()
        };
        let levels = json!(selected
            .iter()
            .map(|name| json!({"name":name,"level":args["level"]}))
            .collect::<Vec<_>>());
        validate_skill_levels(&levels)?;
        levels
    };
    let mut plan = vec![];
    for entry in levels.as_array().unwrap() {
        let name = entry["name"].as_str().unwrap().trim();
        let found: Vec<_> = skills
            .iter()
            .filter(|s| {
                s["name"]
                    .as_str()
                    .map(|n| n.trim().to_lowercase() == name.to_lowercase())
                    .unwrap_or(false)
            })
            .collect();
        if found.len() != 1 {
            return Err(format!("Навык «{}» не найден однозначно в резюме. Сначала прочитай resume_reference(kind=skill_levels); язык не является профессиональным навыком.",name));
        }
        let skill = found[0];
        let id = skill["id"]
            .as_u64()
            .or_else(|| skill["id"].as_str().and_then(|id| id.parse().ok()))
            .ok_or("Мобильный API не вернул числовой id навыка")?;
        plan.push(
            json!({"category":"SKILL","skill_id":id,"level_id":skill_level_id(&entry["level"])?}),
        );
    }
    Ok(json!(plan))
}
fn numeric_id(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|id| id.parse().ok()))
}
fn pending_skill_levels(
    profile: &serde_json::Value,
    plan: &serde_json::Value,
) -> Vec<serde_json::Value> {
    plan.as_array()
        .unwrap()
        .iter()
        .filter(|change| {
            !profile["skills_with_levels"]
                .as_array()
                .map(|skills| {
                    skills.iter().any(|s| {
                        s["category"] == "SKILL"
                            && numeric_id(&s["id"]) == numeric_id(&change["skill_id"])
                            && numeric_id(&s["level"]["id"]) == numeric_id(&change["level_id"])
                    })
                })
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}
pub(crate) async fn set_skill_levels(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> Result<String, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let id = valid_id(args["resume_id"].as_str().ok_or("Нужен resume_id")?)?;
    let path = format!("/resume_profile/{}", id);
    let current = mobile(app, reqwest::Method::GET, &path, None).await?;
    let plan = skill_level_plan(&current, args)?;
    let pending = pending_skill_levels(&current, &plan);
    if !pending.is_empty() {
        // Self-assessment levels use a separate applicant endpoint shared by the hh.ru editor.
        run_web_action(app, "skill_levels", &json!(pending).to_string()).await?;
    }
    let saved = mobile(app, reqwest::Method::GET, &path, None).await?;
    let unconfirmed = pending_skill_levels(&saved, &plan);
    if !unconfirmed.is_empty() {
        return Err(format!("hh.ru не подтвердил сохранение уровней навыков для {} записей. Изменение не считается завершённым; перечитай текущие уровни.",unconfirmed.len()));
    }
    changed(app);
    Ok(json!({"resume_id":id,"updated":plan.as_array().unwrap().len(),"levels":plan,"message":"Уровни самооценки сохранены и проверены. Эти уровни общие для навыков аккаунта; прохождение тестов или сертификация не заявлялись."}).to_string())
}
fn saved_field_matches(
    key: &str,
    expected: &serde_json::Value,
    actual: &serde_json::Value,
) -> bool {
    if key == "education" {
        let mut expected = expected.clone();
        // HH may version edited education records and return a new record ID.
        for group in ["primary", "elementary", "additional", "attestation"] {
            if let Some(items) = expected
                .get_mut(group)
                .and_then(serde_json::Value::as_array_mut)
            {
                for item in items {
                    if let Some(fields) = item.as_object_mut() {
                        fields.remove("id");
                    }
                }
            }
        }
        return saved_value_matches(&expected, actual);
    }
    if key == "skill_set" {
        fn normalized(value: &serde_json::Value) -> Option<std::collections::BTreeSet<String>> {
            value
                .as_array()?
                .iter()
                .map(|v| {
                    Some(
                        v.as_str()?
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .to_lowercase(),
                    )
                })
                .collect()
        }
        return normalized(expected)
            .zip(normalized(actual))
            .map(|(a, b)| a == b)
            .unwrap_or(false);
    }
    if matches!(
        key,
        "professional_roles"
            | "work_format"
            | "employment_form"
            | "employments"
            | "schedules"
            | "citizenship"
            | "work_ticket"
    ) {
        fn ids(value: &serde_json::Value) -> Option<std::collections::BTreeSet<String>> {
            value
                .as_array()?
                .iter()
                .map(|v| Some(v["id"].as_str()?.to_string()))
                .collect()
        }
        return ids(expected)
            .zip(ids(actual))
            .map(|(a, b)| a == b)
            .unwrap_or(false);
    }
    saved_value_matches(expected, actual)
}
fn saved_value_matches(expected: &serde_json::Value, actual: &serde_json::Value) -> bool {
    match expected {
        serde_json::Value::Object(fields) => {
            actual.is_object()
                && fields.iter().all(|(key, value)| {
                    (key == "id" && value.is_null()) || saved_value_matches(value, &actual[key])
                })
        }
        serde_json::Value::Array(items) => actual
            .as_array()
            .map(|saved| {
                items.len() == saved.len()
                    && items
                        .iter()
                        .zip(saved)
                        .all(|(want, got)| saved_value_matches(want, got))
            })
            .unwrap_or(false),
        _ => expected == actual,
    }
}
fn definitely_rejected(error: &str) -> bool {
    [400, 401, 403, 404, 405, 422]
        .iter()
        .any(|status| error.starts_with(&format!("hh.ru API {}", status)))
}
pub(crate) async fn create(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> Result<String, String> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let data = payload(args, true)?;
    let key = valid_id(
        args["request_id"]
            .as_str()
            .ok_or("Нужен стабильный request_id")?,
    )?;
    let me = hh_get(app, "/me").await?;
    let owner = valid_id(
        me["id"]
            .as_str()
            .ok_or("Не получен id пользователя hh.ru")?,
    )?;
    let dir = data_dir(app)?.join("resume-requests").join(owner);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", key));
    let mut record = if path.exists() {
        Some(read_json::<serde_json::Value>(path.clone()).ok_or("Журнал предыдущей попытки повреждён. Проверь список резюме; повторное создание заблокировано.")?)
    } else {
        None
    };
    // Older builds left a pending journal entry even after a definite 405.
    // Recover only an old legacy attempt and an authoritatively empty account.
    if record
        .as_ref()
        .map(|r| {
            r["state"] == "pending"
                && r["transport"].is_null()
                && r["id"].is_null()
                && r["created_at"]
                    .as_i64()
                    .map(|created| created <= now() - 120)
                    .unwrap_or(false)
        })
        .unwrap_or(false)
    {
        let mine = hh_get(app, "/resumes/mine").await?;
        if mine["items"]
            .as_array()
            .map(|items| items.is_empty())
            .unwrap_or(false)
        {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            record = None;
        }
    }
    if let Some(record) = &record {
        if record["resume"] != data {
            return Err("request_id уже использован для другого содержимого. Для правки черновика используй update_resume.".into());
        }
        if record["state"] == "created" {
            let id = valid_id(record["id"].as_str().ok_or("В журнале нет id")?)?;
            return Ok(json!({"id":id,"already_created":true,"hidden":true}).to_string());
        }
        if record["id"].as_str().is_none() {
            return Err("Исход предыдущего создания неизвестен. Проверь list_resumes перед новой попыткой; автоматический повтор заблокирован.".into());
        }
    }
    let (id, initial) = if let Some(record) = record {
        let id = valid_id(record["id"].as_str().ok_or("В журнале нет id")?)?.to_string();
        let initial = mobile(
            app,
            reqwest::Method::GET,
            &format!("/resume_profile/{}", id),
            None,
        )
        .await?;
        (id, initial)
    } else {
        let available = hh_get(app, "/resumes/creation_availability").await?;
        if available["is_creation_available"] == false {
            return Err("Достигнут лимит резюме hh.ru".into());
        }
        write_json(
            path.clone(),
            &json!({"resume":data,"state":"pending","created_at":now(),"transport":"android_profile"}),
        )?;
        let initial = match mobile(
            app,
            reqwest::Method::POST,
            "/resume_profile",
            Some(&json!({"entry_point":"default","update_profile":false})),
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                if definitely_rejected(&error) {
                    let _ = std::fs::remove_file(&path);
                }
                return Err(error);
            }
        };
        let id = mobile_resume_id(&initial)?.to_string();
        // Persist before any filling, visibility change or subsequent network call.
        write_json(
            path.clone(),
            &json!({"resume":data,"id":id,"state":"draft","transport":"android_profile"}),
        )?;
        changed(app);
        (id, initial)
    };
    // Bootstrap is not published. Enforce hidden visibility before adding personal data.
    visibility(app, &id, false).await.map_err(|e| {
        format!(
            "Черновик {} создан, но скрытие не подтверждено: {}. Повтори с тем же request_id.",
            id, e
        )
    })?;
    let result = fill_mobile(app, &id, &data, initial).await.map_err(|e| format!("Черновик {} уже создан и скрыт. Заполнение не завершено: {}. Исправь его через update_resume или повтори тот же request_id; не создавай второй черновик.",id,e))?;
    write_json(
        path,
        &json!({"resume":data,"id":id,"state":"created","transport":"android_profile"}),
    )?;
    changed(app);
    Ok(json!({"id":id,"title":data["title"],"hidden":true,"next_incomplete_screen_id":result["next_incomplete_screen_id"],"url":format!("https://hh.ru/resume/{}",id),"message":"Резюме сохранено через мобильный API и скрыто. Если остался незаполненный шаг, уточни сведения и используй update_resume. Публикация — отдельное действие."}).to_string())
}
pub(crate) async fn update(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> Result<String, String> {
    let id = valid_id(args["resume_id"].as_str().ok_or("Нужен resume_id")?)?;
    let data = payload(args, false)?;
    let initial = mobile(
        app,
        reqwest::Method::GET,
        &format!("/resume_profile/{}", id),
        None,
    )
    .await?;
    let result = fill_mobile(app, id, &data, initial).await?;
    changed(app);
    Ok(json!({"id":id,"updated":true,"next_incomplete_screen_id":result["next_incomplete_screen_id"]}).to_string())
}
pub(crate) async fn visibility(
    app: &tauri::AppHandle,
    id: &str,
    publish: bool,
) -> Result<(), String> {
    let id = valid_id(id)?;
    if publish {
        let resume = hh_get(app, &format!("/resumes/{}", id)).await?;
        if resume["status"]["id"] != "published" {
            hh_post(app, &format!("/resumes/{}/publish", id)).await?;
            changed(app);
        }
    }
    if let Err(error) = write(
        app,
        reqwest::Method::PUT,
        &format!("/resumes/{}", id),
        &json!({"access":{"type":{"id":if publish {"clients"} else {"no_one"}}}}),
    )
    .await
    {
        // Some applicant clients cannot edit through OAuth; use the shared web session.
        if ["hh.ru API 403", "hh.ru API 404", "hh.ru API 405"]
            .iter()
            .any(|code| error.starts_with(code))
        {
            run_web_action(
                app,
                if publish {
                    "publish_visibility"
                } else {
                    "unpublish"
                },
                id,
            )
            .await?;
        } else {
            return Err(error);
        }
    }
    changed(app);
    Ok(())
}
pub(crate) async fn reference(
    app: &tauri::AppHandle,
    args: &serde_json::Value,
) -> Result<String, String> {
    let kind = args["kind"].as_str().unwrap_or("dictionaries");
    if kind == "skill_levels" {
        let id = valid_id(
            args["resume_id"]
                .as_str()
                .ok_or("Для уровней навыков нужен resume_id")?,
        )?;
        let data = mobile(
            app,
            reqwest::Method::GET,
            &format!("/resume_profile/{}", id),
            None,
        )
        .await?;
        let skills:Vec<serde_json::Value>=data["skills_with_levels"].as_array().ok_or("Нет списка навыков")?.iter().filter(|s|s["category"]=="SKILL")
            .map(|s|json!({"id":s["id"],"name":s["name"],"level":s["level"],"verified":s["verified"],"verified_by":s["verified_by"]})).collect();
        return Ok(json!({"skills":skills,"available_levels":[{"id":"base","level_id":8,"name":"Базовый"},{"id":"middle","level_id":9,"name":"Средний"},{"id":"advanced","level_id":10,"name":"Продвинутый"}],"scope":"Уровни самооценки навыков общие для аккаунта. Изменение уровней не означает прохождение теста."}).to_string());
    }
    if kind == "conditions" || kind == "profile" {
        let id = valid_id(args["resume_id"].as_str().ok_or("Для условий мобильного API укажи resume_id существующего черновика. Для нового сначала собери реальные сведения и создай скрытый черновик; не создавай резюме только ради чтения условий.")?)?;
        let data = mobile(
            app,
            reqwest::Method::GET,
            &format!("/resume_profile/{}", id),
            None,
        )
        .await?;
        if kind == "profile" {
            return Ok(json!({"resume":data["resume"],"profile":data["profile"],"next_incomplete_screen_id":data["next_incomplete_screen_id"]}).to_string());
        }
        return Ok(json!({"conditions":data["conditions"],"profile_conditions":data["profile_conditions"],"screens":data["screens"],"next_incomplete_screen_id":data["next_incomplete_screen_id"]}).to_string());
    }
    let path = match kind {
        "dictionaries" => "/dictionaries",
        "professional_roles" => "/professional_roles",
        "areas" => "/areas",
        "languages" => "/languages",
        _ => return Err("Неизвестный справочник".into()),
    };
    let data = hh_get(app, path).await?;
    if kind == "areas" || kind == "professional_roles" {
        let query = args["query"].as_str().unwrap_or("").trim().to_lowercase();
        if query.is_empty() {
            return Err("Укажи query для поиска по названию региона или профессии".into());
        }
        fn find(value: &serde_json::Value, query: &str, out: &mut Vec<serde_json::Value>) {
            match value {
                serde_json::Value::Array(a) => {
                    for v in a {
                        find(v, query, out);
                    }
                }
                serde_json::Value::Object(o) => {
                    if o.get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_lowercase().contains(query))
                        .unwrap_or(false)
                        && o.contains_key("id")
                        && out.len() < 40
                    {
                        out.push(json!({"id":value["id"],"name":value["name"]}));
                    }
                    for v in o.values() {
                        if v.is_array() || v.is_object() {
                            find(v, query, out);
                        }
                    }
                }
                _ => (),
            }
        }
        let mut items = vec![];
        find(&data, &query, &mut items);
        return Ok(json!(items).to_string());
    }
    Ok(data.to_string())
}

pub(crate) const TOOLS: &str = include_str!("resume_tools.json");
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_ids_and_forces_hidden_creation() {
        for id in ["", "../other", "abc?x=1", "abc#hash", "a/b"] {
            assert!(valid_id(id).is_err());
        }
        let data = payload(
            &json!({"resume":{"title":"Разработчик","experience":[]}}),
            true,
        )
        .unwrap();
        assert_eq!(data["access"]["type"]["id"], "no_one");
        assert!(payload(
            &json!({"resume":{"title":"Dev","access":{"type":{"id":"clients"}}}}),
            true
        )
        .is_err());
    }
    #[test]
    fn empty_success_and_location_and_field_errors() {
        assert_eq!(
            response_body(
                reqwest::StatusCode::CREATED,
                "",
                Some("https://api.hh.ru/resumes/abc123")
            )
            .unwrap()["id"],
            "abc123"
        );
        assert!(response_body(reqwest::StatusCode::NO_CONTENT, "", None).is_ok());
        let err = response_body(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"errors":[{"pointer":"/contact","value":"required"}]}"#,
            None,
        )
        .unwrap_err();
        assert!(err.contains("/contact") && err.contains("required"));
    }
}

#[cfg(test)]
mod mobile_tests {
    use super::*;
    #[test]
    fn android_requests_use_mobile_headers_and_json_body() {
        let request = mobile_request(
            &reqwest::Client::new(),
            "test-token",
            reqwest::Method::POST,
            "https://api.hh.ru/resume_profile",
        )
        .json(&json!({"entry_point":"default","update_profile":false}))
        .build()
        .unwrap();
        assert_eq!(request.url().path(), "/resume_profile");
        assert_eq!(request.headers()["X-HH-App-Active"], "true");
        assert!(request.headers()[reqwest::header::USER_AGENT]
            .to_str()
            .unwrap()
            .starts_with("ru.hh.android/"));
        assert_eq!(
            request.headers()[reqwest::header::AUTHORIZATION],
            "Bearer test-token"
        );
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["update_profile"], false);
    }
    #[test]
    fn reads_nested_mobile_id_and_preserves_fields_outside_current_screen() {
        assert_eq!(
            mobile_resume_id(&json!({"resume":{"id":"draft123"}})).unwrap(),
            "draft123"
        );
        assert!(mobile_resume_id(&json!({"resume":{"id":"../bad"}})).is_err());
        let data = json!({"title":"Разработчик","professional_roles":[{"id":"96"}],"experience":[],"area":{"id":"1"},"first_name":"Иван"});
        let role = json!({"screen_id":"professional_role","fields_options":{"title":{"visibility":"show"},"professional_roles":{"visibility":"show"}}});
        let body = mobile_screen_body(&data, &role).unwrap();
        assert_eq!(body["current_screen_id"], "professional_role");
        assert_eq!(body["resume"]["title"], "Разработчик");
        assert!(body["resume"].get("experience").is_none());
        assert!(body["profile"].as_object().unwrap().is_empty());
        let common = json!({"screen_id":"common","fields_options":{"area":{"visibility":"show"},"first_name":{"visibility":"hide"}}});
        let body = mobile_screen_body(&data, &common).unwrap();
        assert_eq!(body["profile"]["area"]["id"], "1");
        assert!(body["profile"].get("first_name").is_none());
    }
    #[test]
    fn verifies_saved_data_without_rejecting_server_dictionary_labels() {
        assert!(saved_value_matches(
            &json!({"id":"1"}),
            &json!({"id":"1","name":"Москва"})
        ));
        assert!(!saved_value_matches(
            &json!("Должность"),
            &serde_json::Value::Null
        ));
        assert!(!saved_value_matches(&json!([{"id":"1"}]), &json!([])));
        assert!(saved_value_matches(&json!([]), &json!([])));
    }
    #[test]
    fn only_definite_rejections_allow_new_bootstrap() {
        assert!(definitely_rejected("hh.ru API 405 Method Not Allowed"));
        assert!(!definitely_rejected("hh.ru API 500 Internal Server Error"));
        assert!(!definitely_rejected(
            "Ответ мобильного API hh.ru не получен"
        ));
    }
}

#[cfg(test)]
mod correction_tests {
    use super::*;
    #[test]
    fn accepts_modern_work_settings_and_rejects_missing_education_level_before_write() {
        let modern = json!({"resume":{"work_format":[{"id":"ON_SITE"},{"id":"REMOTE"}],"employment_form":[{"id":"FULL"}],"relocation":{"type":{"id":"no_relocation"}}}});
        assert!(payload(&modern, false).is_ok());
        let invalid = json!({"resume":{"education":{"level":{"id":"bachelor"},"primary":[{"name":"Университет","year":2026}]}}});
        let error = payload(&invalid, false).unwrap_err();
        assert!(error.contains("education.primary[0].education_level"));
        let valid = json!({"resume":{"education":{"level":{"id":"bachelor"},"primary":[{"name":"Университет","year":"2026","education_level":{"id":"bachelor"}},{"name":"Колледж","year":2021,"education_level":{"id":"special_secondary"}}]}}});
        let normalized = payload(&valid, false).unwrap();
        assert_eq!(normalized["education"]["primary"][0]["year"], 2026);
        assert!(normalized["education"]["primary"][0]["id"].is_null());
        assert_eq!(
            normalized["education"]["primary"][1]["education_level"]["id"],
            "special_secondary"
        );
    }
    #[test]
    fn skills_allow_canonical_case_and_order_but_detect_missing_items() {
        assert!(saved_field_matches(
            "skill_set",
            &json!(["КриптоПРО", "Windows Server"]),
            &json!(["Windows Server", "КриптоПро"])
        ));
        assert!(!saved_field_matches(
            "skill_set",
            &json!(["Linux", "Docker"]),
            &json!(["Linux"])
        ));
        assert!(!saved_field_matches(
            "skills",
            &json!("Точный текст"),
            &json!("точный текст")
        ));
        assert!(saved_field_matches(
            "work_format",
            &json!([{"id":"REMOTE"},{"id":"ON_SITE"}]),
            &json!([{"id":"ON_SITE","name":"Офис"},{"id":"REMOTE","name":"Удалённо"}])
        ));
    }
    #[test]
    fn checks_resume_education_with_server_generated_record_ids() {
        let expected = json!({"level":{"id":"bachelor"},"primary":[{"id":"old-entry","name":"Университет","year":2026,"education_level":{"id":"bachelor"}}]});
        let saved = json!({"level":{"id":"bachelor","name":"Бакалавр"},"primary":[{"id":"new-entry","name":"Университет","year":2026,"education_level":{"id":"bachelor","name":"Бакалавр"}}]});
        assert!(saved_field_matches("education", &expected, &saved));
        let incorrect = json!({"level":{"id":"secondary"},"primary":[]});
        assert!(!saved_field_matches("education", &expected, &incorrect));
    }
}

#[cfg(test)]
mod skill_level_tests {
    use super::*;
    fn profile() -> serde_json::Value {
        json!({"skills_with_levels":[
            {"id":34,"name":"Русский","category":"LANG","level":{"id":7,"internal_id":"l1"}},
            {"id":53,"name":"Linux","category":"SKILL","level":{"id":10,"internal_id":"advanced"}},
            {"id":"54","name":"КриптоПро","category":"SKILL","level":null}
        ]})
    }
    #[test]
    fn all_skills_excludes_languages_and_writes_only_changed_levels() {
        let current = profile();
        let plan = skill_level_plan(&current, &json!({"level":"advanced"})).unwrap();
        assert_eq!(plan.as_array().unwrap().len(), 2);
        assert!(plan
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["category"] == "SKILL" && s["level_id"] == 10 && s["skill_id"] != 34));
        let pending = pending_skill_levels(&current, &plan);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["skill_id"], 54);
        let mut saved = current;
        saved["skills_with_levels"][2]["level"] = json!({"id":"10","internal_id":"advanced"});
        assert!(pending_skill_levels(&saved, &plan).is_empty());
    }
    #[test]
    fn mixed_levels_and_legacy_objects_use_canonical_skill_ids() {
        let plan=skill_level_plan(&profile(),&json!({"levels":[{"name":"Linux","level":"middle"},{"name":"КриптоПРО","level":{"id":"advanced"}}]})).unwrap();
        assert_eq!(plan[0]["level_id"], 9);
        assert_eq!(plan[1]["level_id"], 10);
        assert_eq!(plan[1]["skill_id"], 54);
        assert!(payload(
            &json!({"resume":{"skill_levels":[{"name":"Linux","level":{"id":"advanced"}}]}}),
            false
        )
        .is_ok());
    }
    #[test]
    fn unknown_duplicate_language_and_unrequested_levels_are_rejected() {
        for args in [
            json!({"level":"expert"}),
            json!({}),
            json!({"level":"advanced","skill_names":["Русский"]}),
            json!({"level":"advanced","skill_names":["Unknown"]}),
            json!({"levels":[{"name":"Linux","level":"base"},{"name":"linux","level":"advanced"}]}),
            json!({"levels":[{"name":"Linux","level":"base"}],"level":"advanced"}),
        ] {
            assert!(skill_level_plan(&profile(), &args).is_err(), "{args}");
        }
        let plan =
            skill_level_plan(&profile(), &json!({"level":"base","skill_names":["Linux"]})).unwrap();
        assert_eq!(plan.as_array().unwrap().len(), 1);
        assert_eq!(plan[0]["level_id"], 8);
    }
    #[test]
    fn incomplete_save_is_detected_without_clearing_the_other_skills() {
        let current = profile();
        let plan = skill_level_plan(&current, &json!({"level":"advanced"})).unwrap();
        assert_eq!(pending_skill_levels(&current, &plan).len(), 1);
        assert_eq!(current["skills_with_levels"][0]["level"]["id"], 7);
        assert_eq!(current["skills_with_levels"][1]["level"]["id"], 10);
    }
}
