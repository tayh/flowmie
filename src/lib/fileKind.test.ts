import { describe, expect, it } from "vitest";
import { basename, dirname, kindForMime, kindForPath, mimeForPath } from "./fileKind";

describe("basename", () => {
  it("takes the last segment of a posix path", () => {
    expect(basename("/home/tayh/spec.md")).toBe("spec.md");
  });

  it("handles windows separators", () => {
    expect(basename("C:\\Users\\tayh\\spec.md")).toBe("spec.md");
  });

  it("ignores a trailing slash on a directory", () => {
    expect(basename("/home/tayh/project/")).toBe("project");
  });
});

describe("dirname", () => {
  it("returns the parent directory", () => {
    expect(dirname("/home/tayh/spec.md")).toBe("/home/tayh");
  });

  it("returns empty for a bare name", () => {
    expect(dirname("spec.md")).toBe("");
  });
});

describe("mimeForPath", () => {
  it("maps code extensions to text so agents can read them inline", () => {
    expect(mimeForPath("/src/main.rs")).toBe("text/rust");
    expect(mimeForPath("/src/App.tsx")).toBe("text/typescript");
  });

  it("is case-insensitive", () => {
    expect(mimeForPath("/tmp/SHOT.PNG")).toBe("image/png");
  });

  it("treats dotfiles as text", () => {
    expect(mimeForPath("/repo/.gitignore")).toBe("text/plain");
  });

  it("treats known extensionless names as text", () => {
    expect(mimeForPath("/repo/Dockerfile")).toBe("text/plain");
  });

  it("falls back to octet-stream for unknown types", () => {
    expect(mimeForPath("/tmp/thing.xyz")).toBe("application/octet-stream");
  });

  it("uses the last extension of a multi-dot name", () => {
    expect(mimeForPath("/tmp/archive.tar.gz")).toBe("application/octet-stream");
    expect(mimeForPath("/tmp/notes.backup.md")).toBe("text/markdown");
  });
});

describe("kindForMime", () => {
  it("classifies images", () => {
    expect(kindForMime("image/png")).toBe("image");
  });

  it("classifies text and json as text", () => {
    expect(kindForMime("text/markdown")).toBe("text");
    expect(kindForMime("application/json")).toBe("text");
  });

  it("classifies anything else as a file", () => {
    expect(kindForMime("application/pdf")).toBe("file");
    expect(kindForMime("application/octet-stream")).toBe("file");
  });
});

describe("kindForPath", () => {
  it("reports a directory as a file kind regardless of its name", () => {
    // A folder called `notes.md` must not be classified as text.
    expect(kindForPath("/home/tayh/notes.md", true)).toBe("file");
  });

  it("classifies a regular file by its extension", () => {
    expect(kindForPath("/home/tayh/notes.md", false)).toBe("text");
  });
});
