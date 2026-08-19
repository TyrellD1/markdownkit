use std::path::PathBuf;
use std::process::ExitCode;

use markdownkit_serve::{handle, Config};
use tiny_http::{Header, Response, Server, StatusCode};

const HELP: &str = "\
markdownkit-serve — serve local markdown as HTML (same renderer as MarkdownKit)

USAGE:
  markdownkit-serve [--root DIR] [--bind ADDR]
  markdownkit-serve --check
  markdownkit-serve --update

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

    let (root, bind) = match parse_args(&args) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("{error}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };

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

fn parse_args(args: &[String]) -> Result<(PathBuf, String), String> {
    let mut root = None;
    let mut bind = "127.0.0.1:8787".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
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
    Ok((root, bind))
}

fn home_dir() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home));
    }
    Err("Could not determine home directory; pass --root DIR.".into())
}
