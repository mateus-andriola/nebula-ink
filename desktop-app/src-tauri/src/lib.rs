pub mod db;
pub mod pairing;
pub mod server;

use pairing::{generate_pairing_qr, PairingQrPayload};
use std::time::{SystemTime, UNIX_EPOCH};

#[tauri::command]
fn get_pairing_qr(port: u16) -> PairingQrPayload {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    generate_pairing_qr(port, 5 * 60 * 1000, now_ms)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_pairing_qr])
        .run(tauri::generate_context!())
        .expect("error while running Digital Notebook Tauri application");
}
