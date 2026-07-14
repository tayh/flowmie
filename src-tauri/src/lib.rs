mod commands;
mod events;
mod pty;
mod workspace;

use pty::manager::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::workspace_save,
            commands::workspace_load,
            commands::workspace_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
