use crate::db::{SqliteStore, Stroke};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

pub const MAX_PAYLOAD_BYTES: usize = 512 * 1024;

pub async fn run_ws_server(
    port: u16,
    store: Arc<Mutex<SqliteStore>>,
    active_pairing_token: Arc<Mutex<Option<(String, i64, bool)>>>,
) -> std::io::Result<()> {
    let addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&addr).await?;

    while let Ok((stream, _peer)) = listener.accept().await {
        let store_clone = Arc::clone(&store);
        let token_clone = Arc::clone(&active_pairing_token);

        tokio::spawn(async move {
            let ws_stream = match accept_async(stream).await {
                Ok(ws) => ws,
                Err(_) => return,
            };
            let (mut write, mut read) = ws_stream.split();
            let mut authenticated = false;

            while let Some(Ok(msg)) = read.next().await {
                if !msg.is_text() && !msg.is_binary() {
                    continue;
                }
                let raw_bytes = msg.into_data();
                if raw_bytes.len() > MAX_PAYLOAD_BYTES {
                    let err_env = json!({
                        "type": "session.error",
                        "timestamp": 0,
                        "payload": {
                            "code": "PAYLOAD_TOO_LARGE",
                            "message": "Payload exceeds 512KB limit.",
                            "fatal": true
                        }
                    });
                    let _ = write.send(Message::Text(err_env.to_string().into())).await;
                    break;
                }

                let parsed: Value = match serde_json::from_slice(&raw_bytes) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let msg_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let payload = parsed.get("payload").cloned().unwrap_or(json!({}));

                if msg_type == "session.start" {
                    let req_token = payload
                        .get("pairingToken")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let accepted = {
                        let mut token_guard = token_clone.lock().unwrap();
                        if let Some((expected, _exp, used)) = token_guard.as_mut() {
                            if expected == req_token && !*used {
                                *used = true;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if accepted {
                        authenticated = true;
                        let reply = json!({
                            "type": "session.start",
                            "timestamp": 0,
                            "payload": {
                                "role": "server",
                                "sessionId": "sess_rust_1",
                                "sessionResumeToken": "res_rust_token",
                                "approved": true,
                                "activeNotebookId": "nb_default",
                                "activePageId": "page_default_1"
                            }
                        });
                        let _ = write.send(Message::Text(reply.to_string().into())).await;
                        continue;
                    }
                    let err_env = json!({
                        "type": "session.error",
                        "timestamp": 0,
                        "payload": {
                            "code": "INVALID_TOKEN",
                            "message": "Invalid or expired pairing token.",
                            "fatal": true
                        }
                    });
                    let _ = write.send(Message::Text(err_env.to_string().into())).await;
                    break;
                }

                if !authenticated {
                    let err_env = json!({
                        "type": "session.error",
                        "timestamp": 0,
                        "payload": {
                            "code": "UNAUTHORIZED",
                            "message": "Session not authenticated.",
                            "fatal": true
                        }
                    });
                    let _ = write.send(Message::Text(err_env.to_string().into())).await;
                    break;
                }

                if msg_type == "stroke.end" {
                    let op_id = payload
                        .get("operationId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let page_id = payload
                        .get("pageId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("page_default_1");

                    if let Some(stroke_val) = payload.get("stroke") {
                        if let Ok(stroke) = serde_json::from_value::<Stroke>(stroke_val.clone()) {
                            let is_new = {
                                let mut db = store_clone.lock().unwrap();
                                db.commit_stroke_end(op_id, &stroke).unwrap_or(false)
                            };
                            let ack = json!({
                                "type": "operation.ack",
                                "timestamp": 0,
                                "payload": {
                                    "operationId": op_id,
                                    "pageId": page_id,
                                    "status": "committed",
                                    "duplicate": !is_new,
                                    "serverTimestamp": 0
                                }
                            });
                            let _ = write.send(Message::Text(ack.to_string().into())).await;
                        }
                    }
                }
            }
        });
    }
    Ok(())
}
