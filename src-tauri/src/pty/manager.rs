use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::events::{PtyDataEvent, PtyErrorEvent, PtyExitEvent};
use crate::skills::{self, SkillsSpawn};

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Builds the process command for an agent. Returns whether the `role` was
/// consumed as a launch argument (true) — in which case the caller must NOT
/// also inject it over stdin.
///
/// When `skills` is set, the agent is wired to the F002 skills bridge: its
/// bridge coordinates are exported as env vars (a foundation for every agent
/// type) and, for Claude, an MCP config is written and passed with
/// `--mcp-config` so its skill tools appear as `mcp__flowmie__*`.
fn command_for_agent(
    agent_type: &str,
    role: Option<&str>,
    skills: Option<&SkillsSpawn>,
) -> (CommandBuilder, bool) {
    // MCP config path (Claude), written up front so it exists before launch.
    let mcp_config = skills.and_then(|s| match skills::write_mcp_config(s) {
        Ok(path) => Some(path),
        Err(e) => {
            eprintln!("skills: failed to write MCP config: {e}");
            None
        }
    });

    let (mut cmd, role_as_arg) = match agent_type {
        "claude" => {
            let mut cmd = CommandBuilder::new("claude");
            // Skip the first-run "trust this folder" / permission gate, which
            // otherwise blocks the terminal before it can accept the role.
            cmd.arg("--dangerously-skip-permissions");
            if let Some(path) = &mcp_config {
                // Load only Flowmie's server, deterministically.
                cmd.arg("--mcp-config");
                cmd.arg(path.to_string_lossy().to_string());
                cmd.arg("--strict-mcp-config");
            }
            // Claude Code takes an initial prompt as a positional arg, so the
            // role can be seeded directly at launch — no stdin timing race.
            if let Some(instruction) = role {
                cmd.arg(instruction);
                (cmd, true)
            } else {
                (cmd, false)
            }
        }
        "codex" => {
            let mut cmd = CommandBuilder::new("codex");
            // Register the flowmie MCP server per-invocation via `-c` config
            // overrides (merges with the user's config, doesn't touch it).
            if let Some(s) = skills {
                for arg in codex_skills_args(s) {
                    cmd.arg(arg);
                }
            }
            (cmd, false)
        }
        "opencode" => (CommandBuilder::new("opencode"), false),
        _ => {
            let cmd = if cfg!(windows) {
                CommandBuilder::new("cmd.exe")
            } else {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
                CommandBuilder::new(shell)
            };
            (cmd, false)
        }
    };

    // Export the bridge coordinates for every skills-enabled agent. Claude
    // reads them from its MCP config's `env` above; codex/opencode wiring
    // (a follow-up) can pick them up from the process environment.
    if let Some(s) = skills {
        cmd.env("FLOWMIE_NODE_ID", &s.node_id);
        cmd.env("FLOWMIE_BRIDGE_URL", &s.bridge_url);
        cmd.env("FLOWMIE_BRIDGE_TOKEN", &s.token);
    }

    (cmd, role_as_arg)
}

/// Whether an agent runs as a raw-mode TUI that should receive submitted
/// messages as bracketed paste rather than raw keystrokes.
fn is_tui_agent(agent_type: &str) -> bool {
    matches!(agent_type, "claude" | "codex" | "opencode")
}

/// Quote a string as a TOML basic string (for Codex `-c` values).
fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `codex -c key=value` overrides that register the flowmie MCP server for
/// a Codex session. Per-invocation and merged with the user's config, so it
/// never mutates `~/.codex/config.toml`. Identity is baked into the server's
/// `env` (same approach as Claude's `--mcp-config`).
fn codex_skills_args(spawn: &SkillsSpawn) -> Vec<String> {
    let shim = skills::shim_path();
    let set = |path: &str, value: String| vec!["-c".to_string(), format!("{path}={value}")];
    let mut args = Vec::new();
    args.extend(set("mcp_servers.flowmie.command", toml_string("node")));
    args.extend(set(
        "mcp_servers.flowmie.args",
        format!("[{}]", toml_string(&shim)),
    ));
    args.extend(set(
        "mcp_servers.flowmie.env.FLOWMIE_NODE_ID",
        toml_string(&spawn.node_id),
    ));
    args.extend(set(
        "mcp_servers.flowmie.env.FLOWMIE_BRIDGE_URL",
        toml_string(&spawn.bridge_url),
    ));
    args.extend(set(
        "mcp_servers.flowmie.env.FLOWMIE_BRIDGE_TOKEN",
        toml_string(&spawn.token),
    ));
    args
}

/// Build the byte string that submits `text` to an agent's input. Pure so the
/// framing is unit-tested without a live PTY.
fn submission_payload(text: &str, agent_type: &str) -> String {
    if is_tui_agent(agent_type) {
        // ESC[200~ … ESC[201~ = bracketed paste; trailing CR submits.
        format!("\x1b[200~{text}\x1b[201~\r")
    } else {
        format!("{text}\r")
    }
}

impl PtyManager {
    pub fn spawn(
        &self,
        app: AppHandle,
        agent_type: &str,
        cwd: &str,
        role: Option<String>,
        skills: Option<SkillsSpawn>,
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

        let (mut cmd, role_passed_as_arg) =
            command_for_agent(agent_type, role.as_deref(), skills.as_ref());
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

        if let (Some(instruction), false) = (role, role_passed_as_arg) {
            // For agents that don't take an initial prompt as a launch arg,
            // inject the role as the first message over stdin. A short delay
            // gives the CLI time to finish booting before we submit it.
            let app = app.clone();
            let pty_id = pty_id.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(800));
                let manager = app.state::<PtyManager>();
                let _ = manager.write(&pty_id, &format!("{instruction}\r"));
            });
        }

        Ok(pty_id)
    }

    /// Submit a message to an interactive agent's input. Agent TUIs
    /// (Claude/Codex/OpenCode run full-screen in raw mode) receive the text
    /// via **bracketed paste** so the whole block is inserted atomically —
    /// writing a burst of raw bytes instead makes the app do per-keystroke
    /// work and silently drop characters (observed: spaces/letters vanishing
    /// from a relayed message). A trailing carriage return then submits it.
    /// A plain shell just gets the text and a carriage return.
    pub fn submit_message(&self, pty_id: &str, text: &str, agent_type: &str) -> Result<(), String> {
        self.write(pty_id, &submission_payload(text, agent_type))
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

#[cfg(test)]
mod tests {
    use super::{codex_skills_args, submission_payload, toml_string};
    use crate::skills::SkillsSpawn;

    #[test]
    fn toml_string_escapes_quotes_and_backslashes() {
        assert_eq!(toml_string("node"), "\"node\"");
        assert_eq!(toml_string(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn codex_args_register_flowmie_with_baked_identity() {
        let spawn = SkillsSpawn {
            node_id: "node-1".into(),
            bridge_url: "http://127.0.0.1:9999".into(),
            token: "tok-abc".into(),
        };
        let args = codex_skills_args(&spawn);
        // Every override is a `-c key=value` pair.
        assert!(args.chunks(2).all(|c| c[0] == "-c"));
        let joined = args.join(" ");
        assert!(joined.contains("mcp_servers.flowmie.command=\"node\""));
        assert!(joined.contains("mcp_servers.flowmie.env.FLOWMIE_NODE_ID=\"node-1\""));
        assert!(joined.contains("mcp_servers.flowmie.env.FLOWMIE_BRIDGE_URL=\"http://127.0.0.1:9999\""));
        assert!(joined.contains("mcp_servers.flowmie.env.FLOWMIE_BRIDGE_TOKEN=\"tok-abc\""));
        assert!(joined.contains("mcp_servers.flowmie.args=[\""));
    }

    #[test]
    fn tui_agents_get_bracketed_paste_and_submit() {
        assert_eq!(
            submission_payload("hello world", "codex"),
            "\x1b[200~hello world\x1b[201~\r"
        );
        assert_eq!(
            submission_payload("hi", "claude"),
            "\x1b[200~hi\x1b[201~\r"
        );
    }

    #[test]
    fn shell_gets_plain_text_and_submit() {
        assert_eq!(submission_payload("ls -la", "shell"), "ls -la\r");
        assert_eq!(submission_payload("x", "somethingelse"), "x\r");
    }
}
