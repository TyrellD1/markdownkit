use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

const RELEASES_LATEST: &str = "https://api.github.com/repos/TyrellD1/markdownkit/releases/latest";
const USER_AGENT: &str = "markdownkit";

#[derive(Debug, Clone)]
pub struct Latest {
    pub version: String,
    pub html_url: String,
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone)]
pub struct Asset {
    pub name: String,
    pub download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

pub fn check(current: &str) -> Result<Option<Latest>, String> {
    let latest = fetch_latest()?;
    if is_newer(current, &latest.version) {
        Ok(Some(latest))
    } else {
        Ok(None)
    }
}

pub fn fetch_latest() -> Result<Latest, String> {
    let body = ureq::get(RELEASES_LATEST)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(4))
        .call()
        .map_err(|err| err.to_string())?
        .into_string()
        .map_err(|err| err.to_string())?;
    let parsed: GithubRelease = serde_json::from_str(&body).map_err(|err| err.to_string())?;
    Ok(Latest {
        version: parsed.tag_name.trim_start_matches('v').to_string(),
        html_url: parsed.html_url,
        assets: parsed
            .assets
            .into_iter()
            .map(|asset| Asset {
                name: asset.name,
                download_url: asset.browser_download_url,
            })
            .collect(),
    })
}

pub fn is_newer(current: &str, latest: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

pub fn serve_asset_name() -> String {
    let arch = match env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => other,
    };
    let os = match env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-gnu",
        other => other,
    };
    format!("markdownkit-serve-{arch}-{os}")
}

pub fn download_serve_update(latest: &Latest, dest: &Path) -> Result<(), String> {
    let name = serve_asset_name();
    let asset = latest
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("No {name} asset on the latest release."))?;
    let tmp = dest.with_extension("new");
    let response = ureq::get(&asset.download_url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|err| err.to_string())?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|err| err.to_string())?;
    if bytes.len() < 1024 {
        return Err("Downloaded update looks too small.".into());
    }
    {
        let mut file = fs::File::create(&tmp).map_err(|err| err.to_string())?;
        file.write_all(&bytes).map_err(|err| err.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755)).map_err(|err| err.to_string())?;
    }
    let backup = dest.with_extension("old");
    let _ = fs::remove_file(&backup);
    fs::rename(dest, &backup).map_err(|err| err.to_string())?;
    if let Err(err) = fs::rename(&tmp, dest) {
        let _ = fs::rename(&backup, dest);
        return Err(err.to_string());
    }
    let _ = fs::remove_file(&backup);
    Ok(())
}

fn parse_version(value: &str) -> (u64, u64, u64) {
    let value = value.trim().trim_start_matches('v');
    let mut parts = value.split('.');
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts
        .next()
        .and_then(|p| p.split('-').next())
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    (major, minor, patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(is_newer("0.2.0", "0.3.0"));
        assert!(is_newer("0.2.0", "0.2.1"));
        assert!(!is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("0.2.0", "v0.10.0"));
    }

    #[test]
    fn serve_asset_name_has_triple() {
        let name = serve_asset_name();
        assert!(name.starts_with("markdownkit-serve-"));
        assert!(name.contains("apple-darwin") || name.contains("linux"));
    }
}
