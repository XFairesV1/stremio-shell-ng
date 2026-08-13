// Minimal static file server for the bundled, rebranded WebUI.
//
// Upstream Stremio's default WEB_ENDPOINT points at the real,
// officially-hosted web app (web.stremio.com / app.strem.io), which bundles
// its own unpatched stremio-core wasm talking to the real api.strem.io.
// That defeats the point of this fork: it means logging in from the
// installed app authenticates against a real Stremio account instead of
// this project's own account server. This module serves the locally
// bundled, rebranded build (with the patched API_URL baked into its wasm)
// from a `webui` folder next to the executable, so WEB_ENDPOINT can point
// at 127.0.0.1 instead of the real internet.
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    thread,
};

pub const WEBUI_SERVER_PORT: u16 = 11469;

fn webui_root() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let root = exe_dir.join("webui");
    root.is_dir().then_some(root)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "webmanifest") => "application/json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("txt" | "map") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn resolve_request_path(root: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = urlencoding::decode(request_path).ok()?.into_owned();
    let relative = decoded.split('?').next().unwrap_or("").trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };

    // Reject any component that could escape the webui root (path traversal).
    if relative.split('/').any(|segment| segment == "..") {
        return None;
    }

    let candidate = root.join(relative);
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_candidate = fs::canonicalize(&candidate).ok()?;
    canonical_candidate
        .starts_with(&canonical_root)
        .then_some(canonical_candidate)
}

fn handle_connection(mut stream: TcpStream, root: &Path) {
    let mut reader = BufReader::new(stream.try_clone().expect("Failed to clone TCP stream"));
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // Drain the rest of the request headers; we don't need them.
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) if line == "\r\n" || line == "\n" => break,
            Ok(_) => continue,
        }
    }

    let request_path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .to_string();

    let file_path = resolve_request_path(root, &request_path);
    let body = file_path.as_ref().and_then(|path| fs::read(path).ok());

    match body {
        Some(bytes) => {
            let path = file_path.expect("file_path is Some when body is Some");
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                content_type(&path),
                bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(&bytes);
        }
        None => {
            let body = b"Not found";
            let headers = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(body);
        }
    }
    let _ = stream.flush();
}

/// Starts the bundled WebUI static file server on a background thread if a
/// `webui` folder exists next to the executable. No-op (and logs) if it's
/// missing, e.g. in dev builds run straight from `cargo run`.
pub fn start() {
    let Some(root) = webui_root() else {
        eprintln!("webui_server: no `webui` folder next to the executable, not starting");
        return;
    };

    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", WEBUI_SERVER_PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("webui_server: failed to bind 127.0.0.1:{WEBUI_SERVER_PORT}: {err}");
                return;
            }
        };
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            thread::spawn(move || handle_connection(stream, &root));
        }
    });
}
