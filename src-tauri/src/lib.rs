use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

#[derive(Default)]
struct Jobs(Mutex<HashMap<String, CommandChild>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info { title: String, duration: Option<f64>, thumbnail: Option<String>, uploader: Option<String>, heights: Vec<u32>, is_playlist: bool, entries: Vec<Entry> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Req { id: String, url: String, height: Option<u32>, audio_only: bool, audio_format: String, container: String, out_dir: Option<String>, cookie_browser: Option<String>, cookie_file: Option<String> }

#[derive(Serialize, Clone)]
struct Progress { id: String, status: String, percent: f32, speed: String, eta: String, file: Option<String>, error: Option<String> }

// Cookies are only ever passed for Facebook links; the frontend decides that.
fn cookie_args(browser: &Option<String>, file: &Option<String>) -> Vec<String> {
    if let Some(b) = browser {
        if ["firefox", "edge", "chrome", "brave"].contains(&b.as_str()) {
            return vec!["--cookies-from-browser".to_string(), b.clone()];
        }
    }
    if let Some(f) = file {
        if !f.trim().is_empty() { return vec!["--cookies".to_string(), f.clone()]; }
    }
    vec![]
}

// Sidecars are placed next to the app exe (dev and installed), so ffmpeg/ffprobe live in the same folder.
fn engine_dir() -> String {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().to_string())).unwrap_or_default()
}

// Prefer the updatable copy in the app data folder; fall back to the bundled yt-dlp.
fn ytdlp(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    if let Ok(d) = app.path().app_data_dir() {
        let p = d.join("engine").join("yt-dlp.exe");
        if p.exists() { return Ok(app.shell().command(p)); }
    }
    app.shell().sidecar("yt-dlp").map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_info(app: AppHandle, url: String, cookie_browser: Option<String>, cookie_file: Option<String>) -> Result<Info, String> {
    let mut a: Vec<String> = ["-J", "--no-playlist", "--flat-playlist", "--no-warnings"].iter().map(|s| s.to_string()).collect();
    a.extend(cookie_args(&cookie_browser, &cookie_file));
    a.push(url);
    let out = ytdlp(&app)?
        .args(a)
        .output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("yt-dlp failed").to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let mut heights: Vec<u32> = v["formats"].as_array().map(|f| {
        f.iter()
            .filter(|x| x["vcodec"].as_str().map_or(false, |c| c != "none"))
            .filter_map(|x| x["height"].as_u64().map(|h| h as u32))
            .collect()
    }).unwrap_or_default();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    heights.dedup();
    // Profile, channel or multi-video post links come back as a playlist; the app expands them into items.
    let entries: Vec<Entry> = v["entries"].as_array().map(|a| {
        a.iter().filter_map(|x| {
            let url = x["url"].as_str().or(x["webpage_url"].as_str())?;
            if !url.starts_with("http") { return None; }
            Some(Entry { id: x["id"].as_str().unwrap_or("").to_string(), title: x["title"].as_str().unwrap_or("Untitled").to_string(), url: url.to_string() })
        }).collect()
    }).unwrap_or_default();
    let is_playlist = v["_type"].as_str() == Some("playlist") && !entries.is_empty();
    Ok(Info {
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        duration: v["duration"].as_f64(),
        thumbnail: v["thumbnail"].as_str().map(String::from),
        uploader: v["uploader"].as_str().map(String::from),
        heights, is_playlist, entries,
    })
}

#[tauri::command]
async fn start_download(app: AppHandle, jobs: State<'_, Jobs>, req: Req) -> Result<(), String> {
    let dir = match &req.out_dir {
        Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
        _ => app.path().download_dir().map_err(|e| e.to_string())?.join("ClipQueue"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut a: Vec<String> = [
        "--no-playlist", "--newline", "--progress", "--no-warnings",
        "--progress-template", "download:PROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print", "after_move:FILE|%(filepath)s",
        "-o", "%(title).150B [%(id)s].%(ext)s",
    ].iter().map(|s| s.to_string()).collect();
    a.extend(["--ffmpeg-location".to_string(), engine_dir(), "-P".to_string(), dir.to_string_lossy().to_string()]);
    if req.audio_only {
        a.extend(["-x".to_string(), "--audio-format".to_string(), req.audio_format.clone()]);
    } else {
        let f = match req.height {
            Some(h) => format!("bv*[height<={h}]+ba/b[height<={h}]"),
            None => "bv*+ba/b".to_string(),
        };
        a.extend(["-f".to_string(), f, "--merge-output-format".to_string(), req.container.clone()]);
    }
    a.extend(cookie_args(&req.cookie_browser, &req.cookie_file));
    a.push(req.url.clone());

    let (mut rx, child) = ytdlp(&app)?
        .args(a).spawn().map_err(|e| e.to_string())?;
    jobs.0.lock().unwrap().insert(req.id.clone(), child);

    let (id, h) = (req.id.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        let (mut file, mut err): (Option<String>, String) = (None, String::new());
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) => {
                    let l = String::from_utf8_lossy(&b).trim().to_string();
                    if let Some(r) = l.strip_prefix("PROG|") {
                        let p: Vec<&str> = r.split('|').collect();
                        if p.len() == 3 {
                            let pct = p[0].trim().trim_end_matches('%').trim().parse::<f32>().unwrap_or(0.0);
                            let status = if pct >= 100.0 { "merging" } else { "downloading" };
                            let _ = h.emit("dl", Progress { id: id.clone(), status: status.to_string(), percent: pct, speed: p[1].trim().to_string(), eta: p[2].trim().to_string(), file: None, error: None });
                        }
                    } else if let Some(f) = l.strip_prefix("FILE|") {
                        file = Some(f.to_string());
                    }
                }
                CommandEvent::Stderr(b) => {
                    let l = String::from_utf8_lossy(&b).trim().to_string();
                    if l.starts_with("ERROR") { err = l; }
                }
                CommandEvent::Terminated(t) => {
                    h.state::<Jobs>().0.lock().unwrap().remove(&id);
                    let ok = t.code == Some(0);
                    let msg = if err.is_empty() { "Download stopped".to_string() } else { err.clone() };
                    let _ = h.emit("dl", Progress {
                        id: id.clone(), status: if ok { "done" } else { "failed" }.to_string(),
                        percent: if ok { 100.0 } else { 0.0 }, speed: String::new(), eta: String::new(),
                        file: file.clone(), error: if ok { None } else { Some(msg) },
                    });
                }
                _ => {}
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_download(jobs: State<'_, Jobs>, id: String) -> Result<(), String> {
    if let Some(c) = jobs.0.lock().unwrap().remove(&id) { c.kill().map_err(|e| e.to_string())?; }
    Ok(())
}

#[derive(Serialize)]
struct Entry { id: String, title: String, url: String }

#[derive(Serialize)]
struct Playlist { title: String, entries: Vec<Entry> }

#[tauri::command]
async fn fetch_playlist(app: AppHandle, url: String) -> Result<Playlist, String> {
    let out = ytdlp(&app)?
        .args(["-J", "--flat-playlist", "--no-warnings", url.as_str()])
        .output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("yt-dlp failed").to_string());
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let entries: Vec<Entry> = v["entries"].as_array().map(|a| {
        a.iter().filter_map(|x| {
            let id = x["id"].as_str()?;
            let title = x["title"].as_str().unwrap_or("Untitled");
            if title == "[Private video]" || title == "[Deleted video]" { return None; }
            Some(Entry { id: id.to_string(), title: title.to_string(), url: format!("https://www.youtube.com/watch?v={id}") })
        }).collect()
    }).unwrap_or_default();
    Ok(Playlist { title: v["title"].as_str().unwrap_or("Playlist").to_string(), entries })
}

#[tauri::command]
fn reveal(app: AppHandle, path: Option<String>, dir: Option<String>) -> Result<(), String> {
    let mut c = std::process::Command::new("explorer");
    match path {
        Some(p) => { c.arg(format!("/select,{}", p.replace('/', "\\"))); }
        None => {
            let d = match dir {
                Some(d) if !d.trim().is_empty() => std::path::PathBuf::from(d),
                _ => app.path().download_dir().map_err(|e| e.to_string())?.join("ClipQueue"),
            };
            let _ = std::fs::create_dir_all(&d);
            c.arg(d);
        }
    }
    let _ = c.spawn();
    Ok(())
}

#[tauri::command]
async fn engine_version(app: AppHandle) -> Result<String, String> {
    let out = ytdlp(&app)?.args(["--version"]).output().await.map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// yt-dlp updates itself in place. It runs on a copy in the app data folder, because the installed
// copy may not be writable. Callers must not run this while a download is active (Windows locks the exe).
#[tauri::command]
async fn update_engine(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("engine");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("yt-dlp.exe");
    if !target.exists() {
        let bundled = std::path::PathBuf::from(engine_dir()).join("yt-dlp.exe");
        std::fs::copy(&bundled, &target).map_err(|e| format!("Could not prepare the engine: {e}"))?;
    }
    let out = app.shell().command(&target).args(["-U"]).output().await.map_err(|e| e.to_string())?;
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("Update failed").trim().to_string());
    }
    Ok(text.trim().to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![fetch_info, fetch_playlist, start_download, cancel_download, reveal, engine_version, update_engine])
        .build(tauri::generate_context!())
        .expect("failed to build ClipQueue")
        .run(|h, e| {
            // Stop any running downloads when the app closes.
            if let tauri::RunEvent::Exit = e {
                if let Some(j) = h.try_state::<Jobs>() {
                    for (_, c) in j.0.lock().unwrap().drain() { let _ = c.kill(); }
                }
            }
        });
}
