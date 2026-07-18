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
use std::path::{Component, Path};

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

/// How deep a folder-node listing descends (F003 §4 guards). Members below this
/// are simply not listed; the directory that would hold them is still shown.
pub const MAX_LIST_DEPTH: usize = 3;

/// How many entries a folder-node listing yields before it is truncated. Keeps
/// a listing of a huge tree from flooding the agent's context.
pub const MAX_LIST_ENTRIES: usize = 1000;

/// Directory names skipped when listing a folder node — noise the agent almost
/// never wants and that would blow the entry cap on its own.
const IGNORED_DIRS: &[&str] = &[".git", "node_modules"];

/// Why a `file:<id>/<relative>` member read was refused. Distinguishes the
/// traversal-guard rejection (`Escapes`, a 403) from a genuinely absent path
/// (`RootMissing`/`NotFound`, a 404) so the agent can tell "not allowed" from
/// "not there".
#[derive(Debug, PartialEq)]
pub enum MemberError {
    /// The folder node's own path is gone.
    RootMissing,
    /// The member does not exist under the root.
    NotFound,
    /// The member canonicalizes outside the root — `..`, an absolute component,
    /// or a symlink escaping the root. This is the traversal guard firing.
    Escapes,
}

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

/// A depth- and entry-capped listing of a folder node's contents, one relative
/// path per line (directories keep a trailing `/`). `.git`/`node_modules` are
/// skipped. When the cap is hit the last line states the truncation, so the
/// agent knows the listing is partial (F003 §4 guards).
pub fn list_dir(root: &str) -> Result<String, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut lines: Vec<String> = Vec::new();
    let mut truncated = false;
    walk_dir(root_path, root_path, 1, &mut lines, &mut truncated);

    let mut body = lines.join("\n");
    if truncated {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&format!(
            "… (listing truncated at {MAX_LIST_ENTRIES} entries)"
        ));
    }
    Ok(body)
}

/// Depth-first walk collecting relative paths, capped at [`MAX_LIST_ENTRIES`]
/// and [`MAX_LIST_DEPTH`]. Entries are sorted for a stable, readable listing.
fn walk_dir(root: &Path, dir: &Path, depth: usize, lines: &mut Vec<String>, truncated: &mut bool) {
    let mut entries: Vec<fs::DirEntry> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => return,
    };
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        if lines.len() >= MAX_LIST_ENTRIES {
            *truncated = true;
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && IGNORED_DIRS.contains(&name.as_ref()) {
            continue;
        }

        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();

        if is_dir {
            lines.push(format!("{rel}/"));
            if depth < MAX_LIST_DEPTH {
                walk_dir(root, &path, depth + 1, lines, truncated);
                if *truncated {
                    return;
                }
            }
        } else {
            lines.push(rel);
        }
    }
}

/// Read one member of a folder node, addressed as `file:<id>/<relative>`. The
/// member is canonicalized and must stay inside the canonicalized root —
/// `..`, absolute components, and symlinks escaping the root are all rejected
/// as [`MemberError::Escapes`]. A directory member returns its own listing.
///
/// This is the one genuinely new attack surface in F003: `<relative>` comes
/// straight from an agent's tool call, so containment is checked against the
/// *canonicalized* paths (symlinks already resolved), not the textual join.
pub fn read_member(root: &str, relative: &str, as_: &str) -> Result<ReadResult, MemberError> {
    let root_canon = fs::canonicalize(root).map_err(|_| MemberError::RootMissing)?;

    // Reject hostile shapes before touching disk: only plain (`Normal`) and
    // `.` (`CurDir`) components may appear — `..`, absolute roots, and Windows
    // prefixes are out.
    let rel = Path::new(relative);
    let shape_ok = rel
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !shape_ok || relative.is_empty() {
        return Err(MemberError::Escapes);
    }

    // Canonicalize resolves any symlink in the path; the containment check then
    // catches a link that points outside the root.
    let member = fs::canonicalize(root_canon.join(rel)).map_err(|_| MemberError::NotFound)?;
    if !member.starts_with(&root_canon) {
        return Err(MemberError::Escapes);
    }

    let member_str = member.to_string_lossy();
    if member.is_dir() {
        return list_dir(&member_str)
            .map(|content| ReadResult::Content { content })
            .map_err(|_| MemberError::NotFound);
    }
    read(&member_str, as_).map_err(|_| MemberError::NotFound)
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

    #[test]
    fn list_dir_walks_capped_and_filtered() {
        let dir = temp_dir("list");
        write_file(&dir, "a.md", b"a");
        fs::create_dir_all(dir.join("src")).unwrap();
        write_file(&dir.join("src"), "main.rs", b"fn main() {}");
        // Ignored dirs never appear in the listing.
        fs::create_dir_all(dir.join(".git")).unwrap();
        write_file(&dir.join(".git"), "HEAD", b"ref");
        fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();

        let listing = list_dir(&dir.to_string_lossy()).unwrap();
        assert!(listing.contains("a.md"), "listing: {listing}");
        assert!(listing.contains("src/"), "listing: {listing}");
        assert!(listing.contains("src/main.rs"), "listing: {listing}");
        assert!(!listing.contains(".git"), "listing: {listing}");
        assert!(!listing.contains("node_modules"), "listing: {listing}");
    }

    #[test]
    fn list_dir_states_truncation() {
        let dir = temp_dir("list-trunc");
        for i in 0..(MAX_LIST_ENTRIES + 50) {
            write_file(&dir, &format!("f{i:04}.txt"), b"x");
        }
        let listing = list_dir(&dir.to_string_lossy()).unwrap();
        assert!(listing.contains("truncated"), "listing tail: {listing}");
        // Never yields more content lines than the cap (+1 truncation notice).
        assert!(listing.lines().count() <= MAX_LIST_ENTRIES + 1);
    }

    #[test]
    fn list_dir_stops_at_max_depth() {
        let dir = temp_dir("list-depth");
        // depth 1: d1/, depth 2: d1/d2/, depth 3: d1/d2/d3/, depth 4: too deep.
        fs::create_dir_all(dir.join("d1/d2/d3/d4")).unwrap();
        write_file(&dir.join("d1/d2/d3/d4"), "deep.txt", b"x");
        let listing = list_dir(&dir.to_string_lossy()).unwrap();
        assert!(listing.contains("d1/d2/d3/"), "listing: {listing}");
        // d4 sits at depth 4 — below the cap, so it is not listed.
        assert!(!listing.contains("d4"), "listing: {listing}");
    }

    #[test]
    fn read_member_reads_a_file_inside_the_folder() {
        let dir = temp_dir("member-read");
        fs::create_dir_all(dir.join("src")).unwrap();
        write_file(&dir.join("src"), "main.rs", b"fn main() {}");
        match read_member(&dir.to_string_lossy(), "src/main.rs", "inline").unwrap() {
            ReadResult::Content { content } => assert_eq!(content, "fn main() {}"),
            other => panic!("expected inline content, got {other:?}"),
        }
    }

    #[test]
    fn read_member_lists_a_subdirectory() {
        let dir = temp_dir("member-subdir");
        fs::create_dir_all(dir.join("src")).unwrap();
        write_file(&dir.join("src"), "main.rs", b"fn main() {}");
        match read_member(&dir.to_string_lossy(), "src", "path").unwrap() {
            ReadResult::Content { content } => assert!(content.contains("main.rs")),
            other => panic!("expected a listing, got {other:?}"),
        }
    }

    #[test]
    fn read_member_rejects_parent_traversal() {
        let dir = temp_dir("member-traversal");
        fs::create_dir_all(dir.join("inner")).unwrap();
        write_file(&dir, "secret.txt", b"top secret");
        // `inner/../secret.txt` stays inside, but a climb above the root escapes.
        let root = dir.join("inner");
        assert_eq!(
            read_member(&root.to_string_lossy(), "../secret.txt", "inline"),
            Err(MemberError::Escapes)
        );
        assert_eq!(
            read_member(&root.to_string_lossy(), "../../etc/passwd", "inline"),
            Err(MemberError::Escapes)
        );
    }

    #[test]
    fn read_member_rejects_absolute_paths() {
        let dir = temp_dir("member-absolute");
        assert_eq!(
            read_member(&dir.to_string_lossy(), "/etc/passwd", "inline"),
            Err(MemberError::Escapes)
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_member_rejects_symlink_escaping_the_root() {
        use std::os::unix::fs::symlink;
        let base = temp_dir("member-symlink");
        let root = base.join("root");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        write_file(&outside, "secret.txt", b"top secret");
        // A symlink inside the root that points outside it must not be readable.
        symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        assert_eq!(
            read_member(&root.to_string_lossy(), "link.txt", "inline"),
            Err(MemberError::Escapes)
        );
    }

    #[test]
    fn read_member_reports_missing_and_missing_root() {
        let dir = temp_dir("member-missing");
        assert_eq!(
            read_member(&dir.to_string_lossy(), "nope.txt", "inline"),
            Err(MemberError::NotFound)
        );
        assert_eq!(
            read_member(&dir.join("gone").to_string_lossy(), "x.txt", "inline"),
            Err(MemberError::RootMissing)
        );
    }
}
