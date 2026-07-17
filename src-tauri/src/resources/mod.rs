//! Content-addressed resource store (F002 Phase 3).
//!
//! Resources are the images and files that live *on the canvas* rather than in
//! any single agent's context: a screenshot an agent captured of a Portal, a
//! file it published for a peer, an image the user dropped in. Blobs are stored
//! by content hash under `~/.flowmie/resources/`, and a lightweight
//! [`ResourceRef`] (id, kind, mime, owner, on-disk path) is what the graph and
//! the skills bridge pass around.
//!
//! The store is the single source of truth the frontend persists into the
//! workspace and the bridge answers `list_resources` / `get_resource` from.
//! Who may *see* a given resource is decided by canvas topology, up in
//! `skills::can_access_resource` — the store itself only stores and reads.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A resource on the canvas. Mirrors the TypeScript `ResourceRef` one-to-one
/// and persists in the workspace JSON (blobs stay on disk, not inlined).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResourceRef {
    pub id: String,
    /// `"image" | "text" | "file"`.
    pub kind: String,
    pub mime: String,
    pub label: String,
    /// Node that produced it; `None` for a user-dropped resource.
    #[serde(rename = "ownerNodeId", default)]
    pub owner_node_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    /// Absolute path to the blob under `~/.flowmie/resources/`.
    pub path: String,
}

/// The materialized form returned by [`ResourceStore::read`]. `Path` hands the
/// agent a real file path (default for binary/large blobs — CLI agents read by
/// path); `Content` is inline UTF-8 text; `InlineImage` is base64 image data an
/// MCP-vision agent can render directly.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum ReadResult {
    Path {
        path: String,
    },
    Content {
        content: String,
    },
    InlineImage {
        #[serde(rename = "inlineImage")]
        inline_image: InlineImage,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InlineImage {
    #[serde(rename = "dataBase64")]
    pub data_base64: String,
    pub mime: String,
}

/// Tauri-managed resource store. Blobs live under `dir`; the in-memory list is
/// seeded on workspace load and appended to as agents/users register.
pub struct ResourceStore {
    resources: Mutex<Vec<ResourceRef>>,
    dir: PathBuf,
}

impl ResourceStore {
    /// Default store rooted at `~/.flowmie/resources/`.
    pub fn new() -> Self {
        let dir = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".flowmie")
            .join("resources");
        Self::from_dir(dir)
    }

    pub fn from_dir(dir: PathBuf) -> Self {
        Self {
            resources: Mutex::new(Vec::new()),
            dir,
        }
    }

    fn ensure_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())
    }

    /// Store raw bytes content-addressed and register a ref for them. Identical
    /// bytes reuse the same on-disk blob; each call still mints a fresh ref
    /// (its own id/label/owner).
    pub fn register_bytes(
        &self,
        kind: &str,
        mime: &str,
        label: &str,
        owner: Option<String>,
        bytes: &[u8],
    ) -> Result<ResourceRef, String> {
        self.ensure_dir()?;
        let hash = hex(&Sha256::digest(bytes));
        let filename = format!("{hash}.{}", ext_for(mime, kind));
        let path = self.dir.join(&filename);
        if !path.exists() {
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
        }
        let resource = ResourceRef {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            mime: mime.to_string(),
            label: label.to_string(),
            owner_node_id: owner,
            created_at: iso8601_now(),
            path: path.to_string_lossy().into_owned(),
        };
        self.resources.lock().unwrap().push(resource.clone());
        Ok(resource)
    }

    /// Copy an existing file into the store and register a ref for it.
    pub fn register_from_path(
        &self,
        kind: &str,
        mime: &str,
        label: &str,
        owner: Option<String>,
        src: &str,
    ) -> Result<ResourceRef, String> {
        let bytes = fs::read(src).map_err(|e| format!("cannot read {src}: {e}"))?;
        self.register_bytes(kind, mime, label, owner, &bytes)
    }

    /// Seed a ref from a persisted workspace on load (blob already on disk).
    /// Idempotent by id so re-syncing never duplicates.
    pub fn insert_existing(&self, resource: ResourceRef) {
        let mut list = self.resources.lock().unwrap();
        if !list.iter().any(|r| r.id == resource.id) {
            list.push(resource);
        }
    }

    pub fn get(&self, id: &str) -> Option<ResourceRef> {
        self.resources.lock().unwrap().iter().find(|r| r.id == id).cloned()
    }

    pub fn all(&self) -> Vec<ResourceRef> {
        self.resources.lock().unwrap().clone()
    }

    /// Materialize a resource. `as_ = "path"` returns the on-disk path;
    /// `"inline"` returns UTF-8 text for text resources or base64 image data
    /// for images. Non-text/oversized blobs always fall back to a path.
    pub fn read(&self, id: &str, as_: &str) -> Result<ReadResult, String> {
        let resource = self.get(id).ok_or_else(|| "unknown resource".to_string())?;
        if as_ != "inline" {
            return Ok(ReadResult::Path { path: resource.path });
        }
        match resource.kind.as_str() {
            "text" => {
                let content = fs::read_to_string(&resource.path).map_err(|e| e.to_string())?;
                Ok(ReadResult::Content { content })
            }
            "image" => {
                let bytes = fs::read(&resource.path).map_err(|e| e.to_string())?;
                Ok(ReadResult::InlineImage {
                    inline_image: InlineImage {
                        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                        mime: resource.mime,
                    },
                })
            }
            // Unknown/binary: never inline — hand back a path.
            _ => Ok(ReadResult::Path { path: resource.path }),
        }
    }
}

impl Default for ResourceStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Decode a base64 payload the frontend or an agent handed us.
pub fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("invalid base64: {e}"))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Pick a file extension from the mime type, falling back to the kind.
fn ext_for(mime: &str, kind: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        "application/pdf" => "pdf",
        _ => match kind {
            "image" => "img",
            "text" => "txt",
            _ => "bin",
        },
    }
}

/// ISO-8601 UTC timestamp (`2026-07-16T12:34:56Z`) without pulling in a date
/// crate. Uses Howard Hinnant's civil-from-days algorithm.
fn iso8601_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Convert days-since-1970-01-01 to (year, month, day). Public-domain algorithm
/// from Howard Hinnant's `chrono`-compatible date math.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> ResourceStore {
        let dir = std::env::temp_dir().join(format!("flowmie-res-{}", uuid::Uuid::new_v4()));
        ResourceStore::from_dir(dir)
    }

    #[test]
    fn register_is_content_addressed_and_reusable() {
        let store = tmp_store();
        let a = store
            .register_bytes("text", "text/plain", "one", Some("n1".into()), b"hello")
            .unwrap();
        let b = store
            .register_bytes("text", "text/plain", "two", Some("n2".into()), b"hello")
            .unwrap();
        // Same bytes → same blob path; distinct refs.
        assert_eq!(a.path, b.path);
        assert_ne!(a.id, b.id);
        assert!(std::path::Path::new(&a.path).exists());
    }

    #[test]
    fn read_path_and_inline_variants() {
        let store = tmp_store();
        let text = store
            .register_bytes("text", "text/plain", "t", None, b"the note body")
            .unwrap();
        assert_eq!(
            store.read(&text.id, "inline").unwrap(),
            ReadResult::Content { content: "the note body".into() }
        );
        // A path read hands back the on-disk location.
        match store.read(&text.id, "path").unwrap() {
            ReadResult::Path { path } => assert!(path.ends_with(".txt")),
            other => panic!("expected path, got {other:?}"),
        }

        let img = store
            .register_bytes("image", "image/png", "shot", None, &[1, 2, 3, 4])
            .unwrap();
        match store.read(&img.id, "inline").unwrap() {
            ReadResult::InlineImage { inline_image } => {
                assert_eq!(inline_image.mime, "image/png");
                assert_eq!(
                    decode_base64(&inline_image.data_base64).unwrap(),
                    vec![1, 2, 3, 4]
                );
            }
            other => panic!("expected inline image, got {other:?}"),
        }
    }

    #[test]
    fn insert_existing_is_idempotent_by_id() {
        let store = tmp_store();
        let r = store
            .register_bytes("file", "application/octet-stream", "f", None, b"x")
            .unwrap();
        store.insert_existing(r.clone());
        store.insert_existing(r.clone());
        assert_eq!(store.all().iter().filter(|x| x.id == r.id).count(), 1);
    }

    #[test]
    fn iso8601_shape_is_correct() {
        let ts = iso8601_now();
        assert_eq!(ts.len(), 20, "{ts}");
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(18_993), (2022, 1, 1));
        // 2000-02-29 (leap day) is 11016 days after epoch.
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }

    /// Acceptance criterion 3: after a "restart" a persisted `ResourceRef`
    /// re-seeds a fresh store and its blob is still readable. Simulated by
    /// serializing the ref to JSON, deserializing into a new store, and reading
    /// the blob back — the blob outlives the in-memory list because it is on
    /// disk at its content path.
    #[test]
    fn persisted_ref_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("flowmie-res-{}", uuid::Uuid::new_v4()));
        // Session 1: register a resource, then serialize it as a workspace would.
        let session1 = ResourceStore::from_dir(dir.clone());
        let original = session1
            .register_bytes("text", "text/plain", "kept", Some("n1".into()), b"survive me")
            .unwrap();
        let json = serde_json::to_string(&original).unwrap();

        // Session 2: brand-new store (empty list), re-seed from the persisted
        // ref (as `resources_sync` does on load), and read the blob back.
        let deserialized: ResourceRef = serde_json::from_str(&json).unwrap();
        let session2 = ResourceStore::from_dir(dir);
        assert!(session2.get(&original.id).is_none(), "starts empty");
        session2.insert_existing(deserialized);
        assert_eq!(
            session2.read(&original.id, "inline").unwrap(),
            ReadResult::Content { content: "survive me".into() }
        );
    }
}
