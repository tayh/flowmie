use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, Url, WebviewBuilder,
    WebviewUrl,
};

use crate::events::WebviewLoadedEvent;

/// Creates a child webview positioned inside the main window. Position/size
/// are in logical (CSS) pixels, matching the coordinate space the frontend
/// computes from React Flow's viewport.
pub fn create(
    app: &AppHandle,
    label: &str,
    url: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed_url: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = main_window.as_ref().window();

    let app_handle = app.clone();
    let emit_label = label.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url)).on_page_load(
        move |_webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = app_handle.emit(
                    "webview://loaded",
                    WebviewLoadedEvent {
                        webview_label: emit_label.clone(),
                    },
                );
            }
        },
    );

    window
        .add_child(
            builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width, height)),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn update_bounds(
    app: &AppHandle,
    label: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("no such webview: {label}"))?;
    webview
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())
}

pub fn destroy(app: &AppHandle, label: &str) -> Result<(), String> {
    let Some(webview) = app.get_webview(label) else {
        return Ok(());
    };
    webview.close().map_err(|e| e.to_string())
}

/// Screenshot a webview to PNG bytes (F002 Phase 3 `capture_webview`). Only the
/// Linux path (the bespoke wry+gtk overlay) is implemented; the Tauri
/// `add_child` webviews used elsewhere have no synchronous snapshot API here.
pub fn capture(_app: &AppHandle, _label: &str) -> Result<Vec<u8>, String> {
    Err("webview capture is only implemented on Linux".to_string())
}
