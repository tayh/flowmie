import type { ResourceKind } from "../types/workspace";

/** The mime a directory is reported with, mirroring `file_stat` in Rust. */
export const DIRECTORY_MIME = "inode/directory";

/**
 * Extension → mime for the types a file node realistically carries (F003).
 * Deliberately small: this exists so a dropped `.ts` reads as text rather than
 * `application/octet-stream` (which would force `as: "path"` and deny an agent
 * an inline read). Anything unlisted falls back to octet-stream and is served
 * by path, which is the safe direction.
 */
const MIME_BY_EXT: Record<string, string> = {
  // Text / code — the common case for a file wired to a coding agent.
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonc: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  rs: "text/rust",
  py: "text/x-python",
  go: "text/x-go",
  rb: "text/x-ruby",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  sh: "text/x-shellscript",
  sql: "text/plain",
  xml: "text/xml",
  log: "text/plain",
  // Images — inline-able for vision-capable agents.
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  // Binary that must never be inlined.
  pdf: "application/pdf",
  zip: "application/zip",
};

/** Filenames with no extension that are still text (`Dockerfile`, `Makefile`). */
const TEXT_BASENAMES = new Set([
  "dockerfile",
  "makefile",
  "readme",
  "license",
  "changelog",
  "gemfile",
  "rakefile",
  "procfile",
]);

/** The basename of a path, handling both separators. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The directory portion of a path, or "" when there is none. */
export function dirname(path: string): string {
  const match = /^(.*)[\\/][^\\/]+[\\/]*$/.exec(path);
  return match?.[1] ?? "";
}

/** Best-effort mime for a path, by extension then by known basename. */
export function mimeForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  // Dotfiles (`.gitignore`) and bare names (`Dockerfile`) are text.
  if (!ext || name.startsWith(".")) {
    const bare = name.replace(/^\./, "");
    if (TEXT_BASENAMES.has(bare) || name.startsWith(".")) return "text/plain";
  }
  return "application/octet-stream";
}

/** The resource kind a mime maps to (F002 `ResourceKind`). */
export function kindForMime(mime: string): ResourceKind {
  if (mime.startsWith("image/")) return "image";
  // `text/*` plus the structured formats an agent reads as text.
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "file";
}

/** The kind to show/serve for a path; a directory is always kind `file`. */
export function kindForPath(path: string, isDirectory: boolean): ResourceKind {
  if (isDirectory) return "file";
  return kindForMime(mimeForPath(path));
}
