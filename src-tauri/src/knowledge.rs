//! Operations on the same notes shown in the Knowledge tab.
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const READ_TOOLS: &str = include_str!("knowledge_read_tools.json");
pub(crate) const WRITE_TOOLS: &str = include_str!("knowledge_write_tools.json");

fn new_id() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "note-{nanos:x}-{:x}",
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

/// Give old notes stable identifiers without changing their contents or order.
pub(crate) fn normalize(profile: &mut Value) -> Result<(), String> {
    if !profile.is_object() {
        return Err("Профиль должен быть объектом".into());
    }
    if profile.get("notes").is_none() {
        profile["notes"] = json!([]);
    }
    let notes = profile["notes"]
        .as_array_mut()
        .ok_or("Повреждён список знаний")?;
    let mut ids = HashSet::new();
    // Reserve existing IDs before creating new ones; duplicate IDs are an error.
    for note in notes.iter() {
        if !note.is_object() || !note["text"].is_string() {
            return Err("Повреждена запись знаний: ожидается объект с текстом".into());
        }
        if let Some(id) = note["id"].as_str().filter(|s| !s.trim().is_empty()) {
            if !ids.insert(id.to_string()) {
                return Err(format!("Повторяющийся ID знания: {id}"));
            }
        }
    }
    for note in notes {
        if note["id"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .is_none()
        {
            let mut id = new_id();
            while !ids.insert(id.clone()) {
                id = new_id();
            }
            note["id"] = json!(id);
        }
    }
    Ok(())
}

fn required_text(args: &Value, key: &str) -> Result<String, String> {
    args[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Нужно непустое строковое поле {key}"))
}

fn topic(value: &Value) -> Result<Value, String> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let text = value
        .as_str()
        .ok_or("Тема должна быть строкой или null")?
        .trim();
    Ok(if text.is_empty() {
        Value::Null
    } else {
        json!(text)
    })
}

fn number(args: &Value, key: &str, default: usize) -> Result<usize, String> {
    match args.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| format!("{key} должен быть неотрицательным целым числом")),
    }
}

pub(crate) fn read(profile: &Value, name: &str, args: &Value) -> Result<Value, String> {
    let notes = profile["notes"]
        .as_array()
        .ok_or("Повреждён список знаний")?;
    match name {
        "read_knowledge" => {
            let id = required_text(args, "id")?;
            notes
                .iter()
                .find(|n| n["id"].as_str() == Some(&id))
                .cloned()
                .ok_or_else(|| format!("Знание с ID {id} не найдено. Прочитай актуальный список."))
        }
        "list_knowledge_topics" => {
            let mut topics = BTreeMap::<String, usize>::new();
            for note in notes {
                *topics
                    .entry(note["topic"].as_str().unwrap_or("").into())
                    .or_default() += 1;
            }
            Ok(
                json!({"total": notes.len(), "topics": topics.into_iter().map(|(t, count)|
                json!({"topic": if t.is_empty() { Value::Null } else { json!(t) }, "count": count}))
                .collect::<Vec<_>>()}),
            )
        }
        "list_knowledge" => {
            let query = match args.get("query") {
                None => String::new(),
                Some(q) => q
                    .as_str()
                    .ok_or("query должен быть строкой")?
                    .trim()
                    .to_lowercase(),
            };
            let filter_topic = args.get("topic").map(topic).transpose()?;
            let offset = number(args, "offset", 0)?;
            let limit = number(args, "limit", 50)?;
            if !(1..=200).contains(&limit) {
                return Err("limit должен быть от 1 до 200".into());
            }
            let matching: Vec<_> = notes
                .iter()
                .filter(|n| {
                    let t = n["topic"].as_str().unwrap_or("");
                    filter_topic
                        .as_ref()
                        .map(|f| f.as_str().unwrap_or("").to_lowercase() == t.to_lowercase())
                        .unwrap_or(true)
                        && (query.is_empty()
                            || t.to_lowercase().contains(&query)
                            || n["text"]
                                .as_str()
                                .unwrap_or("")
                                .to_lowercase()
                                .contains(&query))
                })
                .collect();
            let items: Vec<_> = matching.iter().skip(offset).take(limit).copied().collect();
            let next = offset.saturating_add(items.len());
            Ok(
                json!({"notes": items, "total": matching.len(), "offset": offset,
                "next_offset": if next < matching.len() { Some(next) } else { None }}),
            )
        }
        _ => Err(format!("Неизвестный инструмент знаний: {name}")),
    }
}

fn indices(notes: &[Value], args: &Value) -> Result<Vec<usize>, String> {
    let ids = args["ids"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("Нужен непустой список ids")?;
    let mut seen = HashSet::new();
    ids.iter()
        .map(|value| {
            let id = value
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("Все ids должны быть непустыми строками")?;
            if !seen.insert(id) {
                return Err(format!("ID {id} указан несколько раз"));
            }
            notes
                .iter()
                .position(|n| n["id"].as_str() == Some(id))
                .ok_or_else(|| format!("Знание с ID {id} не найдено. Прочитай актуальный список."))
        })
        .collect()
}

fn add(notes: &mut Vec<Value>, args: &Value, timestamp: i64) -> Result<Value, String> {
    let items = args["notes"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("Нужен непустой список notes")?;
    // Validate the entire batch before changing anything.
    let mut created = Vec::new();
    for item in items {
        created.push(json!({"id": new_id(), "text": required_text(item, "text")?,
            "topic": topic(&item["topic"])?, "added_at": timestamp}));
    }
    notes.extend(created.clone());
    Ok(json!({"created": created}))
}

pub(crate) fn mutate(
    profile: &mut Value,
    name: &str,
    args: &Value,
    timestamp: i64,
) -> Result<Value, String> {
    let notes = profile["notes"]
        .as_array_mut()
        .ok_or("Повреждён список знаний")?;
    match name {
        "create_knowledge" => add(notes, args, timestamp),
        "update_profile" => {
            let items = args["notes_add"]
                .as_array()
                .filter(|a| !a.is_empty())
                .ok_or("Нужен непустой список notes_add")?;
            let t = topic(&args["notes_topic"])?;
            let converted = items
                .iter()
                .map(|text| json!({"text": text, "topic": t}))
                .collect::<Vec<_>>();
            add(notes, &json!({"notes": converted}), timestamp)
        }
        "update_knowledge" => {
            let id = required_text(args, "id")?;
            let text = args
                .get("text")
                .map(|_| required_text(args, "text"))
                .transpose()?;
            let t = args.get("topic").map(topic).transpose()?;
            if text.is_none() && t.is_none() {
                return Err("Передай text и/или topic для изменения".into());
            }
            let note = notes
                .iter_mut()
                .find(|n| n["id"].as_str() == Some(&id))
                .ok_or_else(|| {
                    format!("Знание с ID {id} не найдено. Прочитай актуальный список.")
                })?;
            if let Some(text) = text {
                note["text"] = json!(text);
            }
            if let Some(t) = t {
                note["topic"] = t;
            }
            note["updated_at"] = json!(timestamp);
            Ok(json!({"updated": note}))
        }
        "delete_knowledge" => {
            let selected = indices(notes, args)?;
            let deleted: Vec<_> = selected.iter().map(|&i| notes[i].clone()).collect();
            let ids: HashSet<_> = deleted.iter().map(|n| n["id"].as_str().unwrap()).collect();
            notes.retain(|n| !ids.contains(n["id"].as_str().unwrap()));
            Ok(json!({"deleted": deleted, "remaining": notes.len()}))
        }
        "rename_knowledge_topic" => {
            let from = topic(args.get("from").ok_or("Нужно поле from")?)?;
            let to = topic(args.get("to").ok_or("Нужно поле to")?)?;
            let mut updated = Vec::new();
            for note in notes {
                if note["topic"].as_str().unwrap_or("").to_lowercase()
                    == from.as_str().unwrap_or("").to_lowercase()
                {
                    note["topic"] = to.clone();
                    note["updated_at"] = json!(timestamp);
                    updated.push(note.clone());
                }
            }
            Ok(json!({"updated": updated}))
        }
        "merge_knowledge" => {
            let selected = indices(notes, args)?;
            if selected.len() < 2 {
                return Err("Для объединения нужны минимум два ID".into());
            }
            let text = required_text(args, "text")?;
            let t = args.get("topic").map(topic).transpose()?;
            let first = selected[0];
            let removed: HashSet<String> = selected[1..]
                .iter()
                .map(|&i| notes[i]["id"].as_str().unwrap().to_string())
                .collect();
            notes[first]["text"] = json!(text);
            if let Some(t) = t {
                notes[first]["topic"] = t;
            }
            notes[first]["updated_at"] = json!(timestamp);
            let merged = notes[first].clone();
            notes.retain(|n| !removed.contains(n["id"].as_str().unwrap()));
            Ok(json!({"merged": merged, "deleted_ids": removed}))
        }
        _ => Err(format!("Неизвестный инструмент знаний: {name}")),
    }
}

pub(crate) fn is_write(name: &str) -> bool {
    matches!(
        name,
        "create_knowledge"
            | "update_knowledge"
            | "delete_knowledge"
            | "rename_knowledge_topic"
            | "merge_knowledge"
            | "update_profile"
    )
}

pub(crate) fn execute(app: &tauri::AppHandle, name: &str, args: &Value) -> Result<String, String> {
    let _guard = super::profile_lock().lock().map_err(|e| e.to_string())?;
    let mut profile = super::load_profile(app)?;
    let result = if is_write(name) {
        let result = mutate(&mut profile, name, args, super::now())?;
        super::save_profile(app, &mut profile)?;
        result
    } else {
        read(&profile, name, args)?
    };
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        json!({"revision": 4, "notes": [
            {"id":"a", "topic":"Опыт", "text":"Разрабатываю на Rust", "added_at":10},
            {"id":"b", "topic":"Навыки", "text":"Русский и английский", "added_at":11},
            {"id":"c", "topic":null, "text":"Удалённая работа", "added_at":12}
        ]})
    }

    #[test]
    fn migration_preserves_ids_content_dates_order_and_metadata() {
        let mut p = fixture();
        p["notes"][1].as_object_mut().unwrap().remove("id");
        normalize(&mut p).unwrap();
        assert_eq!(p["notes"][0]["id"], "a");
        assert_eq!(p["notes"][1]["text"], "Русский и английский");
        assert_eq!(p["notes"][1]["added_at"], 11);
        assert!(p["notes"][1]["id"].as_str().unwrap().starts_with("note-"));
        let saved = serde_json::to_string(&p).unwrap();
        let mut reloaded: Value = serde_json::from_str(&saved).unwrap();
        normalize(&mut reloaded).unwrap();
        assert_eq!(p, reloaded);
        assert_eq!(p["revision"], 4);
    }

    #[test]
    fn search_topic_filter_pagination_and_full_text_read() {
        let p = fixture();
        let first = read(&p, "list_knowledge", &json!({"limit":1})).unwrap();
        assert_eq!(first["notes"][0]["id"], "a");
        assert_eq!(first["total"], 3);
        assert_eq!(first["next_offset"], 1);
        let last = read(&p, "list_knowledge", &json!({"offset":1,"limit":2})).unwrap();
        assert_eq!(last["notes"].as_array().unwrap().len(), 2);
        assert!(last["next_offset"].is_null());
        let search = read(
            &p,
            "list_knowledge",
            &json!({"query":"РУССКИЙ","topic":"навыки"}),
        )
        .unwrap();
        assert_eq!(search["notes"][0]["id"], "b");
        let ungrouped = read(&p, "list_knowledge", &json!({"topic":null})).unwrap();
        assert_eq!(ungrouped["notes"][0]["id"], "c");
        assert_eq!(
            read(&p, "read_knowledge", &json!({"id":"b"})).unwrap(),
            p["notes"][1]
        );
        assert!(read(&p, "read_knowledge", &json!({"id":"missing"})).is_err());
    }

    #[test]
    fn pagination_can_reach_knowledge_beyond_old_hundred_note_limit() {
        let mut p = json!({"notes": (0..237).map(|i| json!({"text":format!("Факт {i}")})).collect::<Vec<_>>()});
        normalize(&mut p).unwrap();
        let mut offset = 0;
        let mut ids = HashSet::new();
        loop {
            let page = read(&p, "list_knowledge", &json!({"offset":offset})).unwrap();
            for note in page["notes"].as_array().unwrap() {
                assert!(ids.insert(note["id"].as_str().unwrap().to_string()));
            }
            match page["next_offset"].as_u64() {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(ids.len(), 237);
        assert_eq!(
            read(&p, "list_knowledge", &json!({"query":"Факт 236"})).unwrap()["total"],
            1
        );
    }

    #[test]
    fn create_update_move_and_delete_use_stable_ids() {
        let mut p = fixture();
        let created = mutate(
            &mut p,
            "create_knowledge",
            &json!({"notes":[
                {"text":"  Хочу гибкий график  ","topic":" Пожелания "}, {"text":"Есть ребёнок"}
            ]}),
            20,
        )
        .unwrap();
        let id = created["created"][0]["id"].as_str().unwrap();
        assert_eq!(created["created"][0]["text"], "Хочу гибкий график");
        assert!(created["created"][1]["topic"].is_null());
        p["notes"].as_array_mut().unwrap().reverse();
        let updated = mutate(
            &mut p,
            "update_knowledge",
            &json!({"id":id,"text":"Нужен гибрид","topic":null}),
            21,
        )
        .unwrap();
        assert_eq!(updated["updated"]["id"], id);
        assert_eq!(updated["updated"]["added_at"], 20);
        assert_eq!(updated["updated"]["updated_at"], 21);
        assert!(updated["updated"]["topic"].is_null());
        mutate(&mut p, "delete_knowledge", &json!({"ids":[id,"b"]}), 22).unwrap();
        assert_eq!(p["notes"].as_array().unwrap().len(), 3);
        assert!(read(&p, "read_knowledge", &json!({"id":id})).is_err());
        assert_eq!(
            read(&p, "read_knowledge", &json!({"id":"a"})).unwrap()["text"],
            "Разрабатываю на Rust"
        );
    }

    #[test]
    fn topic_rename_merge_and_removing_topic_keep_facts() {
        let mut p = fixture();
        mutate(
            &mut p,
            "rename_knowledge_topic",
            &json!({"from":"опыт","to":"Навыки"}),
            20,
        )
        .unwrap();
        let topics = read(&p, "list_knowledge_topics", &json!({})).unwrap();
        assert_eq!(topics["topics"].as_array().unwrap().len(), 2);
        assert_eq!(topics["topics"][1]["count"], 2);
        let merged = mutate(
            &mut p,
            "merge_knowledge",
            &json!({"ids":["b","a"],"text":"Разрабатываю на Rust. Русский и английский"}),
            21,
        )
        .unwrap();
        assert_eq!(merged["merged"]["id"], "b");
        assert_eq!(merged["merged"]["added_at"], 11);
        assert_eq!(merged["merged"]["topic"], "Навыки");
        assert_eq!(p["notes"].as_array().unwrap().len(), 2);
        mutate(
            &mut p,
            "rename_knowledge_topic",
            &json!({"from":"Навыки","to":null}),
            22,
        )
        .unwrap();
        let topics = read(&p, "list_knowledge_topics", &json!({})).unwrap();
        assert_eq!(topics["topics"][0]["count"], 2);
        assert!(topics["topics"][0]["topic"].is_null());
    }

    #[test]
    fn invalid_batches_and_missing_ids_do_not_partially_change_knowledge() {
        for (name, args) in [
            (
                "create_knowledge",
                json!({"notes":[{"text":"Валидный факт"},{"text":"  "}]}),
            ),
            ("update_profile", json!({"notes_add":["Валидный факт",5]})),
            ("delete_knowledge", json!({"ids":["a","missing"]})),
            ("delete_knowledge", json!({"ids":["a","a"]})),
            ("delete_knowledge", json!({"ids":[]})),
            (
                "update_knowledge",
                json!({"id":"a","text":"Новый факт","topic":42}),
            ),
            ("update_knowledge", json!({"id":"a"})),
            ("update_knowledge", json!({"id":"a","text":"  "})),
            (
                "merge_knowledge",
                json!({"ids":["a","missing"],"text":"Итог"}),
            ),
            ("merge_knowledge", json!({"ids":["a"],"text":"Итог"})),
            ("rename_knowledge_topic", json!({"from":"Опыт"})),
        ] {
            let mut p = fixture();
            let before = p.clone();
            assert!(mutate(&mut p, name, &args, 20).is_err(), "{name} {args}");
            assert_eq!(p, before, "{name} {args}");
        }
    }

    #[test]
    fn malformed_profiles_are_rejected_and_legacy_add_still_works() {
        for mut profile in [
            json!([]),
            json!({"notes":{}}),
            json!({"notes":["fact"]}),
            json!({"notes":[{"text":"fact","id":"a"},{"text":"other","id":"a"}]}),
        ] {
            assert!(normalize(&mut profile).is_err());
        }
        let mut p = fixture();
        let result = mutate(
            &mut p,
            "update_profile",
            &json!({"notes_add":["Новый факт"],"notes_topic":" Семья "}),
            20,
        )
        .unwrap();
        assert_eq!(result["created"][0]["topic"], "Семья");
        assert!(result["created"][0]["id"].is_string());
        assert_eq!(p["notes"].as_array().unwrap().len(), 4);
        for args in [
            json!({"limit":0}),
            json!({"limit":201}),
            json!({"offset":-1}),
            json!({"query":3}),
        ] {
            assert!(read(&p, "list_knowledge", &args).is_err());
        }
    }
}
