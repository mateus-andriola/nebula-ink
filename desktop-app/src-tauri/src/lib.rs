pub mod db;
pub mod pairing;
pub mod server;

use pairing::{generate_pairing_qr, PairingQrPayload};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(desktop)]
fn reflection_tray_icon() -> tauri::image::Image<'static> {
    const SIDE: usize = 32;
    let mut rgba = vec![0u8; SIDE * SIDE * 4];
    let paint = |pixels: &mut [u8], x: usize, y: usize, color: [u8; 4]| {
        let offset = (y * SIDE + x) * 4;
        pixels[offset..offset + 4].copy_from_slice(&color);
    };

    for y in 0..SIDE {
        for x in 0..SIDE {
            let dx = if x < 8 { 8.0 - x as f32 } else if x > 23 { x as f32 - 23.0 } else { 0.0 };
            let dy = if y < 8 { 8.0 - y as f32 } else if y > 23 { y as f32 - 23.0 } else { 0.0 };
            if dx * dx + dy * dy <= 64.0 {
                paint(&mut rgba, x, y, [17, 24, 39, 255]);
            }
        }
    }

    let draw_line = |pixels: &mut [u8], start: (f32, f32), end: (f32, f32), radius: f32, color: [u8; 4]| {
        let dx = end.0 - start.0;
        let dy = end.1 - start.1;
        let length_sq = dx * dx + dy * dy;
        for y in 0..SIDE {
            for x in 0..SIDE {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                let t = if length_sq == 0.0 { 0.0 } else { (((px - start.0) * dx + (py - start.1) * dy) / length_sq).clamp(0.0, 1.0) };
                let distance = ((px - (start.0 + t * dx)).powi(2) + (py - (start.1 + t * dy)).powi(2)).sqrt();
                if distance <= radius {
                    paint(pixels, x, y, color);
                }
            }
        }
    };
    let white = [226, 232, 240, 255];
    for (a, b) in [((7.0, 13.0), (7.0, 7.0)), ((7.0, 7.0), (13.0, 7.0)), ((25.0, 13.0), (25.0, 7.0)), ((25.0, 7.0), (19.0, 7.0)), ((7.0, 19.0), (7.0, 25.0)), ((7.0, 25.0), (13.0, 25.0)), ((25.0, 19.0), (25.0, 25.0)), ((25.0, 25.0), (19.0, 25.0))] {
        draw_line(&mut rgba, a, b, 1.5, white);
    }
    draw_line(&mut rgba, (11.0, 22.0), (21.0, 10.0), 2.2, [167, 139, 250, 255]);
    draw_line(&mut rgba, (20.0, 9.0), (23.0, 11.0), 1.5, [224, 242, 254, 255]);
    tauri::image::Image::new_owned(rgba, SIDE as u32, SIDE as u32)
}

#[derive(Default)]
struct ReflectionInputState(Mutex<bool>);

#[tauri::command]
fn set_reflection_click_through(
    app: AppHandle,
    state: State<'_, ReflectionInputState>,
    enabled: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window("phone-reflection")
        .ok_or("Janela de reflexo não encontrada")?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|error| error.to_string())?;
    if enabled {
        window.show().map_err(|error| error.to_string())?;
    }
    if let Ok(mut current) = state.0.lock() {
        *current = enabled;
    }
    Ok(())
}

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
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });

    builder
        .manage(ReflectionInputState(Mutex::new(true)))
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
                use tauri::tray::TrayIconBuilder;
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

                let disable_reflection = MenuItem::with_id(app, "disable-reflection", "Desativar reflexo", true, None::<&str>)?;
                let enable_reflection = MenuItem::with_id(app, "enable-reflection", "Ativar reflexo", true, None::<&str>)?;
                let open_settings = MenuItem::with_id(app, "open-settings", "Abrir configurações", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let quit = MenuItem::with_id(app, "quit", "Sair do NebulaInk", true, None::<&str>)?;
                let tray_menu = Menu::with_items(app, &[&disable_reflection, &enable_reflection, &separator, &open_settings, &quit])?;
                TrayIconBuilder::with_id("reflection-tray")
                    .icon(reflection_tray_icon())
                    .tooltip("NebulaInk — Reflexo do celular")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "disable-reflection" => { let _ = app.emit("reflection:set-enabled", false); }
                        "enable-reflection" => { let _ = app.emit("reflection:set-enabled", true); }
                        "open-settings" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;

                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            let key = format!("{shortcut:?}");
                            let Some(window) = app.get_webview_window("phone-reflection") else {
                                return;
                            };
                            if key.contains("F9") {
                                if let Ok(visible) = window.is_visible() {
                                    if visible {
                                        let _ = window.hide();
                                        let _ = app.emit("reflection:user-hidden", ());
                                    } else {
                                        let _ = window.show();
                                        let _ = app.emit("reflection:user-shown", ());
                                    }
                                }
                            } else if key.contains("F10") {
                                let state = app.state::<ReflectionInputState>();
                                let _ = state.0.lock().map(|mut enabled| *enabled = true);
                                let _ = app.emit("reflection:user-closed", ());
                                let _ = window.close();
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register("CmdOrCtrl+Shift+F9")?;
                app.global_shortcut().register("CmdOrCtrl+Shift+F10")?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_pairing_qr, set_reflection_click_through])
        .run(tauri::generate_context!())
        .expect("error while running Digital Notebook Tauri application");
}
