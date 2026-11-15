//! Bridge desktop shell: keeps the Node daemon running, lives in the tray,
//! starts at login, and shows notifications for the web UI.

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

struct Daemon(Mutex<Option<Child>>);

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn bridge_home() -> PathBuf {
    std::env::var_os("BRIDGE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".bridge"))
}

fn local_port() -> u16 {
    if let Ok(p) = std::env::var("BRIDGE_LOCAL_PORT") {
        if let Ok(p) = p.parse() {
            return p;
        }
    }
    fs::read_to_string(bridge_home().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("localPort").and_then(|p| p.as_u64()))
        .map(|p| p as u16)
        .unwrap_or(47601)
}

fn daemon_up(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// GUI apps on macOS get a minimal PATH; ask the login shell for the real one so the
/// daemon can find node, git and claude (Homebrew, nvm, ~/.local/bin, ...).
fn user_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(out) = Command::new(shell).args(["-lic", "printf %s \"$PATH\""]).output() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return format!("{p}:{current}");
            }
        }
    }
    current
}

fn find_node(path_var: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BRIDGE_NODE") {
        return Some(PathBuf::from(p));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = path_var.split(sep).map(PathBuf::from).collect();
    dirs.extend(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "C:\\Program Files\\nodejs",
        ]
        .iter()
        .map(PathBuf::from),
    );
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

/// Tauri can hand back Windows verbatim paths (`\\?\F:\...`), which Node rejects as a
/// main-module path. Strip the prefix for ordinary drive paths.
fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        if !rest.starts_with("UNC\\") {
            return PathBuf::from(rest);
        }
    }
    p
}

fn find_script(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BRIDGE_SCRIPT") {
        return Some(PathBuf::from(p));
    }
    let mut candidates = vec![];
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("bridge").join("bridge.cjs"));
    }
    // Development: the freshly built bundle in the repo.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("packages")
            .join("bridge")
            .join("dist")
            .join("bridge.cjs"),
    );
    candidates.into_iter().map(plain_path).find(|p| p.is_file())
}

fn start_daemon(app: &AppHandle) -> Result<(), String> {
    let port = local_port();
    if daemon_up(port) {
        return Ok(()); // already running (CLI-started or another instance)
    }
    let path_var = user_path();
    let node = find_node(&path_var)
        .ok_or("Node.js was not found. Install Node 20+ from https://nodejs.org and restart Bridge.")?;
    let script = find_script(app).ok_or("Bridge daemon script (bridge.cjs) is missing from the app bundle.")?;
    let home = bridge_home();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("bridge.log"))
        .map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .arg("daemon")
        .env("PATH", path_var)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let child = cmd.spawn().map_err(|e| format!("Failed to start the Bridge daemon: {e}"))?;
    *app.state::<Daemon>().0.lock().unwrap() = Some(child);
    Ok(())
}

fn stop_daemon(app: &AppHandle) {
    if let Some(mut child) = app.state::<Daemon>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Serialize)]
struct Connection {
    port: u16,
    token: String,
}

/// Wait for the daemon and hand the UI its address and the localhost API token.
#[tauri::command]
async fn connection(app: AppHandle) -> Result<Connection, String> {
    let port = local_port();
    for i in 0..60 {
        if daemon_up(port) {
            if let Ok(token) = fs::read_to_string(bridge_home().join("local-token")) {
                return Ok(Connection { port, token: token.trim().to_string() });
            }
        }
        if i == 20 {
            // Daemon may have crashed; try once more.
            start_daemon(&app)?;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "The Bridge daemon is not responding. See {}",
        bridge_home().join("bridge.log").display()
    ))
}

#[tauri::command]
fn restart_daemon(app: AppHandle) -> Result<(), String> {
    stop_daemon(&app);
    std::thread::sleep(Duration::from_millis(500));
    start_daemon(&app)
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    Ok(al.is_enabled().unwrap_or(false))
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose a project folder to share")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

#[tauri::command]
fn log_path() -> String {
    bridge_home().join("bridge.log").display().to_string()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Daemon(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            connection,
            restart_daemon,
            notify,
            autostart_get,
            autostart_set,
            pick_folder,
            log_path
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = start_daemon(&handle) {
                eprintln!("{e}");
                let _ = handle.notification().builder().title("Bridge").body(&e).show();
            }

            let open = MenuItem::with_id(app, "open", "Open Bridge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Bridge", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("bridge")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Bridge")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        stop_daemon(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Launched at login: stay in the tray.
            if !std::env::args().any(|a| a == "--hidden") {
                show_main(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Bridge running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Bridge")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_daemon(app);
            }
        });
}
