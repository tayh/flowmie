// Tauri's own `add_child` packs Linux child webviews into the window's
// plain `gtk::Box` (`build_gtk(vbox)`), which has no notion of absolute
// x/y/width/height — a Box only stacks children, it doesn't let you place
// one at an arbitrary point. That's why position/size were silently
// ignored and the webview just expanded to fill the window.
//
// wry's own docs recommend the fix for Linux: build child webviews into a
// `gtk::Fixed` (which *does* support `put(widget, x, y)` + a size request),
// layered on top of the window's existing content via a `gtk::Overlay`.
// Tauri doesn't expose that wiring publicly, so this reaches into
// `Window::gtk_window()`/`Window::default_vbox()` (both public, Linux-only
// APIs) and does it by hand, once, the first time a webview node is
// created; every webview after that is built into the same shared Fixed.
//
// Everything here must run on the GTK main thread (GTK objects aren't
// thread-safe), so every operation is dispatched via
// `Window::run_on_main_thread` and the live `wry::WebView` handles are kept
// in a `thread_local!` — never moved across threads, only ever touched from
// closures that are guaranteed to run on that same main thread.
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::channel;

use gtk::prelude::{BoxExt, ContainerExt, FixedExt, OverlayExt, WidgetExt};
use tauri::{AppHandle, Emitter, Manager};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

use crate::events::WebviewLoadedEvent;

thread_local! {
    static OVERLAY_FIXED: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
    static WEBVIEWS: RefCell<HashMap<String, WebView>> = RefCell::new(HashMap::new());
}

fn ensure_overlay_fixed(vbox: &gtk::Box) -> gtk::Fixed {
    OVERLAY_FIXED.with(|cell| {
        if let Some(fixed) = cell.borrow().as_ref() {
            return fixed.clone();
        }

        let overlay = gtk::Overlay::new();
        if let Some(content) = vbox.children().first() {
            vbox.remove(content);
            overlay.add(content);
        }

        let fixed = gtk::Fixed::new();
        overlay.add_overlay(&fixed);
        // Without this, the overlay child captures pointer events across its
        // *entire* allocated area (the whole window) by default, even where
        // no webview widget is actually placed — silently swallowing every
        // click meant for the React UI underneath.
        overlay.set_overlay_pass_through(&fixed, true);
        overlay.show_all();
        vbox.pack_start(&overlay, true, true, 0);

        *cell.borrow_mut() = Some(fixed.clone());
        fixed
    })
}

pub fn create(
    app: &AppHandle,
    label: &str,
    url: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = main_window.as_ref().window();

    let (tx, rx) = channel();
    let label = label.to_string();
    let url = url.to_string();
    let app_handle = app.clone();
    let window_ = window.clone();

    window
        .run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                let vbox = window_.default_vbox().map_err(|e| e.to_string())?;
                let fixed = ensure_overlay_fixed(&vbox);

                let emit_label = label.clone();
                let webview = WebViewBuilder::new()
                    .with_url(&url)
                    .with_bounds(Rect {
                        position: LogicalPosition::new(x, y).into(),
                        size: LogicalSize::new(width, height).into(),
                    })
                    .with_on_page_load_handler(move |event, _url| {
                        if matches!(event, PageLoadEvent::Finished) {
                            let _ = app_handle.emit(
                                "webview://loaded",
                                WebviewLoadedEvent {
                                    webview_label: emit_label.clone(),
                                },
                            );
                        }
                    })
                    .build_gtk(&fixed)
                    .map_err(|e| e.to_string())?;

                WEBVIEWS.with(|cell| cell.borrow_mut().insert(label.clone(), webview));
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

pub fn update_bounds(
    app: &AppHandle,
    label: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = main_window.as_ref().window();

    let (tx, rx) = channel();
    let label = label.to_string();

    window
        .run_on_main_thread(move || {
            // wry's own `set_bounds` calls `widget.size_allocate()` directly,
            // which GtkFixed silently overrides on its next internal layout
            // pass (it re-applies whatever x/y it has tracked since the
            // child was added via `put`). The child property `Fixed::move_`
            // updates is what actually sticks across relayouts.
            let result = (|| -> Result<(), String> {
                let fixed = OVERLAY_FIXED
                    .with(|cell| cell.borrow().clone())
                    .ok_or_else(|| "webview overlay not initialized".to_string())?;
                WEBVIEWS.with(|cell| -> Result<(), String> {
                    let webviews = cell.borrow();
                    let webview = webviews
                        .get(&label)
                        .ok_or_else(|| format!("no such webview: {label}"))?;
                    let widget = webview.webview();
                    widget.set_size_request(width.round() as i32, height.round() as i32);
                    fixed.move_(&widget, x.round() as i32, y.round() as i32);
                    Ok(())
                })
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())?
}

pub fn destroy(app: &AppHandle, label: &str) -> Result<(), String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let window = main_window.as_ref().window();

    let (tx, rx) = channel();
    let label = label.to_string();

    window
        .run_on_main_thread(move || {
            // Dropping the WebView runs wry's Drop impl, which destroys the
            // underlying GTK widget and detaches it from the Fixed.
            WEBVIEWS.with(|cell| {
                cell.borrow_mut().remove(&label);
            });
            let _ = tx.send(());
        })
        .map_err(|e| e.to_string())?;

    rx.recv().map_err(|e| e.to_string())
}
