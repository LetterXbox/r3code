//! Validation and transactional admission for a local MCP delegated task.
use crate::{
    delegated_create::{self, DelegatedRequest},
    event_bus::EventBus,
    event_store,
    mcp_credentials::Scope,
};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::path::Path;

type Failure = (&'static str, String);
fn invalid(message: impl Into<String>) -> Failure {
    ("invalid_request", message.into())
}
fn text<'a>(obj: &'a Value, key: &str, max: usize) -> Result<Option<&'a str>, Failure> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s))
            if !s.trim().is_empty() && s.trim().encode_utf16().count() <= max =>
        {
            Ok(Some(s.trim()))
        }
        _ => Err(invalid(format!("Invalid {key}."))),
    }
}
fn mode_rank(m: &str) -> Option<u8> {
    match m {
        "approval-required" => Some(0),
        "auto-accept-edits" => Some(1),
        "auto" => Some(2),
        "full-access" => Some(3),
        _ => None,
    }
}
fn stable_part(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub struct Started {
    pub task_id: String,
    pub request_key: String,
    pub wait: bool,
    pub timeout_ms: Option<u64>,
}
/// The caller supplies a fresh settings snapshot and the advertised provider.
pub fn start(
    bus: &EventBus,
    scope: &Scope,
    args: &Value,
    settings: &Value,
    providers: &[Value],
    environment: &str,
    worktrees: &Path,
) -> Result<Started, Failure> {
    let obj = args
        .as_object()
        .ok_or_else(|| invalid("Arguments must be an object."))?;
    if obj.keys().any(|k| {
        ![
            "task",
            "target",
            "title",
            "role",
            "isolation",
            "mode",
            "timeoutMs",
            "clientRequestId",
            "runtimeMode",
            "interactionMode",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Unknown delegation argument."));
    }
    let task = text(args, "task", 120_000)?.ok_or_else(|| invalid("task is required."))?;
    let title = text(args, "title", 512)?;
    let role = text(args, "role", 32)?.unwrap_or("general");
    if ![
        "implementation",
        "research",
        "review",
        "design",
        "test",
        "general",
    ]
    .contains(&role)
    {
        return Err(invalid("Invalid task role."));
    }
    let isolation = text(args, "isolation", 32)?.unwrap_or("shared");
    if !["shared", "worktree"].contains(&isolation) {
        return Err(invalid("Invalid isolation."));
    }
    let mode = text(args, "mode", 32)?.unwrap_or("async");
    if !["async", "wait"].contains(&mode) {
        return Err(invalid("Invalid mode."));
    }
    let timeout = match args.get("timeoutMs") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| invalid("Invalid timeoutMs."))?;
            Some(n.clamp(1.0, 3_600_000.0) as u64)
        }
    };
    let requested_runtime = text(args, "runtimeMode", 32)?;
    let requested_interaction = text(args, "interactionMode", 32)?;
    let key = text(args, "clientRequestId", 256)?
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let command = format!(
        "command:mcp:{}:delegate-task:{}",
        stable_part(&scope.provider_session_id),
        stable_part(&key)
    );
    let task_id = format!("node:delegated-task:{command}");
    let target = args
        .get("target")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let target_obj = target
        .as_object()
        .ok_or_else(|| invalid("Invalid target."))?;
    if target_obj.keys().any(|k| {
        ![
            "providerInstanceId",
            "driverKind",
            "model",
            "options",
            "environmentId",
            "projectId",
        ]
        .contains(&k.as_str())
    }) {
        return Err(invalid("Invalid target."));
    }
    if text(&target, "environmentId", 256)?.is_some_and(|v| v != environment) {
        return Err((
            "environment_unavailable",
            "Remote linked environments are not supported.".into(),
        ));
    }
    let (parent,run,project_root,project_title,replay)=bus.commit(|tx|{
  let parent:Option<(String,String,String)>=tx.query_row("SELECT payload_json,runtime_mode,interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id=?1 AND deleted_at IS NULL AND archived_at IS NULL",[&scope.thread_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
  let Some((raw,runtime,interaction))=parent else {return Ok((None,vec![]));};let mut parent:Value=serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)?;parent["runtimeMode"]=json!(runtime);parent["interactionMode"]=json!(interaction);
  let raw:Option<String>=tx.query_row("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id=?1 AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1",[&scope.thread_id],|r|r.get(0)).optional()?;let run:Value=raw.and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
  let project:Option<(String,String)>=tx.query_row("SELECT workspace_root,title FROM projection_projects WHERE project_id=?1 AND deleted_at IS NULL",[parent["projectId"].as_str()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
  let Some((root,title))=project else {return Ok((None,vec![]));};let replay=event_store::get_receipt(tx,&command,"thread")?.is_some();Ok((Some((parent,run,root,title,replay)),vec![]))
 }).map_err(|e|("orchestration_error",e.to_string()))?.ok_or_else(||("thread_not_found","Calling thread or project is unavailable.".into()))?;
    if text(&target, "projectId", 256)?.is_some_and(|id| parent["projectId"] != id) {
        return Err(invalid("A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project."));
    }
    if run["rootNodeId"].as_str().is_none()
        || run["providerInstanceId"] != scope.provider_instance_id
    {
        return Err((
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.".into(),
        ));
    }
    let parent_runtime = parent["runtimeMode"].as_str().unwrap_or("full-access");
    let runtime = requested_runtime
        .filter(|m| *m != "inherit")
        .unwrap_or(parent_runtime);
    if mode_rank(runtime).is_none() || mode_rank(parent_runtime).is_none() {
        return Err(invalid("Invalid runtime mode."));
    }
    if mode_rank(runtime) > mode_rank(parent_runtime) {
        return Err((
            "runtime_mode_escalation_denied",
            format!("Child runtime mode {runtime} is broader than parent mode {parent_runtime}."),
        ));
    }
    let parent_interaction = parent["interactionMode"].as_str().unwrap_or("default");
    let interaction = requested_interaction
        .filter(|m| *m != "inherit")
        .unwrap_or(parent_interaction);
    if !["default", "plan"].contains(&interaction) {
        return Err(invalid("Invalid interaction mode."));
    }
    if parent_interaction == "plan" && interaction == "default" {
        return Err(("interaction_mode_escalation_denied",format!("Child interaction mode {interaction} is broader than parent mode {parent_interaction}.")));
    }
    let inherited = &parent["modelSelection"];
    let requested_driver = text(&target, "driverKind", 128)?;
    let instance = text(&target, "providerInstanceId", 256)?
        .or_else(|| {
            if let Some(driver) = requested_driver {
                providers
                    .iter()
                    .find(|p| p["driver"] == driver)
                    .and_then(|p| p["instanceId"].as_str())
            } else {
                inherited["instanceId"].as_str()
            }
        })
        .unwrap_or("codex");
    let provider = providers
        .iter()
        .find(|p| p["instanceId"] == instance)
        .ok_or_else(|| {
            (
                "provider_unavailable",
                format!("Provider {instance} is not available."),
            )
        })?;
    let driver = provider["driver"].as_str().unwrap_or("");
    if driver != "codex" || requested_driver.is_some_and(|requested| requested != driver) {
        return Err(("provider_unavailable",format!("Provider {instance} cannot run a child task: No V2 provider adapter is registered.")));
    }
    let enabled = settings["projectSettingsOverrides"][parent["projectId"].as_str().unwrap_or("")]
        ["providerInstances"][instance]["enabled"]
        .as_bool()
        .or_else(|| settings["providerInstances"][instance]["enabled"].as_bool())
        .unwrap_or(true);
    if !replay
        && (!enabled
            || provider["installed"] == false
            || provider["status"] == "error"
            || provider["auth"]["status"] == "unauthenticated")
    {
        return Err((
            "provider_unavailable",
            format!("Provider {instance} is unavailable or disabled."),
        ));
    }
    let model = text(&target, "model", 512)?
        .or_else(|| {
            if inherited["instanceId"] == instance {
                inherited["model"].as_str()
            } else {
                provider["models"]
                    .as_array()
                    .and_then(|models| models.first())
                    .and_then(|model| model["slug"].as_str())
            }
        })
        .ok_or_else(|| {
            (
                "model_unavailable",
                "No model is available for delegation.".into(),
            )
        })?;
    if !replay
        && provider["models"].as_array().is_some_and(|models| {
            !models.is_empty()
                && !models.iter().any(|m| {
                    m["slug"] == model
                        || m["aliases"].as_array().is_some_and(|a| {
                            a.iter()
                                .any(|v| v.as_str().is_some_and(|a| a.eq_ignore_ascii_case(model)))
                        })
                })
        })
    {
        return Err((
            "model_unavailable",
            format!("Model {model} is not advertised by provider {instance}."),
        ));
    }
    let inherited_options = if inherited["instanceId"] == instance && inherited["model"] == model {
        inherited["options"].as_array().cloned().unwrap_or_default()
    } else {
        vec![]
    };
    let mut selection = json!({"instanceId":instance,"model":model});
    if let Some(options) = target.get("options").filter(|v| !v.is_null()) {
        let normalized = crate::application::normalize_provider_options(options)
            .and_then(|v| v.as_array().cloned())
            .ok_or_else(|| invalid("Invalid model options."))?;
        let mut seen = std::collections::HashSet::new();
        let descriptors = provider["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| {
                m["slug"] == model
                    || m["aliases"].as_array().is_some_and(|a| {
                        a.iter()
                            .any(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(model)))
                    })
            })
            .and_then(|m| m["capabilities"]["optionDescriptors"].as_array());
        for option in &normalized {
            let id = option["id"].as_str().unwrap_or("");
            if !seen.insert(id) {
                return Err(invalid(format!(
                    "Option {id} was specified more than once."
                )));
            }
            if let Some(descriptors) = descriptors {
                let descriptor = descriptors
                    .iter()
                    .find(|d| d["id"] == id)
                    .ok_or_else(|| invalid(format!("Unknown option {id}.")))?;
                if descriptor["type"] == "boolean" && !option["value"].is_boolean() {
                    return Err(invalid(format!("Option {id} expects a boolean value.")));
                }
                if descriptor["type"] != "boolean"
                    && !descriptor["options"].as_array().is_some_and(|values| {
                        values.iter().any(|value| value["id"] == option["value"])
                    })
                {
                    return Err(invalid(format!("Option {id} has an unsupported value.")));
                }
            }
        }
        let mut merged = if normalized.is_empty() {
            vec![]
        } else {
            inherited_options
        };
        for option in normalized {
            merged.retain(|old| old["id"] != option["id"]);
            merged.push(option);
        }
        selection["options"] = json!(merged);
    } else if !inherited_options.is_empty() {
        selection["options"] = json!(inherited_options);
    }
    let prompt = if role == "general" {
        task.to_owned()
    } else {
        format!("Act as the {role} sub-agent for this task.\n\n{task}")
    };
    let root = Path::new(&project_root);
    let worktree = parent["worktreePath"].as_str().map(Path::new);
    let prepared = if isolation == "worktree" && !replay {
        Some(
            crate::delegated_worktree::prepare(root, &project_title, worktree, worktrees)
                .map_err(|e| (e.code, e.message))?,
        )
    } else {
        None
    };
    let cwd = prepared
        .as_ref()
        .map(|w| w.path.to_string_lossy().into_owned())
        .unwrap_or_else(|| worktree.unwrap_or(root).to_string_lossy().into_owned());
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result = delegated_create::dispatch(
        bus,
        DelegatedRequest {
            command_id: &command,
            parent_thread_id: &scope.thread_id,
            parent_run_id: run["id"].as_str().unwrap_or(""),
            parent_node_id: run["rootNodeId"].as_str().unwrap_or(""),
            task: &prompt,
            title,
            model_selection: &selection,
            runtime_mode: runtime,
            interaction_mode: interaction,
            completion_wake: if mode == "wait" {
                "settled_only"
            } else {
                "always"
            },
            driver,
            cwd: &cwd,
            isolated_branch: prepared.as_ref().map(|w| w.branch.as_str()),
            isolated_worktree: prepared.as_ref().and_then(|w| w.path.to_str()),
        },
        &now,
    );
    if !result.as_ref().is_ok_and(|r| r.committed) {
        if let Some(w) = &prepared {
            let _ = crate::delegated_worktree::cleanup(root, w);
        }
    }
    let result = result.map_err(|e| {
        (
            "orchestration_error",
            format!("Unable to create delegated task: {e}"),
        )
    })?;
    if let Some(error) = result.receipt.error {
        return Err((
            "orchestration_error",
            format!("Unable to create delegated task: {error}"),
        ));
    }
    Ok(Started {
        task_id,
        request_key: key,
        wait: mode == "wait",
        timeout_ms: timeout,
    })
}
