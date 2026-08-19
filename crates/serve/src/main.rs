use std::path::PathBuf;
use std::process::ExitCode;

use markdownkit_serve::{handle, Config};
use tiny_http::{Header, Response, Server, StatusCode};

const HELP: &str = "\
markdownkit-serve — serve local markdown as HTML (same renderer as MarkdownKit)

USAGE:
  markdownkit-serve [--root DIR] [--bind ADDR]

  --root DIR   Only serve files under this directory (default: home)
  --bind ADDR  Listen address (default: 127.0.0.1:8787)
  -h, --help   Show this help

Open a note:
  http://127.0.0.1:8787/?path=/absolute/note.md

Bind to localhost and put Tailscale Serve in front. Do not expose this
to the public internet.
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "-h" || arg == "--help") {
        print!("{HELP}");
        return ExitCode::SUCCESS;
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
    eprintln!("open http://{bind}/?path=/absolute/note.md");

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
