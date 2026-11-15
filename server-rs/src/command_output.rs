//! Bounded, transient command output. Chunks never enter the event store.
use std::{collections::{HashMap, VecDeque}, sync::Mutex};
use tokio::sync::broadcast;

#[cfg(test)]
const TAIL_BYTES: usize = 64 * 1024;
const LIVE_LIMIT: usize = 64;
const FINISHED_LIMIT: usize = 16;

#[derive(Clone, Default)]
pub(crate) struct Tail { pub text: String, pub truncated: bool, pub finished: bool, stamp: u64, generation:u64, terminal: crate::terminal_output::TerminalOutput, sequence:u64, dropped_through:u64, raw:VecDeque<(u64,String)>, raw_units:usize }
impl Tail {
    fn append(&mut self, chunk:&str) {
        self.terminal.feed(chunk);
        (self.text,self.truncated)=self.terminal.resume();
        self.sequence=self.sequence.wrapping_add(1);
        self.raw.push_back((self.sequence,chunk.to_owned())); self.raw_units+=chunk.encode_utf16().count();
        while self.raw_units>16*1024 {
            if let Some((seq,text))=self.raw.pop_front() { self.raw_units-=text.encode_utf16().count(); self.dropped_through=seq; } else {break}
        }
    }
    fn since(&self,sequence:u64)->Option<String> {
        if sequence<self.dropped_through || sequence>self.sequence {return None}
        Some(self.raw.iter().filter(|(seq,_)|*seq>sequence).map(|(_,chunk)|chunk.as_str()).collect())
    }
}
#[derive(Default)]
struct State { values: HashMap<(String,String), Tail>, clock: u64 }
pub(crate) struct CommandOutput { state: Mutex<State>, updates: broadcast::Sender<(String,String)> }
impl Default for CommandOutput {
    fn default() -> Self { let (updates,_) = broadcast::channel(256); Self { state:Mutex::new(State::default()), updates } }
}
impl CommandOutput {
    pub fn subscribe(&self) -> broadcast::Receiver<(String,String)> { self.updates.subscribe() }
    pub fn get(&self, thread:&str, item:&str) -> Option<Tail> {
        self.state.lock().ok()?.values.get(&(thread.into(),item.into())).cloned()
    }
    pub fn append(&self, thread:&str, item:&str, chunk:&str) {
        if chunk.is_empty() { return; }
        let key=(thread.to_owned(),item.to_owned());
        if let Ok(mut state)=self.state.lock() {
            state.clock=state.clock.wrapping_add(1); let stamp=state.clock;
            let entry=state.values.entry(key.clone()).or_default();
            if entry.finished || entry.generation==0 { *entry=Tail::default(); entry.generation=stamp; }
            entry.stamp=stamp; entry.append(chunk);
            Self::evict(&mut state,false,LIVE_LIMIT);
        }
        let _=self.updates.send(key);
    }
    pub fn finish(&self,thread:&str,item:&str) {
        let key=(thread.to_owned(),item.to_owned());
        if let Ok(mut state)=self.state.lock() {
            state.clock=state.clock.wrapping_add(1); let stamp=state.clock;
            if let Some(entry)=state.values.get_mut(&key) { entry.finished=true; entry.stamp=stamp; }
            Self::evict(&mut state,true,FINISHED_LIMIT);
        }
        let _=self.updates.send(key);
    }
    fn evict(state:&mut State,finished:bool,limit:usize) {
        while state.values.values().filter(|entry|entry.finished==finished).count()>limit {
            let oldest=state.values.iter().filter(|(_,entry)|entry.finished==finished).min_by_key(|(_,entry)|entry.stamp).map(|(key,_)|key.clone());
            if let Some(key)=oldest { state.values.remove(&key); } else { break; }
        }
    }
}
pub(crate) fn bound(text:&str) -> (String,bool) {
    crate::terminal_output::normalize(text)
}
/// Subscribe before reading the projection, so settlement cannot be lost
/// between the initial snapshot and registration for subsequent updates.
pub(crate) fn stream(bus: crate::event_bus::EventBus, input: &serde_json::Value) -> tokio::sync::mpsc::Receiver<Result<Vec<serde_json::Value>, serde_json::Value>> {
    use rusqlite::OptionalExtension;
    use serde_json::{json, Value};
    let (tx,rx)=tokio::sync::mpsc::channel(1);
    let thread=input["threadId"].as_str().unwrap_or("").trim().to_owned();
    let item_id=input["itemId"].as_str().unwrap_or("").trim().to_owned();
    tokio::spawn(async move {
        let error = |message:&str| json!({"_tag":"OrchestrationV2CommandOutputError","threadId":thread,"message":message});
        if thread.is_empty() || item_id.is_empty() { let _=tx.send(Err(error("No such command."))).await; return; }
        let mut chunks=bus.command_output().subscribe();
        let (_,mut events)=match bus.subscribe_application() { Ok(v)=>v, Err(_)=>{let _=tx.send(Err(error("Failed to read command output."))).await;return} };
        let initial=bus.commit(|db| {
            let raw:Option<String>=db.query_row("SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id=?1 AND turn_item_id=?2",rusqlite::params![thread,item_id],|r|r.get(0)).optional()?;
            let item=raw.map(|s|serde_json::from_str::<Value>(&s).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()?;
            Ok((item,vec![]))
        });
        let mut item=match initial { Ok(Some(item)) if item["type"]=="command_execution"=>item, Ok(_)=>{let _=tx.send(Err(error("No such command."))).await;return}, Err(_)=>{let _=tx.send(Err(error("Failed to read command output."))).await;return} };
        let mut previous_sequence=0; let mut previous_generation=None; let mut first=true; let mut force_replace=false;
        let mut last_frame=None; let mut throttle=std::time::Duration::from_millis(100);
        loop {
            let running=matches!(item["status"].as_str(),Some("pending"|"running"|"waiting"));
            if let Some(last)=last_frame {
                tokio::time::sleep_until(last+throttle).await;
            }
            let tail=bus.command_output().get(&thread,&item_id);
            let persisted=item["output"].as_str();
            let (text,truncated)=if running { tail.as_ref().map(|v|(v.text.clone(),v.truncated)).unwrap_or_else(||bound(persisted.unwrap_or(""))) }
                else if let Some(output)=persisted { bound(output) }
                else { tail.as_ref().map(|v|(v.terminal.text().0,v.truncated)).unwrap_or_default() };
            let same_generation=tail.as_ref().is_some_and(|tail|previous_generation.is_none() || Some(tail.generation)==previous_generation);
            let pending_chunks=if running && !first && !force_replace && same_generation {tail.as_ref().and_then(|tail|tail.since(previous_sequence))} else {None};
            let overflow=running && !first && !force_replace && same_generation && pending_chunks.is_none();
            let append=pending_chunks.is_some();
            let frame_text=pending_chunks.as_deref().unwrap_or(&text);
            if first || !running || !append || !frame_text.is_empty() {
                let frame=json!({"kind":if append {"append"} else {"replace"},"text":frame_text,"truncated":truncated,"running":running});
                if tx.send(Ok(vec![frame])).await.is_err() { return; }
                last_frame=Some(tokio::time::Instant::now());
                throttle=std::time::Duration::from_millis(if overflow {500} else {100});
            }
            first=false; force_replace=false;
            if let Some(tail)=tail { previous_sequence=tail.sequence; previous_generation=Some(tail.generation); }
            if !running { return; }
            loop {
                tokio::select! {
                    _=tx.closed()=>return,
                    result=chunks.recv()=>match result {
                        Ok((t,i)) if t==thread && i==item_id=>break,
                        Ok(_)=>{},
                        Err(broadcast::error::RecvError::Lagged(_))=>{force_replace=true;break},
                        Err(_)=>{let _=tx.send(Err(error("Lost the thread's event stream."))).await;return}
                    },
                    result=events.recv()=>match result {
                        Ok(event) if event.event.event_type=="turn-item.updated" && event.event.payload["threadId"]==thread && event.event.payload["id"]==item_id=>{
                            if item["output"] != event.event.payload["output"] || item["status"] != event.event.payload["status"] { force_replace=true; }
                            item=event.event.payload;break
                        },
                        Ok(_)=>{},
                        Err(broadcast::error::RecvError::Lagged(_))=>{let _=tx.send(Err(error("Lost the thread's event stream."))).await;return},
                        Err(_)=>{let _=tx.send(Err(error("Lost the thread's event stream."))).await;return}
                    }
                }
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn subscription_streams_without_persisting_chunks_and_settles() {
        use serde_json::json;
        let mut db=rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus=crate::event_bus::EventBus::new(db,32);
        let running=json!({"id":"item","threadId":"t","type":"command_execution","status":"running"});
        bus.commit(|tx| {
            tx.execute("INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES('item','t',1,'command_execution','running','now',?1)",[running.to_string()])?;
            Ok(((),vec![]))
        }).unwrap();
        let mut rx=stream(bus.clone(),&json!({"threadId":"t","itemId":"item"}));
        let initial=rx.recv().await.unwrap().unwrap();
        assert_eq!(initial[0],json!({"kind":"replace","text":"","truncated":false,"running":true}));
        bus.command_output().append("t","item","hello");
        let next=tokio::time::timeout(std::time::Duration::from_secs(2),rx.recv()).await.unwrap().unwrap().unwrap();
        assert_eq!(next[0],json!({"kind":"append","text":"hello","truncated":false,"running":true}));
        bus.command_output().append("t","item",&"x".repeat(17*1024));
        let replacement=tokio::time::timeout(std::time::Duration::from_secs(2),rx.recv()).await.unwrap().unwrap().unwrap();
        assert_eq!(replacement[0]["kind"],"replace");
        assert_eq!(replacement[0]["text"].as_str().unwrap().len(),5+17*1024);
        let count:i64=bus.commit(|tx|Ok((tx.query_row("SELECT count(*) FROM orchestration_events",[],|r|r.get(0))?,vec![]))).unwrap();
        assert_eq!(count,0,"transient chunks must not be persisted");
        let after_overflow=tokio::time::Instant::now();
        let done=json!({"id":"item","threadId":"t","type":"command_execution","status":"completed","output":"hello final"});
        bus.commit(|tx| {
            tx.execute("UPDATE orchestration_v2_projection_turn_items SET status='completed',payload_json=?1 WHERE turn_item_id='item'",[done.to_string()])?;
            let event=crate::event_store::Event {id:uuid::Uuid::new_v4().to_string(),aggregate_kind:"thread".into(),stream_id:"t".into(),event_type:"turn-item.updated".into(),occurred_at:"now".into(),command_id:None,causation_event_id:None,correlation_id:None,actor_kind:"provider".into(),payload:done,metadata:json!({})};
            Ok(((),crate::event_store::append(tx,&[event])?))
        }).unwrap();
        let final_frame=tokio::time::timeout(std::time::Duration::from_secs(2),rx.recv()).await.unwrap().unwrap().unwrap();
        assert!(after_overflow.elapsed()>=std::time::Duration::from_millis(400), "overflow replacement must throttle the next frame");
        assert_eq!(final_frame[0],json!({"kind":"replace","text":"hello final","truncated":false,"running":false}));
        assert!(rx.recv().await.is_none());
    }
    #[tokio::test]
    async fn missing_command_is_rejected() {
        let mut db=rusqlite::Connection::open_in_memory().unwrap();
        crate::migrations::run_ported_migrations(&mut db).unwrap();
        let bus=crate::event_bus::EventBus::new(db,8);
        let mut rx=stream(bus,&serde_json::json!({"threadId":"t","itemId":"missing"}));
        assert_eq!(rx.recv().await.unwrap().unwrap_err()["message"],"No such command.");
    }
    #[test]
    fn tails_are_bounded_and_evicted() {
        let hub=CommandOutput::default();
        hub.append("t","a",&"é".repeat(TAIL_BYTES+10));
        let tail=hub.get("t","a").unwrap(); assert!(tail.truncated); assert!(tail.text.encode_utf16().count()<=TAIL_BYTES); assert!(tail.text.is_char_boundary(0));
        for i in 0..LIVE_LIMIT { hub.append("t",&i.to_string(),"x"); }
        assert!(hub.get("t","a").is_none());
        for i in 0..LIVE_LIMIT { hub.finish("t",&i.to_string()); }
        assert!(hub.get("t","0").is_none()); assert!(hub.get("t","63").unwrap().finished);
    }
}
