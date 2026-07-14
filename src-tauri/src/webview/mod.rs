// Tauri's public `add_child` API only supports absolute positioning on
// Windows/macOS today; on Linux it packs the child into the window's plain
// vbox (no x/y support), so that platform needs a manual wry+gtk path.
#[cfg(target_os = "linux")]
#[path = "manager_linux.rs"]
pub mod manager;

#[cfg(not(target_os = "linux"))]
pub mod manager;
