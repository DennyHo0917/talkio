//! MCP Stdio subprocess manager — desktop only.
//!
//! Spawns MCP servers as child processes and communicates via stdin/stdout
//! using the JSON-RPC protocol (one JSON message per line).
//!
//! Uses async mpsc channels (not polling) for efficient response handling.
//!
//! # Security
//!
//! Stdio servers are arbitrary user-installed programs, so `mcp_stdio_start`
//! gates every *new* command behind a one-time native confirmation dialog.
//! Approved commands are persisted (app config dir) and never asked about
//! again — the flow is: add server in settings → click Allow once → works
//! exactly as before. On Windows the command line is passed to `cmd.exe` as a
//! single `/S /C` string with every token double-quoted, so `& | < > ^`
//! inside arguments are inert (cmd still expands `%VAR%`, which we reject).

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

/// Shared state holding all active stdio sessions.
pub type Sessions = Arc<Mutex<HashMap<String, StdioSession>>>;

pub struct StdioSession {
    child: Child,
    stdin_tx: tokio::sync::mpsc::Sender<String>,
    /// Per-session receiver for stdout lines, behind its own Mutex
    /// so we can hold it during async recv() without blocking other sessions.
    stdout_rx: Arc<Mutex<tokio::sync::mpsc::Receiver<String>>>,
}

fn approval_fingerprint(command: &str, args: &[String], env: &HashMap<String, String>) -> String {
    let mut variables: Vec<_> = env.iter().collect();
    variables.sort_by_key(|(key, _)| *key);
    let serialized = serde_json::to_vec(&(command, args, variables))
        .expect("MCP launch specification is serializable");
    format!("v2:{:x}", Sha256::digest(serialized))
}

fn approved_commands_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("mcp_approved_commands.json"))
}

fn load_approved_commands(app: &AppHandle) -> HashSet<String> {
    let Some(path) = approved_commands_path(app) else {
        return HashSet::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .map(|list| list.into_iter().collect())
        .unwrap_or_default()
}

fn save_approved_commands(app: &AppHandle, commands: &HashSet<String>) {
    let Some(path) = approved_commands_path(app) else {
        return;
    };
    let mut sorted: Vec<&String> = commands.iter().collect();
    sorted.sort();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&sorted) {
        let _ = std::fs::write(path, json);
    }
}

/// Ask the user once whether this command may be spawned as an MCP server.
/// Returns Ok(()) when approved (or already approved), Err with the reason
/// when denied. The dialog is async (callback + oneshot) so the Tauri event
/// loop is never blocked.
async fn ensure_command_approved(
    app: &AppHandle,
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let fingerprint = approval_fingerprint(command, args, env);
    let mut approved = load_approved_commands(app);
    if approved.contains(&fingerprint) {
        return Ok(());
    }

    let mut shown_args = args.iter().take(6).cloned().collect::<Vec<_>>();
    if args.len() > shown_args.len() {
        shown_args.push(format!("… (+{} more)", args.len() - shown_args.len()));
    }
    let summary = if shown_args.is_empty() {
        "(no arguments)".to_string()
    } else {
        shown_args.join(" ")
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(format!(
            "Talkio wants to start this MCP server:\n\n{command}\n{summary}\n\n\
             You only need to allow it once — it will run every time after this."
        ))
        .title("Allow MCP server?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "Allow".into(),
            "Deny".into(),
            "Cancel".into(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });

    match rx.await {
        Ok(MessageDialogResult::Yes) => {
            approved.insert(fingerprint);
            save_approved_commands(app, &approved);
            log::info!("[MCP stdio] Launch specification approved by user");
            Ok(())
        }
        Ok(other) => {
            log::info!(
                "[MCP stdio] Command denied by user ({:?}): {}",
                other,
                command
            );
            Err("MCP stdio launch denied by user".to_string())
        }
        Err(_) => Err("MCP stdio confirmation dialog closed".to_string()),
    }
}

/// Quote one token for `cmd.exe /C`. Returns None for tokens that cannot be
/// passed safely: `"` cannot be nested and `%VAR%` still expands (we only
/// reject actual env-var patterns, so `%20`-style URL encoding stays usable).
#[cfg(target_os = "windows")]
fn quote_cmd_token(token: &str) -> Option<String> {
    if token.contains('"') || has_cmd_env_expansion(token) {
        return None;
    }
    Some(format!("\"{}\"", token))
}

/// Detect `%VAR%`-style environment expansion patterns in a token. cmd.exe
/// expands these even inside double quotes; lone percent signs (`%20`,
/// `100%`) are left literal. Cross-platform so the logic gets tested on CI
/// (used by the Windows command builder + unit tests).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn has_cmd_env_expansion(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let mut j = i + 1;
            if j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'_') {
                while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b'%' {
                    return true;
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    false
}

/// Build the full `cmd.exe /D /S /C` command line. Every token is
/// double-quoted; the doubled outer quotes are consumed by `/S`, leaving the
/// per-token quotes intact so `& | < > ^` inside arguments are never
/// re-parsed as command syntax. This mirrors the battle-tested Node.js
/// shell:true quoting.
#[cfg(target_os = "windows")]
fn build_cmd_line(command: &str, args: &[String]) -> Option<String> {
    let mut tokens = vec![quote_cmd_token(command)?];
    for arg in args {
        tokens.push(quote_cmd_token(arg)?);
    }
    Some(format!("\"{}\"", tokens.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmd_env_expansion_detection() {
        assert!(has_cmd_env_expansion("%PATH%"));
        assert!(has_cmd_env_expansion("a%TOKEN%"));
        assert!(has_cmd_env_expansion("%MY_VAR_1%"));
        assert!(!has_cmd_env_expansion("%20"));
        assert!(!has_cmd_env_expansion("100%"));
        assert!(!has_cmd_env_expansion("100% off"));
        assert!(!has_cmd_env_expansion("plain string"));
        assert!(!has_cmd_env_expansion("http://x/%2F/path"));
        assert!(!has_cmd_env_expansion(""));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cmd_line_quotes_every_token() {
        assert_eq!(quote_cmd_token("npx").as_deref(), Some("\"npx\""));
        assert_eq!(
            quote_cmd_token("http://x?a=1&b=2").as_deref(),
            Some("\"http://x?a=1&b=2\"")
        );
        assert!(quote_cmd_token("a\"b").is_none());
        assert!(quote_cmd_token("%PATH%").is_none());

        let line = build_cmd_line(
            "npx",
            &[
                "-y".to_string(),
                "@modelcontextprotocol/server-filesystem".to_string(),
                "http://x?a=1&b=2".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(
            line,
            "\"\"npx\" \"-y\" \"@modelcontextprotocol/server-filesystem\" \"http://x?a=1&b=2\"\""
        );
        assert!(build_cmd_line("cmd", &["a\"b".to_string()]).is_none());
    }

    #[test]
    fn approved_list_round_trips_json() {
        let mut set = HashSet::new();
        set.insert("npx".to_string());
        set.insert("python3".to_string());
        let json = serde_json::to_string(&set.iter().cloned().collect::<Vec<_>>()).unwrap();
        let loaded: Vec<String> = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.len(), 2);
    }
}

#[cfg(test)]
mod approval_tests {
    use super::*;

    #[test]
    fn command_arguments_and_environment_are_all_part_of_approval() {
        let mut env = HashMap::from([("TOKEN".to_string(), "secret-a".to_string())]);
        let original = approval_fingerprint("npx", &["server-a".into()], &env);
        assert_ne!(
            original,
            approval_fingerprint("npx", &["server-b".into()], &env)
        );
        assert_ne!(
            original,
            approval_fingerprint("node", &["server-a".into()], &env)
        );
        env.insert("TOKEN".into(), "secret-b".into());
        assert_ne!(
            original,
            approval_fingerprint("npx", &["server-a".into()], &env)
        );
        assert!(!original.contains("secret-a"));
        assert_eq!(
            original,
            approval_fingerprint(
                "npx",
                &["server-a".into()],
                &HashMap::from([("TOKEN".into(), "secret-a".into())])
            )
        );
    }
}

/// Start a new MCP stdio subprocess.
/// Returns a session_id that the frontend uses for subsequent calls.
#[tauri::command]
pub async fn mcp_stdio_start(
    app: AppHandle,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    sessions: tauri::State<'_, Sessions>,
) -> Result<String, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("MCP stdio command must not be empty".to_string());
    }
    if command.chars().any(char::is_control) || args.iter().any(|a| a.chars().any(char::is_control))
    {
        return Err("MCP stdio command/args must not contain control characters".to_string());
    }

    ensure_command_approved(&app, &command, &args, &env).await?;
    let session_id = Uuid::new_v4().to_string();

    // On Windows, commands like "npx" are actually "npx.cmd" — Command::new
    // doesn't resolve .cmd/.bat extensions. Wrap with cmd.exe /C (quoted so
    // argument metacharacters stay inert — see build_cmd_line).
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let line = build_cmd_line(&command, &args).ok_or_else(|| {
            format!(
                "MCP server '{}' has arguments that cannot be passed safely on Windows (quotes or %VAR% patterns)",
                command
            )
        })?;
        let mut c = Command::new("cmd.exe");
        c.arg("/D").arg("/S").arg("/C").arg(line);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(&command);
        c.args(&args);
        c
    };
    for (k, v) in &env {
        cmd.env(k, v);
    }

    // macOS .app bundles don't inherit the user's shell PATH, so commands
    // like "npx", "node", "python3" etc. won't be found. Prepend common
    // executable paths to the child process PATH.
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();

        let mut paths: Vec<String> = Vec::new();

        // Try to find the actual nvm node binary dir
        let nvm_dir = format!("{}/.nvm/versions/node", home);
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            let mut versions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                paths.push(format!("{}/{}/bin", nvm_dir, latest));
            }
        }

        // Homebrew (Apple Silicon + Intel)
        paths.push("/opt/homebrew/bin".into());
        paths.push("/opt/homebrew/sbin".into());
        paths.push("/usr/local/bin".into());
        paths.push("/usr/local/sbin".into());
        // Common tool paths
        paths.push(format!("{}/.local/bin", home));
        paths.push(format!("{}/.cargo/bin", home));
        paths.push(format!("{}/.volta/bin", home));
        paths.push(format!("{}/.fnm/aliases/default/bin", home));
        // System
        paths.push("/usr/bin".into());
        paths.push("/bin".into());
        paths.push("/usr/sbin".into());
        paths.push("/sbin".into());
        // Existing PATH
        if !current_path.is_empty() {
            paths.push(current_path);
        }

        let merged = paths.join(":");
        cmd.env("PATH", &merged);
        log::debug!("[MCP stdio] PATH set to: {}", merged);
    }

    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // The child must not outlive its session handle (killed when the session
    // is dropped or explicitly stopped).
    cmd.kill_on_drop(true);
    // Prevent console window from flashing on Windows
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Do NOT log args/env verbatim: they routinely contain tokens and keys.
    log::info!("[MCP stdio] Spawning: {} ({} args)", command, args.len());
    let mut child = cmd.spawn().map_err(|e| {
        log::error!("[MCP stdio] Spawn failed: {}", e);
        format!("Failed to spawn MCP process '{}': {}", command, e)
    })?;
    log::info!(
        "[MCP stdio] Process spawned successfully, pid={:?}",
        child.id()
    );

    let child_stdin = child.stdin.take().ok_or("Failed to get child stdin")?;
    let child_stdout = child.stdout.take().ok_or("Failed to get child stdout")?;
    let child_stderr = child.stderr.take().ok_or("Failed to get child stderr")?;

    // Channel: frontend → child stdin
    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<String>(64);
    // Channel: child stdout → frontend (bounded to prevent unbounded memory growth)
    let (stdout_tx, stdout_rx) = tokio::sync::mpsc::channel::<String>(256);

    // Task: write messages to child stdin
    let mut writer = child_stdin;
    tokio::spawn(async move {
        while let Some(msg) = stdin_rx.recv().await {
            if writer.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    // Task: read lines from child stdout → push to channel
    tokio::spawn(async move {
        let reader = BufReader::new(child_stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() && stdout_tx.send(line).await.is_err() {
                break;
            }
        }
    });

    // Task: log stderr (debug level: server stderr is chatty and may carry
    // secrets; it is surfaced to the user via the tools UI when needed)
    let sid_for_log = session_id.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(child_stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("[MCP stdio {}] stderr: {}", sid_for_log, line);
        }
    });

    let session = StdioSession {
        child,
        stdin_tx,
        stdout_rx: Arc::new(Mutex::new(stdout_rx)),
    };
    sessions.lock().await.insert(session_id.clone(), session);
    log::info!(
        "[MCP stdio] Started session {} (cmd: {})",
        session_id,
        command
    );

    Ok(session_id)
}

/// Send a JSON-RPC message to the MCP subprocess and wait for a response.
/// Uses async channel recv with timeout — no polling.
#[tauri::command]
pub async fn mcp_stdio_send(
    session_id: String,
    message: String,
    sessions: tauri::State<'_, Sessions>,
) -> Result<String, String> {
    // Get stdin sender and stdout receiver Arc (short lock)
    let (stdin_tx, stdout_rx) = {
        let guard = sessions.lock().await;
        let session = guard
            .get(&session_id)
            .ok_or_else(|| format!("Session not found: {}", session_id))?;
        (session.stdin_tx.clone(), session.stdout_rx.clone())
    };
    // Sessions lock released here

    log::debug!("[MCP stdio {}] send() len={}", session_id, message.len());

    // Lock the receiver and drain any buffered lines (startup text, etc.)
    // that arrived before this send — they are not responses to our request.
    let mut rx = stdout_rx.lock().await;
    while rx.try_recv().is_ok() {
        log::debug!("[MCP stdio {}] Drained buffered line", session_id);
    }

    stdin_tx.send(message).await.map_err(|e| {
        log::error!("[MCP stdio {}] stdin send failed: {}", session_id, e);
        format!("Failed to send message: {}", e)
    })?;

    // Wait for response on the channel (no polling, no memory leak)
    match tokio::time::timeout(tokio::time::Duration::from_secs(60), rx.recv()).await {
        Ok(Some(line)) => Ok(line),
        Ok(None) => {
            log::error!("[MCP stdio {}] Process closed", session_id);
            Err("MCP stdio process closed".to_string())
        }
        Err(_) => {
            log::error!("[MCP stdio {}] Response timeout (60s)", session_id);
            Err("MCP stdio response timeout (60s)".to_string())
        }
    }
}

/// Stop an MCP stdio subprocess and clean up.
#[tauri::command]
pub async fn mcp_stdio_stop(
    session_id: String,
    sessions: tauri::State<'_, Sessions>,
) -> Result<(), String> {
    let mut guard = sessions.lock().await;
    if let Some(mut session) = guard.remove(&session_id) {
        let _ = session.child.kill().await;
        log::info!("[MCP stdio] Stopped session {}", session_id);
    }
    Ok(())
}

/// List all active stdio sessions (for debugging).
#[tauri::command]
pub async fn mcp_stdio_list(sessions: tauri::State<'_, Sessions>) -> Result<Vec<String>, String> {
    let guard = sessions.lock().await;
    Ok(guard.keys().cloned().collect())
}
