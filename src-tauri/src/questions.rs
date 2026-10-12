//! A question is scoped to a chat and call. Human input has no tool/network timeout.
use super::*;
use std::collections::HashSet;

type Answers = HashMap<String, String>;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Question {
    id: String,
    label: String,
    #[serde(default)]
    options: Vec<String>,
    #[serde(default = "required_default")]
    required: bool,
    #[serde(default)]
    multiline: bool,
}
fn required_default() -> bool {
    true
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Form {
    title: String,
    questions: Vec<Question>,
}
struct Pending {
    call_id: String,
    form: Form,
    tx: tokio::sync::oneshot::Sender<serde_json::Value>,
}
fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    static MAP: std::sync::LazyLock<Mutex<HashMap<String, Pending>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &MAP
}
pub(crate) fn clear(chat_id: &str) {
    pending().lock().expect("mutex").remove(chat_id);
}
fn validate_form(form: &Form) -> Result<(), String> {
    if form.title.trim().is_empty()
        || form.title.len() > 400
        || !(1..=3).contains(&form.questions.len())
    {
        return Err("Нужны заголовок и от 1 до 3 вопросов".into());
    }
    let mut ids = HashSet::new();
    for q in &form.questions {
        if q.id.is_empty()
            || q.id.len() > 80
            || !ids.insert(&q.id)
            || q.label.trim().is_empty()
            || q.label.len() > 1000
            || q.options.len() > 8
            || q.options
                .iter()
                .any(|o| o.trim().is_empty() || o.len() > 300)
        {
            return Err("Некорректные вопросы: проверь id, подписи и варианты".into());
        }
    }
    Ok(())
}
fn validate_answers(form: &Form, answers: &Answers) -> Result<(), String> {
    if answers
        .keys()
        .any(|id| !form.questions.iter().any(|q| &q.id == id))
    {
        return Err("Неизвестный вопрос".into());
    }
    for q in &form.questions {
        let value = answers.get(&q.id).map(|s| s.trim()).unwrap_or("");
        if q.required && value.is_empty() {
            return Err(format!("Ответьте на вопрос: {}", q.label));
        }
        if value.len() > 12000 {
            return Err("Ответ слишком длинный".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn chat_pending_question(chat_id: String) -> Option<serde_json::Value> {
    pending()
        .lock()
        .expect("mutex")
        .get(&chat_id)
        .map(|p| json!({"call_id":p.call_id,"form":p.form}))
}
#[tauri::command]
pub(crate) fn chat_answer(
    chat_id: String,
    call_id: String,
    answers: Answers,
    cancelled: bool,
) -> Result<(), String> {
    let mut map = pending().lock().expect("mutex");
    let p = map
        .get(&chat_id)
        .filter(|p| p.call_id == call_id)
        .ok_or("Эта форма уже закрыта")?;
    if !cancelled {
        validate_answers(&p.form, &answers)?;
    }
    let result = if cancelled {
        json!({"cancelled":true})
    } else {
        json!({"answers": p.form.questions.iter().map(|q| json!({"id":q.id,"question":q.label,"answer":answers.get(&q.id)})).collect::<Vec<_>>()})
    };
    let p = map.remove(&chat_id).unwrap();
    p.tx.send(result)
        .map_err(|_| "Задача уже завершилась".into())
}
pub(crate) async fn ask(
    chat_id: &str,
    call_id: &str,
    args: &serde_json::Value,
    cancelled: &AtomicBool,
    events: &tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    let form: Form = serde_json::from_value(args.clone()).map_err(|e| e.to_string())?;
    validate_form(&form)?;
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    pending().lock().expect("mutex").insert(
        chat_id.into(),
        Pending {
            call_id: call_id.into(),
            form: form.clone(),
            tx,
        },
    );
    if events
        .send(json!({"type":"question_request","call_id":call_id,"form":form}))
        .is_err()
    {
        clear(chat_id);
        return Err("Чат отключён".into());
    }
    let answer = loop {
        tokio::select! {
            result = &mut rx => break result.unwrap_or(json!({"cancelled":true})),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                if cancelled.load(Ordering::Relaxed) { break json!({"cancelled":true}); }
            }
        }
    };
    clear(chat_id);
    let _ = events.send(json!({"type":"question_result","call_id":call_id,"result":answer}));
    Ok(answer.to_string())
}
pub(crate) const TOOLS: &str = r#"[{"type":"function","function":{
    "name":"ask_questions",
    "description":"Задать 1–3 уточняющих вопроса через форму вместо поля ввода чата и дождаться ответов. Для любых задач. Варианты необязательны, собственный ответ доступен всегда. Не спрашивай уже известное. Отмена не является ответом или согласием.",
    "parameters":{"type":"object","properties":{
        "title":{"type":"string"},
        "questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{
            "id":{"type":"string"},"label":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},
            "required":{"type":"boolean"},"multiline":{"type":"boolean"}
        },"required":["id","label"]}}
    },"required":["title","questions"]}
}}]"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn form() -> Form {
        serde_json::from_value(json!({"title":"Уточнение","questions":[{"id":"role","label":"Должность","options":["Дизайнер"]}]})).unwrap()
    }
    #[test]
    fn custom_answers_and_required_fields() {
        let f = form();
        assert!(validate_answers(&f, &HashMap::new()).is_err());
        assert!(
            validate_answers(&f, &HashMap::from([("role".into(), "Разработчик".into())])).is_ok()
        );
        let mut f = f;
        f.questions.push(f.questions[0].clone());
        assert!(validate_form(&f).is_err());
    }
    #[tokio::test]
    async fn answers_are_scoped_and_one_shot() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        pending().lock().unwrap().insert(
            "test-chat".into(),
            Pending {
                call_id: "call-1".into(),
                form: form(),
                tx,
            },
        );
        assert!(chat_answer("other".into(), "call-1".into(), HashMap::new(), true).is_err());
        assert!(chat_answer("test-chat".into(), "old".into(), HashMap::new(), true).is_err());
        assert!(chat_answer("test-chat".into(), "call-1".into(), HashMap::new(), false).is_err());
        assert!(chat_answer("test-chat".into(), "call-1".into(), HashMap::new(), true).is_ok());
        assert_eq!(rx.await.unwrap()["cancelled"], true);
        assert!(chat_pending_question("test-chat".into()).is_none());
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn stopping_a_chat_closes_only_its_pending_form() {
        let form: Form = serde_json::from_value(
            json!({"title":"Вопрос","questions":[{"id":"q","label":"Ответ?"}]}),
        )
        .unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (other_tx, mut other_rx) = tokio::sync::oneshot::channel();
        {
            let mut map = pending().lock().unwrap();
            map.insert(
                "stopped-test".into(),
                Pending {
                    call_id: "a".into(),
                    form: form.clone(),
                    tx,
                },
            );
            map.insert(
                "running-test".into(),
                Pending {
                    call_id: "b".into(),
                    form,
                    tx: other_tx,
                },
            );
        }
        clear("stopped-test");
        assert!(rx.await.is_err());
        assert!(matches!(
            other_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        clear("running-test");
    }
}
