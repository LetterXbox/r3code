//! Pi process/session RPC operations. Turn admission and event pumping live above this layer.
use super::pi_rpc::PiRpc;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
const REQUEST: Duration = Duration::from_secs(30);
const LIFECYCLE: Duration = Duration::from_secs(60);
pub(crate) struct PiSession {
    pub(crate) rpc: Arc<PiRpc>,
    pub(crate) session_file: PathBuf,
    pub(crate) leaf: Option<String>,
    models: Vec<Value>,
    baseline_model: Option<(String, String)>,
    baseline_thinking: Option<String>,
    applied_model: Option<String>,
    applied_thinking: Option<String>,
}
impl PiSession {
    pub(crate) async fn spawn(
        command: &str,
        args: &[String],
        cwd: Option<&Path>,
        env: &[(String, String)],
        resume: Option<&Path>,
    ) -> Result<Self, String> {
        let rpc = Arc::new(PiRpc::spawn(command, args, cwd, env).await?);
        Self::connect(rpc, resume).await
    }
    pub(crate) async fn connect(rpc: Arc<PiRpc>, resume: Option<&Path>) -> Result<Self, String> {
        if let Some(path) = resume {
            if !path.is_absolute() {
                return Err("Pi session path must be absolute".into());
            }
            let result = rpc
                .request(
                    json!({"type":"switch_session","sessionPath":path}),
                    LIFECYCLE,
                )
                .await?;
            if result["cancelled"] == true {
                return Err("A Pi extension cancelled the session switch".into());
            }
        }
        let state = rpc.request(json!({"type":"get_state"}), REQUEST).await?;
        let file = state["sessionFile"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("Pi get_state returned no persisted sessionFile")?;
        let session_file = PathBuf::from(file);
        if !session_file.is_absolute() {
            return Err("Pi session path must be absolute".into());
        }
        if resume.is_some_and(|path| path != session_file) {
            return Err("Pi resumed an unexpected session file".into());
        }
        let baseline_model = state["model"]["provider"]
            .as_str()
            .zip(state["model"]["id"].as_str())
            .map(|(provider, id)| (provider.to_owned(), id.to_owned()));
        let baseline_thinking = state["thinkingLevel"].as_str().map(str::to_owned);
        let available = rpc
            .request(json!({"type":"get_available_models"}), REQUEST)
            .await?;
        let models = available["models"]
            .as_array()
            .cloned()
            .ok_or("Invalid Pi model list")?;
        let entries = rpc.request(json!({"type":"get_entries"}), REQUEST).await?;
        let leaf = entries["leafId"].as_str().map(str::to_owned);
        Ok(Self {
            rpc,
            session_file,
            leaf,
            models,
            baseline_model,
            baseline_thinking,
            applied_model: None,
            applied_thinking: None,
        })
    }
    pub(crate) async fn select(
        &mut self,
        slug: &str,
        thinking: Option<&str>,
    ) -> Result<(), String> {
        if slug == "default" {
            if self.applied_model.is_some() {
                let (provider, id) = self
                    .baseline_model
                    .as_ref()
                    .ok_or("Pi has no baseline model")?;
                self.rpc
                    .request(
                        json!({"type":"set_model","provider":provider,"modelId":id}),
                        REQUEST,
                    )
                    .await?;
                self.applied_model = None;
                self.applied_thinking = None;
            }
            if thinking.is_none() {
                if let Some(level) = &self.baseline_thinking {
                    if self.applied_thinking.as_deref() != Some(level) {
                        self.rpc
                            .request(json!({"type":"set_thinking_level","level":level}), REQUEST)
                            .await?;
                        self.applied_thinking = Some(level.clone());
                    }
                }
            }
        } else if self.applied_model.as_deref() != Some(slug) {
            if !self.models.iter().any(|model| {
                model["provider"]
                    .as_str()
                    .zip(model["id"].as_str())
                    .is_some_and(|(provider, id)| format!("{provider}/{id}") == slug)
            }) {
                let value = self
                    .rpc
                    .request(json!({"type":"get_available_models"}), REQUEST)
                    .await?;
                self.models = value["models"]
                    .as_array()
                    .cloned()
                    .ok_or("Invalid Pi model list")?;
            }
            let resolved = self.models.iter().find_map(|model| {
                model["provider"]
                    .as_str()
                    .zip(model["id"].as_str())
                    .filter(|(provider, id)| format!("{provider}/{id}") == slug)
            });
            let (provider, id) = resolved
                .or_else(|| {
                    slug.split_once('/')
                        .filter(|(provider, id)| !provider.is_empty() && !id.is_empty())
                })
                .ok_or("Pi model must use provider/model format")?;
            self.rpc
                .request(
                    json!({"type":"set_model","provider":provider,"modelId":id}),
                    REQUEST,
                )
                .await?;
            self.applied_model = Some(slug.into());
            self.applied_thinking = None;
        }
        if let Some(level) = thinking {
            if ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&level)
                && self.applied_thinking.as_deref() != Some(level)
            {
                self.rpc
                    .request(json!({"type":"set_thinking_level","level":level}), REQUEST)
                    .await?;
                self.applied_thinking = Some(level.into());
            }
        }
        Ok(())
    }
    pub(crate) async fn prompt(&self, text: &str, images: &[Value]) -> Result<(), String> {
        let mut value = json!({"type":"prompt","message":text,"streamingBehavior":"steer"});
        if !images.is_empty() {
            value["images"] = json!(images);
        }
        self.rpc.send(&value).await
    }
    pub(crate) async fn idle(&self) -> Result<bool, String> {
        let state = self
            .rpc
            .request(json!({"type":"get_state"}), REQUEST)
            .await?;
        let streaming = state["isStreaming"]
            .as_bool()
            .ok_or("Invalid Pi streaming state")?;
        let compacting = state["isCompacting"]
            .as_bool()
            .ok_or("Invalid Pi compaction state")?;
        let queued = state["pendingMessageCount"]
            .as_u64()
            .ok_or("Invalid Pi pending message count")?;
        Ok(!streaming && !compacting && queued == 0)
    }
    pub(crate) async fn interrupt(&self) -> Result<(), String> {
        self.rpc
            .request(json!({"type":"clear_queue"}), REQUEST)
            .await?;
        self.rpc.request(json!({"type":"abort"}), REQUEST).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_setup_reaps_uncooperative_process() {
        let path = std::env::temp_dir().join(format!("pi-setup-{}", uuid::Uuid::new_v4()));
        let script = r#"import os,sys,json,time
open(sys.argv[1],'w').write(str(os.getpid()))
r=json.loads(sys.stdin.readline())
print(json.dumps({'type':'response','command':'get_state','id':r['id'],'success':True,'data':{}}),flush=True)
time.sleep(60)
"#;
        let result = PiSession::spawn(
            "python3",
            &[
                "-u".into(),
                "-c".into(),
                script.into(),
                path.to_string_lossy().into_owned(),
            ],
            None,
            &[],
            None,
        )
        .await;
        assert!(result.is_err());
        let pid = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);
        let mut gone = false;
        for _ in 0..100 {
            let running = std::process::Command::new("kill")
                .args(["-0", pid.trim()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success();
            if !running {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(gone, "Pi child survived failed setup");
    }
    #[tokio::test]
    async fn recorded_session_selects_model_prompts_and_probes_idle() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/mock-pi");
        let mut session = PiSession::spawn(fixture.to_str().unwrap(), &[], None, &[], None)
            .await
            .unwrap();
        assert!(session.session_file.is_absolute());
        assert!(session.leaf.is_some());
        session
            .select("openrouter/deepseek/deepseek-v4-flash", None)
            .await
            .unwrap();
        session.prompt("hello", &[]).await.unwrap();
        let mut settled = false;
        for _ in 0..64 {
            let event = tokio::time::timeout(Duration::from_secs(2), session.rpc.next_event())
                .await
                .unwrap()
                .unwrap();
            if event["type"] == "agent_settled" {
                settled = true;
                break;
            }
        }
        assert!(settled);
        assert!(session.idle().await.unwrap());
        session.interrupt().await.unwrap();
        session.rpc.terminate().await;
    }
}
