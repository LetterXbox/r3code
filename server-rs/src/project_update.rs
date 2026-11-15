//! Atomic project metadata update and durable receipt.
use crate::{
    event_bus::{BusError, EventBus},
    event_store::{self, Event, Receipt},
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use unicode_segmentation::UnicodeSegmentation;
type ProjectRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

pub fn validate(v: &Value) -> bool {
    let Some(v) = v.as_object() else { return false };
    for key in ["title", "workspaceRoot"] {
        if v.get(key)
            .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            return false;
        }
    }
    if v.get("faviconPath").is_some_and(|v| {
        !v.is_null()
            && v.as_str().is_none_or(|s| {
                let s = s.trim().to_ascii_lowercase();
                s.is_empty()
                    || s.encode_utf16().count() > 1024
                    || ![
                        ".avif", ".gif", ".icns", ".ico", ".jpg", ".jpeg", ".png", ".svg", ".webp",
                    ]
                    .iter()
                    .any(|ext| s.ends_with(ext))
            })
    }) {
        return false;
    }
    for key in ["pinned", "archived", "autoPull"] {
        if v.get(key).is_some_and(|v| !v.is_boolean()) {
            return false;
        }
    }
    if v.get("defaultThreadEnvMode").is_some_and(|v| {
        !v.is_null()
            && !v
                .as_str()
                .is_some_and(|s| ["local", "worktree"].contains(&s))
    }) {
        return false;
    }
    if v.get("defaultModelSelection").is_some_and(|v| {
        !v.is_null()
            && (!v.is_object()
                || v["instanceId"].as_str().is_none_or(|s| s.trim().is_empty())
                || v["model"].as_str().is_none_or(|s| s.trim().is_empty()))
    }) {
        return false;
    }
    if v.get("scripts").is_some_and(|v| {
        v.as_array().is_none_or(|arr| {
            arr.iter().any(|s| {
                !s.is_object()
                    || ["id", "name", "command", "icon"]
                        .iter()
                        .any(|key| s[*key].as_str().is_none_or(|x| x.trim().is_empty()))
                    || !s["runOnWorktreeCreate"].is_boolean()
                    || !s["icon"].as_str().is_some_and(|i| {
                        ["play", "test", "lint", "configure", "build", "debug"].contains(&i)
                    })
                    || ["runOnSettle", "stopOnSettle", "async", "autoOpenPreview"]
                        .iter()
                        .any(|key| s.get(*key).is_some_and(|v| !v.is_boolean()))
                    || s.get("previewUrl")
                        .is_some_and(|v| v.as_str().is_none_or(|s| s.trim().is_empty()))
            })
        })
    }) {
        return false;
    }
    if let Some(icon) = v.get("projectIcon").filter(|v| !v.is_null()) {
        let colors = [
            "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan",
            "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
        ];
        let color = icon["color"].as_str().is_some_and(|c| colors.contains(&c));
        let valid = match icon["kind"].as_str() {
            Some("emoji") => icon["emoji"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.trim().encode_utf16().count() <= 32),
            Some("lucide") => {
                color
                    && icon["name"].as_str().is_some_and(|s| {
                        let s = s.trim();
                        !s.is_empty()
                            && s.len() <= 64
                            && s.split('-').all(|part| {
                                !part.is_empty()
                                    && part
                                        .bytes()
                                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                            })
                    })
            }
            Some("monogram") => {
                color
                    && icon["text"].as_str().is_some_and(|s| {
                        let s = s.trim();
                        !s.is_empty()
                            && s.encode_utf16().count() <= 32
                            && regex::Regex::new(
                                r"^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u{200c}\u{200d}]*$",
                            )
                            .unwrap()
                            .is_match(s)
                    })
            }
            _ => false,
        };
        if !valid {
            return false;
        }
    }
    true
}
pub fn dispatch(
    bus: &EventBus,
    command_id: &str,
    project_id: &str,
    input: &Value,
    now: &str,
) -> Result<Receipt, BusError> {
    dispatch_checked(bus, command_id, project_id, input, now, |_| Ok(()))
}

pub(crate) fn dispatch_checked(
    bus: &EventBus,
    command_id: &str,
    project_id: &str,
    input: &Value,
    now: &str,
    check: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<()>,
) -> Result<Receipt, BusError> {
    bus.commit(|tx|{
        check(tx)?;
        if let Some(receipt)=event_store::get_receipt(tx,command_id,"project")?{
            if receipt.aggregate_id != project_id || receipt.command_type != "project.meta.update" {return Err(rusqlite::Error::InvalidQuery);}
            return Ok((receipt,vec![]));
        }
        let row:Option<ProjectRow>=tx.query_row("SELECT title,workspace_root,scripts_json,default_model_selection_json,default_thread_env_mode,auto_pull,favicon_path,project_icon_json,pinned_at,archived_at,has_custom_title FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[project_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional()?;
        let mut error=row.is_none().then(||format!("Project '{project_id}' does not exist for command 'project.meta.update'."));
        if error.is_none() && input["projectIcon"]["kind"]=="monogram" && input["projectIcon"]["text"].as_str().is_some_and(|s|s.graphemes(true).count()>2){error=Some("Project monograms must contain at most two characters.".into());}
        if let (Some(row),Some(scripts))=(&row,input.get("scripts").and_then(Value::as_array)) {
            let old:Vec<Value>=serde_json::from_str(&row.2).unwrap_or_default();
            for script in scripts { let id=script["id"].as_str().unwrap_or("");let existing=old.iter().any(|s|s["id"]==id);let valid=!id.is_empty() && id.len()<=24 && id.bytes().enumerate().all(|(i,c)|c.is_ascii_lowercase()||c.is_ascii_digit()||(i>0 && c==b'-'));if !existing && !valid && error.is_none(){error=Some(format!("Script IDs must be 1-24 lowercase letters, digits or hyphens, starting with a letter or digit (got {} characters).",id.encode_utf16().count()));} }
        }
        if error.is_none(){if let Some(root)=input["workspaceRoot"].as_str(){let owner:Option<String>=tx.query_row("SELECT project_id FROM projection_projects WHERE workspace_root=?1 AND deleted_at IS NULL AND project_id!=?2 LIMIT 1",params![root.trim(),project_id],|r|r.get(0)).optional()?;if let Some(owner)=owner {error=Some(format!("Active project '{owner}' already exists for workspace root '{}'.",root.trim()));}}}
        let mut receipt=Receipt{command_id:command_id.into(),aggregate_kind:"project".into(),aggregate_id:project_id.into(),command_type:"project.meta.update".into(),accepted_at:now.into(),result_sequence:event_store::latest_application_sequence(tx)?,status:if error.is_some(){"rejected"}else{"accepted"}.into(),error};
        if !event_store::insert_receipt_if_absent(tx,&receipt)? {return Err(rusqlite::Error::InvalidQuery);}
        if receipt.error.is_some(){return Ok((receipt,vec![]));}
        let (title,root,scripts,model,env,auto,favicon,icon,pinned,archived,custom)=row.unwrap();
        let mut payload=json!({"projectId":project_id,"updatedAt":now});
        for key in ["title","workspaceRoot","defaultModelSelection","defaultThreadEnvMode","autoPull","faviconPath","projectIcon","scripts"] {if let Some(value)=input.get(key){payload[key]=match value {Value::String(s)=>json!(s.trim()),_=>value.clone()};}}
        for (key,field,previous) in [("pinned","pinnedAt",pinned.as_ref()),("archived","archivedAt",archived.as_ref())] {if let Some(value)=input.get(key).and_then(Value::as_bool){payload[field]=if value {json!(previous.map(String::as_str).unwrap_or(now))}else{Value::Null};}}
        let choose_str=|key:&str,previous:String|payload.get(key).and_then(Value::as_str).map(str::to_owned).unwrap_or(previous);
        let choose_opt=|key:&str,previous:Option<String>| match payload.get(key){None=>previous,Some(Value::Null)=>None,Some(Value::String(v))=>Some(v.clone()),_=>previous};
        let choose_json=|key:&str,previous:Option<String>|match payload.get(key){None=>previous,Some(Value::Null)=>None,Some(v)=>Some(v.to_string())};
        tx.execute("UPDATE projection_projects SET title=?2,workspace_root=?3,scripts_json=?4,default_model_selection_json=?5,default_thread_env_mode=?6,auto_pull=?7,favicon_path=?8,project_icon_json=?9,pinned_at=?10,archived_at=?11,has_custom_title=?12,updated_at=?13 WHERE project_id=?1",params![project_id,choose_str("title",title),choose_str("workspaceRoot",root),payload.get("scripts").map(Value::to_string).unwrap_or(scripts),choose_json("defaultModelSelection",model),choose_opt("defaultThreadEnvMode",env),payload.get("autoPull").and_then(Value::as_bool).unwrap_or(auto),choose_opt("faviconPath",favicon),choose_json("projectIcon",icon),choose_opt("pinnedAt",pinned),choose_opt("archivedAt",archived),custom||input.get("title").is_some(),now])?;
        let event=Event{id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"project".into(),stream_id:project_id.into(),event_type:"project.meta-updated".into(),occurred_at:now.into(),command_id:Some(command_id.into()),causation_event_id:None,correlation_id:Some(command_id.into()),actor_kind:"client".into(),payload,metadata:json!({})};
        let stored=event_store::append(tx,&[event])?;receipt.result_sequence=stored.last().unwrap().sequence;event_store::upsert_receipt(tx,&receipt)?;Ok((receipt,stored))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_preserves_legacy_scripts_and_replays_rejections() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let script = json!({"id":"an-old-invalid-script-id-longer-than-24","name":"old","command":"true","icon":"play","runOnWorktreeCreate":false});
        db.execute("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('p','Old','/old',?1,'2025','2025')",[json!([script]).to_string()]).unwrap();
        let bus = EventBus::new(db, 16);
        let now = "2026-01-01T00:00:00.000Z";
        let change = json!({"title":"New","scripts":[script],"pinned":true,"archived":true});
        assert!(validate(&change));
        let first = dispatch(&bus, "c", "p", &change, now).unwrap();
        assert_eq!(first.status, "accepted");
        assert_eq!(dispatch(&bus, "c", "p", &json!({}), now).unwrap(), first);
        let bad = json!({"scripts":[{"id":"bad.id","name":"new","command":"true","icon":"play","runOnWorktreeCreate":false}]});
        assert!(validate(&bad));
        let rejected = dispatch(&bus, "bad", "p", &bad, now).unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(
            dispatch(&bus, "bad", "p", &json!({}), now).unwrap(),
            rejected
        );
        bus.commit(|tx| {let (title,pin,archive,custom):(String,Option<String>,Option<String>,bool)=tx.query_row("SELECT title,pinned_at,archived_at,has_custom_title FROM projection_projects WHERE project_id='p'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;assert_eq!(title,"New");assert_eq!(pin.as_deref(),Some(now));assert_eq!(archive.as_deref(),Some(now));assert!(custom);Ok(((),vec![]))}).unwrap();
    }
}
