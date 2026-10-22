use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingQrPayload {
    pub v: u8,
    pub host: String,
    pub candidates: Vec<String>,
    pub port: u16,
    pub protocol: String,
    pub pairing_token: String,
    pub expires_at: i64,
}

pub fn discover_lan_ipv4_candidates() -> (String, Vec<String>) {
    let mut preferred = Vec::new();
    let mut fallback = Vec::new();

    if let Ok(ifaces) = local_ip_address::list_afinet_netifas() {
        for (name, ip) in ifaces {
            if let std::net::IpAddr::V4(v4) = ip {
                if v4.is_loopback() {
                    continue;
                }
                let s = v4.to_string();
                let lower = name.to_lowercase();
                let is_virtual = lower.contains("hamachi")
                    || lower.contains("vethernet")
                    || lower.contains("wsl")
                    || lower.contains("docker");
                if !is_virtual && (s.starts_with("192.168.") || s.starts_with("10.")) {
                    preferred.push(s);
                } else {
                    fallback.push(s);
                }
            }
        }
    }

    preferred.extend(fallback);
    if preferred.is_empty() {
        preferred.push("127.0.0.1".to_string());
    }
    let first = preferred[0].clone();
    (first, preferred)
}

pub fn generate_pairing_qr(port: u16, ttl_ms: i64, now_ms: i64) -> PairingQrPayload {
    let (host, candidates) = discover_lan_ipv4_candidates();
    let token = format!("tkn_{}", Uuid::new_v4().simple());
    PairingQrPayload {
        v: 1,
        host,
        candidates,
        port,
        protocol: "ws".to_string(),
        pairing_token: token,
        expires_at: now_ms + ttl_ms,
    }
}
