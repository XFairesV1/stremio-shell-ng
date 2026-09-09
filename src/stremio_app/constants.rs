use url::Url;

pub const APP_NAME: &str = "StremDoBem";
pub const IPC_PATH: &str = "//./pipe/com.stremio5.";
pub const DEV_ENDPOINT: &str = "http://127.0.0.1:11470";
// Points at the bundled, rebranded WebUI served locally by webui_server
// (patched stremio-core wasm, talking to this fork's own account server) —
// not the real, officially-hosted web.stremio.com, which would authenticate
// against a genuine Stremio account instead.
pub const WEB_ENDPOINT: &str = "http://127.0.0.1:11469/";
pub const STA_ENDPOINT: &str = "https://staging.strem.io/";
pub const WINDOW_MIN_WIDTH: i32 = 1000;
pub const WINDOW_MIN_HEIGHT: i32 = 600;
pub const UPDATE_INTERVAL: u64 = 12 * 60 * 60;
// This fork's own update feed. It must never point at strem.io/stremio.com:
// those serve the genuine Stremio setup, which carries the same Inno Setup
// AppId as ours and would silently install real Stremio over StremDoBem. Only
// releases we publish ourselves land on the `updates` branch below.
pub const UPDATE_FEED: &str =
    "https://raw.githubusercontent.com/XFairesV1/stremio-shell-ng/updates/";

// URL of the `check` document for this build: `{ version, versionDesc }`,
// where `versionDesc` points at the descriptor holding the installer URL and
// its checksum. Static hosting ignores query strings, so the channel and the
// architecture are part of the path instead.
pub fn update_endpoint(arch: &str, release_candidate: bool) -> String {
    let channel = if release_candidate { "rc" } else { "latest" };
    format!("{UPDATE_FEED}{channel}_{arch}.json")
}

pub const STREMIO_SERVER_DEV_MODE: &str = "STREMIO_SERVER_DEV_MODE";
pub const SRV_BUFFER_SIZE: usize = 1024;
pub const SERVER_IPC_KEY: &str = "SERVER_IPC_KEY";
pub const SRV_LOG_SIZE: usize = 20;

pub const WARNING_URL: &str = "https://www.stremio.com/warning#";
pub const WHITELISTED_HOSTS: &[&str] = &[
    "stremio.com",
    "www.stremio.com",
    "web.stremio.com",
    "app.stremio.com",
    "strem.io",
    "api.strem.io",
    "stremio.zendesk.com",
    "google.com",
    "www.google.com",
    "youtube.com",
    "www.youtube.com",
    "twitch.tv",
    "twitter.com",
    "x.com",
    "netflix.com",
    "adex.network",
    "amazon.com",
    "forms.gle",
    "www.hbomax.com",
    "play.hbomax.com",
    "www.disneyplus.com",
    "imdb.com",
];

pub fn web_endpoint_with_streaming_server(server_url: &str) -> String {
    let server_url = server_url.trim_end_matches('/');
    let streaming_server_url =
        url::form_urlencoded::byte_serialize(server_url.as_bytes()).collect::<String>();
    let web_endpoint = WEB_ENDPOINT.trim_end_matches('/');

    format!("{web_endpoint}/#/?streamingServerUrl={streaming_server_url}")
}

pub fn safe_url(uri: &str) -> Option<String> {
    if let Ok(url) = Url::parse(uri) {
        println!("URL is {url}");
        let is_whitelisted = url.host().is_some_and(|host| {
            WHITELISTED_HOSTS
                .iter()
                .any(|whitelisted_host| host.to_string() == *whitelisted_host)
        });

        let final_url = if is_whitelisted {
            url.to_string()
        } else {
            format!("{}{}", WARNING_URL, urlencoding::encode(url.as_ref()))
        };
        Some(final_url)
    } else {
        None
    }
}
