//! Exercises the v0.7.2-fix reply handoff with real OS file semantics.
mod delivery;
use std::{env, fs, path::PathBuf, process::Command, time::Duration};

fn old_publish(response_file: &std::path::Path, content: &str) -> std::io::Result<()> {
    let pending = response_file.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    let result = fs::write(&pending, content)
        .and_then(|_| fs::File::open(&pending)?.sync_all())
        .and_then(|_| fs::hard_link(&pending, response_file));
    let _ = fs::remove_file(&pending);
    result
}

fn child_status(status_file: &std::path::Path) -> String {
    let out = Command::new(env::current_exe().unwrap())
        .args(["status", status_file.to_str().unwrap()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn report(name: &str, ok: bool, detail: String, failed: &mut u32) {
    println!("{} {name}: {detail}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        *failed += 1;
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("status") {
        env::set_var("ITERATE_DELIVERY_FILE", &args[2]);
        match delivery::mcp_delivery_status() {
            Ok(status) => println!("{status}"),
            Err(error) => println!("ERR:{error}"),
        }
        return;
    }
    if args.get(1).map(String::as_str) == Some("hold") {
        let held = delivery::Delivery::new().unwrap();
        println!("{}", held.path.display());
        std::thread::sleep(Duration::from_secs(600));
        return;
    }

    let mut failed = 0;
    let dir: PathBuf = env::temp_dir().join(format!("iterate_probe_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let response = dir.join("iterate_response_serve-1.json");

    let old = old_publish(&dir.join("old.json"), "{}");
    println!(
        "INFO old read-only publish on {}: {:?} raw_os_error={:?}",
        env::consts::OS,
        old.as_ref().map_err(|e| e.to_string()),
        old.as_ref().err().and_then(|e| e.raw_os_error())
    );
    if cfg!(windows) {
        report(
            "old publish is rejected on Windows",
            old.as_ref().err().and_then(|e| e.raw_os_error()) == Some(5),
            format!("{old:?}"),
            &mut failed,
        );
    }

    let mut claim = delivery::ResponseFileClaim::acquire(&response).unwrap();
    let published = delivery::publish_claimed_response_file(&response, r#"{"user_input":"hi"}"#);
    report("fixed publish creates response", published.is_ok() && response.exists(), format!("{published:?}"), &mut failed);
    claim.commit();
    report("response readable", fs::read_to_string(&response).ok().as_deref() == Some(r#"{"user_input":"hi"}"#), String::new(), &mut failed);
    let leftovers: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).filter(|n| n.to_string_lossy().contains("pending")).collect();
    report("no pending leftovers", leftovers.is_empty(), format!("{leftovers:?}"), &mut failed);
    let second = delivery::publish_claimed_response_file(&response, "{}");
    report("second writer cannot replace", second.is_err(), format!("{second:?}"), &mut failed);

    let tracker = delivery::Delivery::new().unwrap();
    let status = child_status(&tracker.path);
    report("other process sees waiting while owner holds lock", status == "waiting", status, &mut failed);
    tracker.returned();
    let status = child_status(&tracker.path);
    report("other process sees returned", status == "returned", status, &mut failed);

    let tracker = delivery::Delivery::new().unwrap();
    tracker.failed();
    let status = child_status(&tracker.path);
    report("other process sees failed as disconnected", status == "disconnected", status, &mut failed);

    let mut holder = Command::new(env::current_exe().unwrap())
        .arg("hold")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = holder.stdout.take().unwrap();
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while std::io::Read::read(&mut out, &mut byte).unwrap() == 1 && byte[0] != b'\n' {
        buf.push(byte[0]);
    }
    let held = PathBuf::from(String::from_utf8_lossy(&buf).trim().to_string());
    let status = child_status(&held);
    report("second process sees waiting across processes", status == "waiting", status, &mut failed);
    holder.kill().unwrap();
    holder.wait().unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = child_status(&held);
    report("owner crash reads as disconnected", status == "disconnected", status, &mut failed);

    let tracker = std::sync::Arc::new(delivery::Delivery::new().unwrap());
    let path = tracker.path.clone();
    let reader = std::thread::spawn(move || {
        let mut unexpected = Vec::new();
        for _ in 0..400 {
            let status = child_status(&path);
            if status != "waiting" && status != "returned" {
                unexpected.push(status);
            }
        }
        unexpected
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    tracker.returned();
    let unexpected = reader.join().unwrap();
    report("status polling during returned stays clean", unexpected.is_empty(), format!("{unexpected:?}"), &mut failed);
    drop(tracker);

    let tracker = delivery::Delivery::new().unwrap();
    let path = tracker.path.clone();
    drop(tracker);
    let status = child_status(&path);
    println!("INFO status after owner dropped files: {status}");

    let _ = fs::remove_dir_all(&dir);
    println!("RESULT failed={failed}");
    std::process::exit(if failed == 0 { 0 } else { 1 });
}
