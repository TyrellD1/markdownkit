use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use markdownkit_serve::{handle, Config};
use tiny_http::{Header, Response, Server, StatusCode};

const HELP: &str = "\
markdownkit-serve — serve local markdown as HTML (same renderer as MarkdownKit)

USAGE:
  markdownkit-serve [--root DIR] [--bind ADDR]
  markdownkit-serve start [--root DIR] [--bind ADDR]
  markdownkit-serve stop
  markdownkit-serve --check
  markdownkit-serve --update

  start        Run in the background (closing the terminal is fine)
  stop         Stop the background server
  --root DIR   Only serve files under this directory (default: home)
  --bind ADDR  Listen address (default: 127.0.0.1:8787)
  --check      Print whether a newer GitHub release exists
  --update     Replace this binary with the latest GitHub release
  -h, --help   Show this help

Open a note from the home page:
  http://127.0.0.1:8787/

Or via query string:
  http://127.0.0.1:8787/?path=/absolute/note.md

Settings (this browser only):
  http://127.0.0.1:8787/settings

Bind to localhost and put Tailscale Serve in front. Do not expose this
to the public internet.
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Foreground,
    Start,
    Stop,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|arg| arg == "--check") {
        return run_check();
    }
    if args.iter().any(|arg| arg == "--update") {
        return run_update();
    }

    let (mode, root, bind) = match parse_args(&args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };

    match mode {
        Mode::Stop => run_stop(),
        Mode::Start => run_start(root, bind),
        Mode::Foreground => run_foreground(root, bind),
    }
}

fn run_foreground(root: PathBuf, bind: String) -> ExitCode {
    let root = match root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("Could not resolve --root {}: {error}", root.display());
            return ExitCode::from(1);
        }
    };

    let server = match Server::http(bind.as_str()) {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Could not listen on http://{bind}: {error}");
            return ExitCode::from(1);
        }
    };

    let config = Config { root: root.clone() };
    eprintln!("markdownkit-serve on http://{bind}");
    eprintln!("root {}", root.display());
    eprintln!("open http://{bind}/");
    spawn_update_notice();

    for request in server.incoming_requests() {
        let method = request.method().to_string();
        let url = request.url().to_string();
        let reply = handle(&config, &method, &url);
        let header = match Header::from_bytes("Content-Type", reply.content_type) {
            Ok(header) => header,
            Err(_) => {
                let _ = request.respond(
                    Response::from_string("Internal error\n").with_status_code(StatusCode(500)),
                );
                continue;
            }
        };
        let response = Response::from_data(reply.body)
            .with_status_code(StatusCode(reply.status))
            .with_header(header);
        let _ = request.respond(response);
    }

    ExitCode::SUCCESS
}

fn run_start(root: PathBuf, bind: String) -> ExitCode {
    if let Some(running) = running_server() {
        println!(
            "markdownkit-serve already running on http://{} (pid {})",
            running.bind, running.pid
        );
        return ExitCode::SUCCESS;
    }

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("Could not locate this binary: {error}");
            return ExitCode::from(1);
        }
    };
    let paths = match state_paths() {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(1);
        }
    };
    if let Err(error) = fs::create_dir_all(&paths.dir) {
        eprintln!("Could not create {}: {error}", paths.dir.display());
        return ExitCode::from(1);
    }

    let log = match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&paths.log)
    {
        Ok(log) => log,
        Err(error) => {
            eprintln!("Could not write {}: {error}", paths.log.display());
            return ExitCode::from(1);
        }
    };
    let log_err = match log.try_clone() {
        Ok(log) => log,
        Err(error) => {
            eprintln!("Could not write {}: {error}", paths.log.display());
            return ExitCode::from(1);
        }
    };

    let mut cmd = Command::new(&exe);
    cmd.args(["--root", &root.to_string_lossy(), "--bind", &bind])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    if let Err(error) = detach_child(&mut cmd) {
        eprintln!("Could not start in the background: {error}");
        return ExitCode::from(1);
    }

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("Could not start markdownkit-serve: {error}");
            return ExitCode::from(1);
        }
    };
    let pid = child.id();
    std::mem::forget(child);
    if let Err(error) = write_state(pid, &bind) {
        eprintln!("{error}");
        return ExitCode::from(1);
    }

    std::thread::sleep(Duration::from_millis(250));
    if !pid_alive(pid) {
        let _ = fs::remove_file(pid_path());
        eprintln!("markdownkit-serve failed to start.");
        if let Ok(text) = fs::read_to_string(&paths.log) {
            eprint!("{text}");
        }
        return ExitCode::from(1);
    }

    println!("markdownkit-serve started on http://{bind} (pid {pid})");
    ExitCode::SUCCESS
}

fn run_stop() -> ExitCode {
    let Some(running) = read_state() else {
        println!("markdownkit-serve is not running.");
        return ExitCode::SUCCESS;
    };
    if !pid_alive(running.pid) {
        let _ = fs::remove_file(pid_path());
        println!("markdownkit-serve is not running.");
        return ExitCode::SUCCESS;
    }
    if let Err(error) = signal_term(running.pid) {
        eprintln!("Could not stop markdownkit-serve (pid {}): {error}", running.pid);
        return ExitCode::from(1);
    }
    for _ in 0..20 {
        if !pid_alive(running.pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = fs::remove_file(pid_path());
    println!("markdownkit-serve stopped.");
    ExitCode::SUCCESS
}

struct Running {
    pid: u32,
    bind: String,
}

fn running_server() -> Option<Running> {
    let running = read_state()?;
    if pid_alive(running.pid) {
        Some(running)
    } else {
        let _ = fs::remove_file(pid_path());
        None
    }
}

fn read_state() -> Option<Running> {
    let text = fs::read_to_string(pid_path()).ok()?;
    let mut lines = text.lines();
    let pid = lines.next()?.trim().parse().ok()?;
    let bind = lines
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| "127.0.0.1:8787".to_string());
    Some(Running { pid, bind })
}

fn write_state(pid: u32, bind: &str) -> Result<(), String> {
    let path = pid_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    }
    let mut file = fs::File::create(&path)
        .map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    write!(file, "{pid}\n{bind}\n")
        .map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    Ok(())
}

struct StatePaths {
    dir: PathBuf,
    log: PathBuf,
}

fn state_paths() -> Result<StatePaths, String> {
    let dir = home_dir()?.join(".markdownkit");
    Ok(StatePaths {
        log: dir.join("serve.log"),
        dir,
    })
}

fn pid_path() -> PathBuf {
    match home_dir() {
        Ok(home) => home.join(".markdownkit").join("serve.pid"),
        Err(_) => PathBuf::from("markdownkit-serve.pid"),
    }
}

fn spawn_update_notice() {
    std::thread::spawn(|| {
        if let Ok(Some(latest)) = markdownkit_update::check(env!("CARGO_PKG_VERSION")) {
            eprintln!(
                "markdownkit-serve {} is available (this is {}).\n  {}\n  Update: markdownkit-serve --update",
                latest.version,
                env!("CARGO_PKG_VERSION"),
                latest.html_url
            );
        }
    });
}

fn run_check() -> ExitCode {
    match markdownkit_update::check(env!("CARGO_PKG_VERSION")) {
        Ok(None) => {
            println!(
                "markdownkit-serve {} is the latest.",
                env!("CARGO_PKG_VERSION")
            );
            ExitCode::SUCCESS
        }
        Ok(Some(latest)) => {
            println!(
                "markdownkit-serve {} is available (this is {}).\n  {}\n  Update: markdownkit-serve --update",
                latest.version,
                env!("CARGO_PKG_VERSION"),
                latest.html_url
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Could not check for updates: {error}");
            ExitCode::from(1)
        }
    }
}

fn run_update() -> ExitCode {
    let latest = match markdownkit_update::fetch_latest() {
        Ok(latest) => latest,
        Err(error) => {
            eprintln!("Could not check for updates: {error}");
            return ExitCode::from(1);
        }
    };
    if !markdownkit_update::is_newer(env!("CARGO_PKG_VERSION"), &latest.version) {
        println!(
            "markdownkit-serve {} is already the latest.",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    let dest = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("Could not locate this binary: {error}");
            return ExitCode::from(1);
        }
    };
    match markdownkit_update::download_serve_update(&latest, &dest) {
        Ok(()) => {
            println!("Updated to markdownkit-serve {}.", latest.version);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Could not install the update: {error}");
            ExitCode::from(1)
        }
    }
}

fn parse_args(args: &[String]) -> Result<(Mode, PathBuf, String), String> {
    let mut root = None;
    let mut bind = "127.0.0.1:8787".to_string();
    let mut mode = Mode::Foreground;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "start" => {
                if mode == Mode::Stop {
                    return Err("Use start or stop, not both.".into());
                }
                mode = Mode::Start;
                i += 1;
            }
            "stop" => {
                if mode == Mode::Start {
                    return Err("Use start or stop, not both.".into());
                }
                mode = Mode::Stop;
                i += 1;
            }
            "--root" => {
                let value = args.get(i + 1).ok_or("--root needs a directory")?;
                root = Some(PathBuf::from(value));
                i += 2;
            }
            "--bind" => {
                let value = args.get(i + 1).ok_or("--bind needs host:port")?;
                bind = value.clone();
                i += 2;
            }
            other if other.starts_with('-') => {
                return Err(format!("Unknown flag: {other}"));
            }
            other => {
                return Err(format!("Unexpected argument: {other}"));
            }
        }
    }
    let root = match root {
        Some(root) => root,
        None => home_dir()?,
    };
    Ok((mode, root, bind))
}

fn home_dir() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    Err("Could not determine home directory; pass --root DIR.".into())
}

fn detach_child(cmd: &mut Command) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "start/stop require macOS or Linux",
        ))
    }
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let pid = pid as i32;
        if pid <= 0 {
            return false;
        }
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn signal_term(pid: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        let pid = pid as i32;
        if pid <= 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid pid"));
        }
        let result = unsafe { libc::kill(pid, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "start/stop require macOS or Linux",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_start_stop_and_bind() {
        let (mode, _, bind) = parse_args(&["start".into()]).unwrap();
        assert_eq!(mode, Mode::Start);
        assert_eq!(bind, "127.0.0.1:8787");

        let (mode, _, bind) =
            parse_args(&["start".into(), "--bind".into(), "127.0.0.1:9999".into()]).unwrap();
        assert_eq!(mode, Mode::Start);
        assert_eq!(bind, "127.0.0.1:9999");

        let (mode, _, _) = parse_args(&["stop".into()]).unwrap();
        assert_eq!(mode, Mode::Stop);

        let (mode, _, _) = parse_args(&[]).unwrap();
        assert_eq!(mode, Mode::Foreground);

        assert!(parse_args(&["start".into(), "stop".into()]).is_err());
    }
}
