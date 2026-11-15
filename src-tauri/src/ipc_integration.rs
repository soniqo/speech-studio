use super::*;
use std::io::Read;
use std::net::TcpListener;
use std::sync::{atomic::AtomicBool, Arc};
use std::time::Duration;

struct Fixture {
    root: PathBuf,
    stop: Arc<AtomicBool>,
    fail_load: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    thread: Option<std::thread::JoinHandle<()>>,
    previous_url: Option<std::ffi::OsString>,
    previous_token: Option<std::ffi::OsString>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("studio-ipc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let token = root.join("token");
        std::fs::write(&token, "fixture-token").unwrap();
        let wav = root.join("audio.wav");
        write_wav_pcm16_mono(&wav, 16_000, &vec![0.1; 1600]).unwrap();
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(std::fs::read(&wav).unwrap());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let fail_load = Arc::new(AtomicBool::new(false));
        let thread_fail = fail_load.clone();
        let thread_stop = stop.clone();
        let thread_requests = requests.clone();
        let thread = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture server: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                let mut authorized = false;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    let lower = line.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                    if lower.trim() == "authorization: bearer fixture-token" {
                        authorized = true;
                    }
                }
                assert!(authorized, "fixture requests must use the test token");
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body = if bytes.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::from_slice(&bytes).unwrap()
                };
                let failed = first.contains("/models/load ") && thread_fail.load(Ordering::SeqCst);
                thread_requests
                    .lock()
                    .unwrap()
                    .push((first.trim().to_string(), body));
                let body = if failed {
                    serde_json::json!({ "error": "fixture load failed" })
                } else {
                    serde_json::json!({ "ok": true, "audioBase64": encoded, "sampleRate": 16000, "durationSec": 0.1 })
                }.to_string();
                let status = if failed {
                    "503 Service Unavailable"
                } else {
                    "200 OK"
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let previous_url = std::env::var_os("SPEECH_RUNTIME_URL");
        let previous_token = std::env::var_os("SPEECH_RUNTIME_TOKEN_FILE");
        std::env::set_var("SPEECH_RUNTIME_URL", url);
        std::env::set_var("SPEECH_RUNTIME_TOKEN_FILE", token);
        Self {
            root,
            stop,
            fail_load,
            requests,
            thread: Some(thread),
            previous_url,
            previous_token,
        }
    }

    fn sidecar(&self) -> SidecarManager {
        let script = self.root.join("sidecar.py");
        std::fs::write(
            &script,
            r#"import json, sys
for line in sys.stdin:
    request = json.loads(line)
    result = {"modelId":"fixture/model", "paths":[], "exists":False, "bytes":0, "loaded":False}
    print(json.dumps({"id":request["id"], "ok":True, "result":result}), flush=True)
"#,
        )
        .unwrap();
        let mut child = Command::new(if cfg!(windows) { "python" } else { "python3" })
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let pid = child.id();
        SidecarManager {
            inner: Mutex::new(Some(SidecarProcess {
                child,
                stdin,
                stdout,
            })),
            child_pid: AtomicU32::new(pid),
            resource_dir: None,
            app: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        for (key, value) in [
            ("SPEECH_RUNTIME_URL", &self.previous_url),
            ("SPEECH_RUNTIME_TOKEN_FILE", &self.previous_token),
        ] {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn frontend_packets_cross_dispatcher_and_shared_runtime_without_local_weights() {
    let fixture = Fixture::new();
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = format!("audio.soniqo.ipc-test-{}", uuid::Uuid::new_v4());
    let app = tauri::test::mock_builder()
        .manage(fixture.sidecar())
        .manage(ModelSettingsState(Mutex::new(ModelSettings::default())))
        .invoke_handler(tauri::generate_handler![
            tts_model_artifact,
            delete_tts_model,
            import_tts_bundle,
            set_runtime_mode,
            init_model,
            speech_runtime::speech_runtime_tts_load,
            speech_runtime::speech_runtime_tts_unload,
            speech_runtime::speech_runtime_tts_delete_voice,
            speech_runtime::speech_runtime_tts_cancel,
            speech_runtime::speech_runtime_tts_synthesize,
            synthesize_clip,
        ])
        .build(context)
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let packets: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../src/ipc/fixtures/ttsCommands.json")).unwrap();
    let dispatch = |command: &str, body: serde_json::Value| {
        tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    };
    for packet in packets {
        let command = packet["command"].as_str().unwrap();
        let response = dispatch(command, packet["payload"].clone());
        if command == "import_tts_bundle" {
            assert!(response
                .err()
                .unwrap()
                .to_string()
                .contains("Only local ESpeech"));
            continue;
        }
        let body: serde_json::Value = response
            .unwrap_or_else(|error| panic!("{command}: {error}"))
            .deserialize()
            .unwrap();
        if let Some(path) = body.get("audioPath").and_then(|v| v.as_str()) {
            assert!(wav_duration_sec(Path::new(path)).unwrap() > 0.0);
            std::fs::remove_file(path).unwrap();
        }
        if command == "set_runtime_mode" || command == "init_model" {
            let manager = app.state::<SidecarManager>();
            assert_eq!(manager.child_pid.load(Ordering::SeqCst), 0);
            assert!(
                manager.inner.lock().unwrap().is_none(),
                "shared mode must release local weights"
            );
        }
    }
    // Exercise the editor's synthesis entry point too: it must route through
    // the daemon even when no local sidecar can be spawned by this fixture.
    #[cfg(target_os = "macos")]
    {
        let result: serde_json::Value = dispatch("synthesize_clip", serde_json::json!({"args":{
        "clipId":"fixture-clip", "engine":"qwen3", "voiceId":"voice-1",
        "referenceAudioPath":fixture.root.join("audio.wav"), "referenceText":"Reference words",
        "text":"(excited) Hello world", "language":"en"
    }})).unwrap().deserialize().unwrap();
        std::fs::remove_file(result["audioPath"].as_str().unwrap()).unwrap();
    }
    fixture.fail_load.store(true, Ordering::SeqCst);
    let error = dispatch(
        "init_model",
        serde_json::json!({ "args": { "engine": "voxcpm2" } }),
    )
    .err()
    .unwrap()
    .to_string();
    assert!(error.contains("503") && error.contains("fixture load failed"));
    assert_eq!(
        app.state::<SidecarManager>()
            .child_pid
            .load(Ordering::SeqCst),
        0
    );
    fixture.fail_load.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let error = dispatch(
            "init_model",
            serde_json::json!({ "args": { "engine": "cosyvoice" } }),
        )
        .err()
        .unwrap()
        .to_string();
        assert!(error.contains("not available through Shared Speech Runtime"));
    }
    let requests = fixture.requests.lock().unwrap();
    assert!(requests
        .iter()
        .any(|(path, body)| path == "POST /v1/tts/models/load HTTP/1.1"
            && body["variant"] == "bf16"
            && body["model"] == "qwen3"));
    assert!(requests
        .iter()
        .any(|(path, body)| path == "POST /v1/tts/cancel HTTP/1.1"
            && body["requestId"] == "request-1"));
    assert!(requests
        .iter()
        .any(|(path, _)| path.contains("id=voice%20%2F%3F%26")));
    assert_eq!(
        requests
            .iter()
            .filter(|(path, _)| path == "POST /v1/tts/synthesize HTTP/1.1")
            .count(),
        if cfg!(target_os = "macos") { 2 } else { 1 }
    );
    #[cfg(target_os = "macos")]
    assert!(requests
        .iter()
        .any(|(path, body)| path.contains("/synthesize")
            && body["text"] == "Hello world"
            && body.get("referenceAudioBase64").is_some()));
    drop(requests);
    let settings_dir = app.path().app_data_dir().unwrap();
    assert!(settings_dir
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("audio.soniqo.ipc-test-"));
    std::fs::remove_dir_all(settings_dir).unwrap();
}
