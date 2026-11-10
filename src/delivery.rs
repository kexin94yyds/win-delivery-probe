//! Per-call local handoff status. Returned means handed to the HTTP handler,
//! never an acknowledgement from the model. The lock detects service exit.
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const FAILURE: &str = "连接已断开，回复未确认送达，请检查 AI 客户端。";

pub struct ResponseFileClaim {
    path: PathBuf,
    committed: bool,
}

impl ResponseFileClaim {
    pub fn acquire(response_file: &Path) -> std::io::Result<Self> {
        let path = response_file.with_extension("response.claim");
        OpenOptions::new().write(true).create_new(true).open(&path)?;
        Ok(Self { path, committed: false })
    }

    pub fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for ResponseFileClaim {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub fn publish_claimed_response_file(response_file: &Path, content: &str) -> std::io::Result<()> {
    let pending_file = response_file.with_extension(format!("pending-{}", uuid::Uuid::new_v4()));
    // 先完整写入并落盘，再用硬链接原子发布：目标已存在时失败，保证只有第一个写者交付
    // Windows 上 FlushFileBuffers 需要写权限：用只读的 File::open 再 sync_all 会报拒绝访问，
    // 回复文件因此永远不会发布（用户侧表现为"连接已断开，回复未确认送达"）。用同一个可写句柄写入并落盘。
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&pending_file)?;
        std::io::Write::write_all(&mut file, content.as_bytes())?;
        file.sync_all()
    })()
    .and_then(|_| fs::hard_link(&pending_file, response_file));
    let _ = fs::remove_file(&pending_file);
    result
}

#[derive(Debug)]
pub struct Delivery {
    pub path: PathBuf,
    state: Mutex<u8>,
    _owner: File,
}

impl Drop for Delivery {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(self.path.with_extension("lock"));
    }
}

impl Delivery {
    pub fn new() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!("iterate_delivery_{}", uuid::Uuid::new_v4()));
        let owner = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        owner.lock()?;
        fs::write(&path, b"w")?;
        Ok(Self {
            path,
            state: Mutex::new(b'w'),
            _owner: owner,
        })
    }

    fn finish(&self, next: u8) {
        if let Ok(mut state) = self.state.lock() {
            if *state == b'w' {
                // First terminal state wins, including cancellation vs completion.
                if fs::write(&self.path, [next]).is_ok() {
                    *state = next;
                }
            }
        }
    }
    pub fn failed(&self) {
        self.finish(b'f');
    }
    pub fn returned(&self) {
        self.finish(b'r');
    }
    pub fn disconnected(&self) -> bool {
        self.state.lock().map(|s| *s == b'f').unwrap_or(true)
    }
    pub fn was_returned(&self) -> bool {
        self.state.lock().map(|s| *s == b'r').unwrap_or(false)
    }
}

fn status_at(path: &std::path::Path) -> Result<&'static str, String> {
    match fs::read(path).map_err(|e| e.to_string())?.as_slice() {
        b"r" => return Ok("returned"),
        b"f" => return Ok("disconnected"),
        _ => {}
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok("disconnected"),
        Err(std::fs::TryLockError::WouldBlock) => Ok("waiting"),
        Err(error) => Err(error.to_string()),
    }
}

pub fn mcp_delivery_status() -> Result<String, String> {
    let Some(path) = std::env::var_os("ITERATE_DELIVERY_FILE").filter(|s| !s.is_empty()) else {
        return Ok("untracked".into());
    };
    status_at(&PathBuf::from(path)).map(String::from)
}

pub fn ensure_connected() -> Result<(), String> {
    if mcp_delivery_status()? == "disconnected" {
        return Err(FAILURE.into());
    }
    Ok(())
}

pub async fn wait_for_handoff() -> Result<(), String> {
    loop {
        match mcp_delivery_status()?.as_str() {
            "waiting" => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
            "disconnected" => return Err(FAILURE.into()),
            _ => return Ok(()),
        }
    }
}

