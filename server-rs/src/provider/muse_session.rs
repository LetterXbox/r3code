//! Muse native session admission and turn commands.
use super::muse_msp::MuseMsp;
use serde_json::{json, Value};

/// Allocate a UUIDv7 command identity as required by the Muse SDK.
pub(crate) fn command_id() -> Result<String, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static LAST: AtomicU64 = AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_millis();
    if millis >= (1u128 << 48) {
        return Err("Invalid clock".into());
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "Cannot allocate Muse command ID")?;
    let now = (millis as u64) << 12;
    let previous = LAST
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |last| {
            Some(if now > last {
                now
            } else {
                last.saturating_add(1)
            })
        })
        .map_err(|_| "Cannot allocate Muse command ID")?;
    let packed = if now > previous {
        now
    } else {
        previous.saturating_add(1)
    };
    bytes[..6].copy_from_slice(&(packed >> 12).to_be_bytes()[2..]);
    bytes[6] = 0x70 | ((packed >> 8) as u8 & 0x0f);
    bytes[7] = packed as u8;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

pub(crate) struct MuseSession {
    pub(crate) host: MuseMsp,
    pub(crate) id: String,
}
impl MuseSession {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open(
        mut host: MuseMsp,
        id: &str,
        cwd: &str,
        mode: &str,
        model: Option<&str>,
        resume: bool,
        mcp: Option<&Value>,
    ) -> Result<Self, String> {
        if id.is_empty() || cwd.is_empty() {
            return Err("Invalid Muse session identity".into());
        }
        let initialized = host.initialize().await?;
        if mcp.is_some()
            && !initialized["grantedCapabilities"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value == "sessionMcp"))
        {
            return Err("Muse does not support session MCP".into());
        }
        let profile = if mode == "full-access" {
            ":unrestricted"
        } else {
            ":ask-me"
        };
        let mut params = if resume {
            json!({"sessionId":id,"excludeItems":true,"permissionProfile":profile})
        } else {
            json!({"sessionId":id,"workspaceRoot":cwd,"providerId":"meta","approvalMode":if mode=="full-access" {"allowAll"} else {"promptUnmatched"},"permissionProfile":profile})
        };
        if let Some(mcp) = mcp {
            params["config"] = mcp.clone();
        }
        if !resume {
            if let Some(model) = model {
                params["modelId"] = json!(model);
            }
        }
        let admission_command = command_id()?;
        let result = host
            .command(
                if resume {
                    "session/resume"
                } else {
                    "session/start"
                },
                params,
                &admission_command,
            )
            .await?;
        if result["session"]["sessionId"] != id {
            return Err("Muse returned a different session identity".into());
        }
        if result["history"]["noneReason"] == "projectionUnavailable" {
            return Err("Muse session projection unavailable".into());
        }
        if resume {
            let command = command_id()?;
            host.command("session/setApprovalMode", json!({"sessionId":id,"mode":if mode=="full-access" {"allowAll"} else {"promptUnmatched"}}), &command).await?;
        }
        Ok(Self {
            host,
            id: id.to_owned(),
        })
    }
    pub(crate) async fn start_turn(
        &mut self,
        turn_id: &str,
        input: Value,
        display: &str,
        cwd: &str,
        effort: Option<&str>,
    ) -> Result<(), String> {
        let mut params = json!({"sessionId":self.id,"input":input,"displayText":display,"workspaceRoots":[cwd],"ifBusy":"queue"});
        if let Some(effort) = effort {
            params["reasoningEffort"] = json!(effort);
        }
        let reply = self.host.command("turn/start", params, turn_id).await?;
        if reply["turnId"] != turn_id {
            return Err("Muse admitted an unowned turn".into());
        }
        Ok(())
    }
    pub(crate) async fn interrupt(&mut self, turn_id: &str) -> Result<(), String> {
        self.host
            .command(
                "turn/interrupt",
                json!({"sessionId":self.id,"turnId":turn_id}),
                &command_id()?,
            )
            .await?;
        Ok(())
    }
    pub(crate) async fn decide_approval(
        &mut self,
        approval: &Value,
        decision: &str,
    ) -> Result<(), String> {
        if approval["sessionId"] != self.id {
            return Err("Muse approval belongs to another session".into());
        }
        let id = approval["approvalId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Invalid Muse approval")?;
        let requirement = &approval["currentRequirementId"];
        if requirement["approvalId"] != id || requirement["sourceIndex"].as_i64().is_none() {
            return Err("Invalid Muse approval requirement".into());
        }
        let choices = super::muse_events::approval_choices(approval)?;
        let choice = choices
            .get(decision)
            .and_then(|choice| choice["choiceId"].as_str())
            .ok_or("Muse did not offer this approval decision")?;
        self.host.command("approval/decide", json!({"sessionId":self.id,"approvalId":id,"requirementId":requirement,"choiceId":choice}), &command_id()?).await?;
        Ok(())
    }
    pub(crate) async fn answer_questions(
        &mut self,
        request: &Value,
        answers: &Value,
    ) -> Result<(), String> {
        if request["sessionId"] != self.id {
            return Err("Muse question belongs to another session".into());
        }
        let id = request["userInputId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Invalid Muse question request")?;
        let answers = super::muse_events::question_answers(request, answers)?;
        self.host
            .command(
                "userInput/answer",
                json!({"sessionId":self.id,"userInputId":id,"answers":answers}),
                &command_id()?,
            )
            .await?;
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{collections::HashMap, os::unix::fs::PermissionsExt};
    #[tokio::test]
    async fn enforces_session_and_turn_identity() {
        let dir = std::env::temp_dir().join(format!("t3-muse-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let script = dir.join("muse");
        std::fs::write(&script, r##"#!/usr/bin/python3
import sys,json
turn_attempts=0
for line in sys.stdin:
 v=json.loads(line);method=v['method']
 if method=='initialized':continue
 p=v['params']
 if method=='initialize':r={'schema':{'version':1,'fingerprint':'x'},'grantedCapabilities':['sessionMcp']}
 elif method=='session/start':
  assert p['permissionProfile']==':ask-me' and p['approvalMode']=='promptUnmatched' and p['sessionId']!=p['commandId'] and p['commandId'][14]=='7'
  r={'session':{'sessionId':p['sessionId']}}
 elif method=='turn/start':
  turn_attempts+=1
  if turn_attempts==1:
   print(json.dumps({'jsonrpc':'2.0','id':v['id'],'error':{'code':-32001,'message':'busy','data':{'kind':'overloaded'}}}),flush=True);continue
  assert p['commandId']=='native-turn'
  r={'turnId':p['commandId'],'commandId':p['commandId']}
 else:r={'commandId':p['commandId']}
 print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':r}),flush=True)
"##).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = MuseMsp::launch(
            script.to_str().unwrap(),
            &dir,
            "workspace-write",
            &HashMap::new(),
        )
        .await
        .unwrap();
        let mut session = MuseSession::open(
            host,
            "native-session",
            dir.to_str().unwrap(),
            "workspace-write",
            None,
            false,
            None,
        )
        .await
        .unwrap();
        session
            .start_turn(
                "native-turn",
                json!([{"type":"text","text":"hello"}]),
                "hello",
                dir.to_str().unwrap(),
                None,
            )
            .await
            .unwrap();
        let mut approval = json!({"sessionId":"other","approvalId":"approval","currentRequirementId":{"approvalId":"approval","sourceIndex":0},"availableChoices":[{"choiceId":"allow","label":"Allow","decision":"approved","scope":"once"}]});
        assert!(session.decide_approval(&approval, "accept").await.is_err());
        approval["sessionId"] = json!("native-session");
        session.decide_approval(&approval, "accept").await.unwrap();
        let questions = json!({"sessionId":"native-session","userInputId":"input","questions":[{"id":"q","options":[{"label":"one"}],"selection":{"mode":"single"}}]});
        session
            .answer_questions(&questions, &json!({"q":"one"}))
            .await
            .unwrap();
        session.interrupt("native-turn").await.unwrap();
        session.host.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
