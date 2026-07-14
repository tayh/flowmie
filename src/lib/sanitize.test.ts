import { describe, expect, it } from "vitest";
import { stripAnsi, trimResponse } from "./sanitize";

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor movement and erase sequences", () => {
    expect(stripAnsi("a\x1b[2Kb\x1b[1;5Hc")).toBe("abc");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("\x1b]0;window title\x07hello")).toBe("hello");
  });

  it("removes OSC sequences terminated by ST", () => {
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link")).toBe("link");
  });

  it("normalizes CRLF and bare CR to LF", () => {
    expect(stripAnsi("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps tabs and newlines but drops other control chars", () => {
    expect(stripAnsi("a\tb\nc\x00\x07d")).toBe("a\tb\ncd");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("just text 123")).toBe("just text 123");
  });

  it("guarantees no escape byte survives", () => {
    const noisy = "\x1b[38;2;255;0;0mfoo\x1b[0m\x1b]0;t\x07\x1b(B bar";
    expect(stripAnsi(noisy)).not.toMatch(/\x1b/);
  });
});

describe("trimResponse", () => {
  it("strips ANSI and trims surrounding blank lines", () => {
    expect(trimResponse("\n\x1b[32m  hello world  \x1b[0m\n\n", "claude")).toBe(
      "hello world",
    );
  });

  it("drops a trailing shell prompt line", () => {
    const out = "total 8\ndrwxr-xr-x  file.txt\nuser@host:~/proj$ ";
    expect(trimResponse(out, "shell")).toBe("total 8\ndrwxr-xr-x  file.txt");
  });

  it("drops oh-my-zsh arrow prompt lines and the echoed command riding on them", () => {
    // Real zsh interaction that previously leaked prompt + command into B.
    const out = "➜  ~ echo hello from A\nhello from A\n➜  ~ ";
    expect(trimResponse(out, "shell")).toBe("hello from A");
  });

  it("strips prompt lines wherever they appear, not just the last", () => {
    const out = "➜  ~ ls\nfile.txt\n➜  ~ ";
    expect(trimResponse(out, "shell")).toBe("file.txt");
  });

  it("does not drop a prompt-looking line for non-shell agents", () => {
    const out = "here is the answer >";
    expect(trimResponse(out, "claude")).toBe("here is the answer >");
  });

  it("returns empty string for output that is only a prompt", () => {
    expect(trimResponse("user@host:~$ ", "shell")).toBe("");
  });

  it("returns empty string for an arrow-only prompt", () => {
    expect(trimResponse("➜  ~ ", "shell")).toBe("");
  });
});
