mod commands;
mod events;
mod files;
mod pty;
mod resources;
mod skills;
mod webview;
mod workspace;

use pty::manager::PtyManager;
use resources::ResourceStore;
use skills::bridge::SkillsState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyManager::default())
        .manage(SkillsState::new())
        .manage(ResourceStore::new())
        .setup(|app| {
            // Start the localhost skills bridge; agents' MCP tools call it.
            if let Err(e) = skills::bridge::start(app.handle()) {
                eprintln!("failed to start skills bridge: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_submit,
            commands::pty_resize,
            commands::pty_kill,
            commands::workspace_save,
            commands::workspace_load,
            commands::workspace_list,
            commands::webview_create,
            commands::webview_update_bounds,
            commands::webview_destroy,
            commands::skills_sync_topology,
            commands::skills_bridge_info,
            commands::resource_register,
            commands::resource_read,
            commands::resources_sync,
            commands::webview_capture,
            commands::file_stat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
