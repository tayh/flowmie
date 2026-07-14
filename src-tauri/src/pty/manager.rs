use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::events::{PtyDataEvent, PtyErrorEvent, PtyExitEvent};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

fn command_for_agent(agent_type: &str) -> CommandBuilder {
    match agent_type {
        "claude" => CommandBuilder::new("claude"),
        "codex" => CommandBuilder::new("codex"),
        "opencode" => CommandBuilder::new("opencode"),
        _ => {
            if cfg!(windows) {
                CommandBuilder::new("cmd.exe")
            } else {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
                CommandBuilder::new(shell)
            }
        }
    }
}

impl PtyManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        agent_type: &str,
        cwd: &str,
        role: Option<String>,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = command_for_agent(agent_type);
        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Dropping the slave handle lets the child own the only remaining copy,
        // which is required on some platforms to see EOF once the child exits.
        drop(pair.slave);

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;

        let pty_id = uuid::Uuid::new_v4().to_string();

        let session = PtySession {
            master: pair.master,
            writer,
            child,
        };
        self.sessions.lock().unwrap().insert(pty_id.clone(), session);

        // Stream process output back to the frontend.
        {
            let app = app.clone();
            let pty_id = pty_id.clone();
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                            let _ = app.emit(
                                "pty://data",
                                PtyDataEvent {
                                    pty_id: pty_id.clone(),
                                    data,
                                },
                            );
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Poll for process exit without holding the sessions lock across a blocking wait.
        {
            let app = app.clone();
            let pty_id = pty_id.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(200));
                let manager = app.state::<PtyManager>();
                let mut sessions = manager.sessions.lock().unwrap();
                let Some(session) = sessions.get_mut(&pty_id) else {
                    break;
                };
                match session.child.try_wait() {
                    Ok(Some(status)) => {
                        sessions.remove(&pty_id);
                        drop(sessions);
                        let _ = app.emit(
                            "pty://exit",
                            PtyExitEvent {
                                pty_id: pty_id.clone(),
                                exit_code: status.exit_code() as i32,
                            },
                        );
                        break;
                    }
                    Ok(None) => continue,
                    Err(e) => {
                        sessions.remove(&pty_id);
                        drop(sessions);
                        let _ = app.emit(
                            "pty://error",
                            PtyErrorEvent {
                                pty_id: pty_id.clone(),
                                message: e.to_string(),
                            },
                        );
                        break;
                    }
                }
            });
        }

        if let Some(instruction) = role {
            // Injecting an initial instruction on spawn is Phase 5 scope; not wired up yet.
            let _ = instruction;
        }

        Ok(pty_id)
    }

    pub fn write(&self, pty_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(pty_id)
            .ok_or_else(|| format!("no such pty: {pty_id}"))?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(pty_id)
            .ok_or_else(|| format!("no such pty: {pty_id}"))?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    pub fn kill(&self, pty_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(pty_id) {
            session.child.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
