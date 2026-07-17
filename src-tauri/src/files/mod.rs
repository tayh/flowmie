//! File nodes (F003): a file or folder pinned to the canvas and wired to an
//! agent by an edge.
//!
//! Unlike a [`crate::resources`] blob — content-addressed, immutable, copied
//! into `~/.flowmie/resources/` — a file node is a **live pointer**. The node
//! holds an absolute path and every read hits the disk again, so editing the
//! file in an editor changes what a connected agent reads next. Nothing here
//! copies bytes; `as: "path"` hands the agent the real path so a CLI agent
//! reads it with its own tools.
//!
//! Access is authorized by the canvas topology (`can_reach`) in
//! [`crate::skills`], the same rule as the rest of F002 — this module only
//! resolves and reads once permission is already settled.

use std::fs;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

use crate::resources::{InlineImage, ReadResult};

/// Largest file we will inline (1 MiB). Anything bigger is served as a path —
/// matching F002 §4's "unknown/oversized resources are always returned
/// `as: path`" rule, and keeping a stray `get_resource` on a huge log from
/// trying to base64 it into an agent's context.
pub const MAX_INLINE_BYTES: u64 = 1024 * 1024;

/// The mime reported for a directory.
pub const DIRECTORY_MIME: &str = "inode/directory";

/// What the frontend learns about a path when a file node is created, and on
/// every workspace load so a vanished file shows its missing state.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileStat {
    pub exists: bool,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub size: u64,
    pub mime: String,
}

/// Extension → mime. Mirrors `MIME_BY_EXT` in src/lib/fileKind.ts; the two must
/// agree or the UI would show a kind the bridge refuses to serve inline.
fn mime_by_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "txt" | "toml" | "sql" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" | "jsonc" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "csv" => "text/csv",
        "html" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" | "jsx" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/rust",
        "py" => "text/x-python",
        "go" => "text/x-go",
        "rb" => "text/x-ruby",
        "java" => "text/x-java",
        "c" | "h" => "text/x-c",
        "cpp" | "hpp" => "text/x-c++",
        "sh" => "text/x-shellscript",
        "xml" => "text/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => return None,
    })
}

/// Extensionless filenames that are still text. Mirrors `TEXT_BASENAMES`.
fn is_text_basename(name: &str) -> bool {
    matches!(
        name,
        "dockerfile"
            | "makefile"
            | "readme"
            | "license"
            | "changelog"
            | "gemfile"
            | "rakefile"
            | "procfile"
    )
}

/// Best-effort mime for a path, by extension then by known basename. Unknown
/// types fall back to octet-stream, which is served by path — the safe default.
pub fn mime_for_path(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if let Some(idx) = name.rfind('.') {
        // A leading dot is a dotfile (`.gitignore`), not an extension.
        if idx > 0 {
            if let Some(mime) = mime_by_ext(&name[idx + 1..]) {
                return mime.to_string();
            }
        }
    }
    if name.starts_with('.') || is_text_basename(&name) {
        return "text/plain".to_string();
    }
    "application/octet-stream".to_string()
}

/// The resource kind a mime maps to. Mirrors `kindForMime` in fileKind.ts.
pub fn kind_for_mime(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("text/") || mime == "application/json" {
        "text"
    } else {
        "file"
    }
}

/// Resolve a path for the UI. A missing path is not an error — the node renders
/// a "missing" state — so this reports `exists: false` rather than failing.
pub fn stat(path: &str) -> FileStat {
    match fs::metadata(path) {
        Ok(md) => {
            let is_directory = md.is_dir();
            FileStat {
                exists: true,
                is_directory,
                size: if is_directory { 0 } else { md.len() },
                mime: if is_directory {
                    DIRECTORY_MIME.to_string()
                } else {
                    mime_for_path(path)
                },
            }
        }
        Err(_) => FileStat {
            exists: false,
            is_directory: false,
            size: 0,
            mime: "application/octet-stream".to_string(),
        },
    }
}

/// Read a file node's target. `as_ = "path"` (the default) returns the real
/// absolute path — no copy — so a CLI agent reads it with its own tools;
/// `"inline"` returns UTF-8 text or base64 image data, falling back to a path
/// for binary, oversized, or non-UTF-8 content.
///
/// Returns `Err` when the path is gone, so the caller can answer 404 and let
/// the node show its missing state.
pub fn read(path: &str, as_: &str) -> Result<ReadResult, String> {
    let md = fs::metadata(path).map_err(|_| format!("file not found: {path}"))?;
    if md.is_dir() {
        return Err(format!("is a directory: {path}"));
    }
    if as_ != "inline" {
        return Ok(ReadResult::Path {
            path: path.to_string(),
        });
    }

    let mime = mime_for_path(path);
    // Oversized content is never inlined regardless of kind.
    if md.len() > MAX_INLINE_BYTES {
        return Ok(ReadResult::Path {
            path: path.to_string(),
        });
    }

    match kind_for_mime(&mime) {
        "text" => match fs::read_to_string(path) {
            Ok(content) => Ok(ReadResult::Content { content }),
            // Mislabelled binary (a `.md` that isn't UTF-8): serve by path
            // rather than failing the agent's read.
            Err(_) => Ok(ReadResult::Path {
                path: path.to_string(),
            }),
        },
        "image" => {
            let bytes = fs::read(path).map_err(|e| e.to_string())?;
            Ok(ReadResult::InlineImage {
                inline_image: InlineImage {
                    data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                    mime,
                },
            })
        }
        _ => Ok(ReadResult::Path {
            path: path.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("flowmie-files-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(dir: &Path, name: &str, contents: &[u8]) -> String {
        let path = dir.join(name);
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(contents).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn mime_inference_mirrors_the_frontend() {
        assert_eq!(mime_for_path("/src/main.rs"), "text/rust");
        assert_eq!(mime_for_path("/src/App.tsx"), "text/typescript");
        assert_eq!(mime_for_path("/tmp/SHOT.PNG"), "image/png");
        assert_eq!(mime_for_path("/repo/.gitignore"), "text/plain");
        assert_eq!(mime_for_path("/repo/Dockerfile"), "text/plain");
        assert_eq!(mime_for_path("/tmp/thing.xyz"), "application/octet-stream");
        assert_eq!(mime_for_path("/tmp/notes.backup.md"), "text/markdown");
    }

    #[test]
    fn kind_mapping_mirrors_the_frontend() {
        assert_eq!(kind_for_mime("image/png"), "image");
        assert_eq!(kind_for_mime("text/markdown"), "text");
        assert_eq!(kind_for_mime("application/json"), "text");
        assert_eq!(kind_for_mime("application/pdf"), "file");
    }

    #[test]
    fn stat_reports_files_dirs_and_absences() {
        let dir = temp_dir("stat");
        let file = write_file(&dir, "spec.md", b"hello");

        let s = stat(&file);
        assert!(s.exists && !s.is_directory);
        assert_eq!(s.size, 5);
        assert_eq!(s.mime, "text/markdown");

        let d = stat(&dir.to_string_lossy());
        assert!(d.exists && d.is_directory);
        assert_eq!(d.mime, DIRECTORY_MIME);

        let missing = stat(&dir.join("nope.md").to_string_lossy());
        assert!(!missing.exists);
    }

    #[test]
    fn read_path_returns_the_real_path_not_a_copy() {
        let dir = temp_dir("read-path");
        let file = write_file(&dir, "spec.md", b"hello");
        assert_eq!(read(&file, "path").unwrap(), ReadResult::Path { path: file });
    }

    #[test]
    fn read_inline_returns_text_and_tracks_edits_on_disk() {
        let dir = temp_dir("read-inline");
        let file = write_file(&dir, "spec.md", b"v1");
        assert_eq!(
            read(&file, "inline").unwrap(),
            ReadResult::Content {
                content: "v1".into()
            }
        );

        // The live-pointer promise: an edit on disk is what the next read sees.
        write_file(&dir, "spec.md", b"v2");
        assert_eq!(
            read(&file, "inline").unwrap(),
            ReadResult::Content {
                content: "v2".into()
            }
        );
    }

    #[test]
    fn read_inline_serves_images_as_base64() {
        let dir = temp_dir("read-image");
        let file = write_file(&dir, "shot.png", &[0x89, 0x50, 0x4e, 0x47]);
        match read(&file, "inline").unwrap() {
            ReadResult::InlineImage { inline_image } => {
                assert_eq!(inline_image.mime, "image/png");
                assert_eq!(inline_image.data_base64, "iVBORw==");
            }
            other => panic!("expected an inline image, got {other:?}"),
        }
    }

    #[test]
    fn read_inline_falls_back_to_path_for_binary_and_oversized() {
        let dir = temp_dir("read-fallback");

        let bin = write_file(&dir, "blob.zip", &[0u8, 1, 2]);
        assert_eq!(
            read(&bin, "inline").unwrap(),
            ReadResult::Path { path: bin }
        );

        // Over the inline cap, even though `.md` is text.
        let big = write_file(&dir, "big.md", &vec![b'x'; (MAX_INLINE_BYTES + 1) as usize]);
        assert_eq!(
            read(&big, "inline").unwrap(),
            ReadResult::Path { path: big }
        );

        // Non-UTF-8 masquerading as text must not fail the read.
        let fake = write_file(&dir, "fake.md", &[0xff, 0xfe, 0x00]);
        assert_eq!(
            read(&fake, "inline").unwrap(),
            ReadResult::Path { path: fake }
        );
    }

    #[test]
    fn read_errors_on_missing_and_directories() {
        let dir = temp_dir("read-errors");
        assert!(read(&dir.join("nope.md").to_string_lossy(), "path")
            .unwrap_err()
            .contains("file not found"));
        assert!(read(&dir.to_string_lossy(), "path")
            .unwrap_err()
            .contains("is a directory"));
    }
}
