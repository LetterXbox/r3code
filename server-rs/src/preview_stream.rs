//! Authenticated preview viewer, with one explicit controller per tab.
use crate::{
    auth::Principal,
    auth_http::AuthHttpState,
    preview_browser::{BrowserPool, BrowserSession},
    preview_manager::PreviewManager,
};
use axum::extract::ws::{Message, WebSocket};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

fn control(session: &BrowserSession, owner: Option<&str>, viewer: &str, allowed: bool) -> Value {
    json!({"type":"control","canOperate":allowed,"controller":match owner {Some(id) if id==viewer=>"you",Some(_)=>"another-viewer",None=>"unclaimed"},"generation":session.generation.load(Ordering::Relaxed),"dialog":null})
}
fn nav_status(manager: &PreviewManager, thread: &str, tab: &str, result: &Value) {
    if let (Some(url), Some(title)) = (result["url"].as_str(), result["title"].as_str()) {
        let _=manager.report_server(&json!({"threadId":thread,"tabId":tab,"navStatus":{"_tag":"Success","url":url,"title":title},"canGoBack":result["canGoBack"].as_bool().unwrap_or(false),"canGoForward":result["canGoForward"].as_bool().unwrap_or(false)}));
    }
}
pub struct ViewerContext {
    pub pool: Arc<BrowserPool>,
    pub manager: Arc<PreviewManager>,
    pub auth: Arc<AuthHttpState>,
    pub principal: Principal,
    pub thread: String,
    pub tab: String,
    pub allowed: bool,
}
pub async fn run(mut socket: WebSocket, context: ViewerContext) {
    let ViewerContext {
        pool,
        manager,
        auth,
        principal,
        thread,
        tab,
        allowed,
    } = context;
    let Some(snapshot) = manager
        .snapshot(&thread, &tab)
        .filter(|s| s["runtime"] == "server")
    else {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "tab closed".into(),
            })))
            .await;
        return;
    };
    let session = match pool.get_or_start(&thread, &tab).await {
        Ok(s) => s,
        Err(_) => {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1011,
                    reason: "browser unavailable".into(),
                })))
                .await;
            return;
        }
    };
    if manager.snapshot(&thread, &tab).is_none() {
        pool.close(&thread, Some(&tab)).await;
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4404,
                reason: "tab closed".into(),
            })))
            .await;
        return;
    }
    // A freshly attached worker starts blank. Navigation is deliberately bounded
    // and HTTP(S)-only; the browser process owns its isolated context.
    if snapshot["navStatus"]["_tag"] == "Loading" {
        if let Some(url) = snapshot["navStatus"]["url"].as_str() {
            if let Ok(result) = session
                .worker
                .request(json!({"op":"navigate","url":url}))
                .await
            {
                nav_status(&manager, &thread, &tab, &result);
            }
        }
    }
    let viewer = uuid::Uuid::new_v4().to_string();
    let mut updates = session.control_changes.subscribe();
    let owner = session.controller.lock().await.clone();
    if socket
        .send(Message::Text(
            control(&session, owner.as_deref(), &viewer, allowed)
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    if socket
        .send(Message::Text(
            json!({"type":"viewport","width":1280,"height":800})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut timer = tokio::time::interval(Duration::from_millis(200));
    let mut ready = true;
    loop {
        tokio::select! {
            _=timer.tick()=>{
                if !crate::application::session_current(&auth,&principal) || manager.snapshot(&thread,&tab).is_none() {break;}
                if ready { let result=session.worker.request(json!({"op":"screenshot","quality":70})).await;
                    let Some(bytes)=result.ok().and_then(|v|v["jpeg"].as_str().and_then(|s|STANDARD.decode(s).ok())) else {break;};
                    if !crate::application::session_current(&auth,&principal) || manager.snapshot(&thread,&tab).is_none() {break;}
                    if socket.send(Message::Binary(bytes.into())).await.is_err(){break;} ready=false;
                }
            },
            changed=updates.changed()=>{if changed.is_err(){break;}let owner=updates.borrow_and_update().clone();if socket.send(Message::Text(control(&session,owner.as_deref(),&viewer,allowed).to_string().into())).await.is_err(){break;}},
            message=socket.next()=>{let Some(Ok(message))=message else {break};let Message::Text(text)=message else {continue};let Ok(input)=serde_json::from_str::<Value>(&text) else {continue};
                if !crate::application::session_current(&auth,&principal) || manager.snapshot(&thread,&tab).is_none() {break;}
                match input["type"].as_str(){
                    Some("ack")=>{ready=true;continue},
                    Some("takeControl") if allowed=>{let mut owner=session.controller.lock().await;let _=session.worker.request(json!({"op":"releaseInputs"})).await;*owner=Some(viewer.clone());session.generation.fetch_add(1,Ordering::Relaxed);session.control_changes.send_replace(owner.clone());continue},
                    Some("releaseControl") if allowed=>{let mut owner=session.controller.lock().await;if owner.as_deref()==Some(&viewer){let _=session.worker.request(json!({"op":"releaseInputs"})).await;*owner=None;session.generation.fetch_add(1,Ordering::Relaxed);session.control_changes.send_replace(None);}continue},
                    _=>()
                }
                let owner_guard=session.controller.lock().await;
                if !allowed || owner_guard.as_deref()!=Some(&viewer) {continue;}
                let command=match input["type"].as_str(){
                    Some("navigate")=>input["url"].as_str().and_then(crate::preview_manager::normalize_url).map(|url|json!({"op":"navigate","url":url})),
                    Some("resize")=>Some(json!({"op":"resize","width":input["width"],"height":input["height"]})),
                    Some("mouse")=>Some(json!({"op":"mouse","action":input["action"],"x":input["x"],"y":input["y"],"button":input["button"],"clickCount":input["clickCount"],"buttons":input["buttons"],"modifiers":input["modifiers"]})),
                    Some("wheel")=>Some(json!({"op":"scroll","x":input["deltaX"],"y":input["deltaY"],"atX":input["x"],"atY":input["y"],"modifiers":input["modifiers"]})),
                    Some("key")=>Some(json!({"op":"key","action":input["action"],"key":input["key"],"code":input["code"],"keyCode":input["keyCode"],"text":input["text"],"modifiers":input["modifiers"]})),
                    Some("text")=>Some(json!({"op":"type","text":input["text"]})),
                    Some("history")=>Some(json!({"op":"history","delta":input["delta"]})),
                    Some("reload")=>Some(json!({"op":"reload"})),
                    _=>None,
                };
                if let Some(command)=command {
                    let resize = command["op"] == "resize"; let width=command["width"].clone(); let height=command["height"].clone();
                    if let Ok(result)=session.worker.request(command).await {
                        nav_status(&manager,&thread,&tab,&result);
                        if resize && socket.send(Message::Text(json!({"type":"viewport","width":width,"height":height}).to_string().into())).await.is_err() {break;}
                    }
                }
                drop(owner_guard);
            }
        }
    }
    let mut owner = session.controller.lock().await;
    if owner.as_deref() == Some(&viewer) {
        let _ = session.worker.request(json!({"op":"releaseInputs"})).await;
        *owner = None;
        session.generation.fetch_add(1, Ordering::Relaxed);
        session.control_changes.send_replace(None);
    }
}
