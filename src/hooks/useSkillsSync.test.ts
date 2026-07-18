import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./useSkillsSync";
import type { FlowmieEdge, FlowmieRFNode } from "../types/workspace";

const at = { position: { x: 0, y: 0 } };

const terminal: FlowmieRFNode = {
  id: "t1",
  type: "terminal",
  ...at,
  data: { agentType: "claude", cwd: "/repo", role: "reviewer", skillsEnabled: true, ptyId: "pty-1" },
};

const fileNode: FlowmieRFNode = {
  id: "f1",
  type: "file",
  ...at,
  data: { path: "/home/tayh/spec.md", label: "spec.md", isDirectory: false, missing: false },
};

const folderNode: FlowmieRFNode = {
  id: "f2",
  type: "file",
  ...at,
  data: { path: "/home/tayh/project", label: "project", isDirectory: true, missing: false },
};

const edge: FlowmieEdge = {
  id: "e1",
  type: "relay",
  source: "f1",
  target: "t1",
  data: { direction: "source-to-target", enabled: true },
};

describe("buildSnapshot", () => {
  it("carries file nodes to the bridge with their live path", () => {
    // Without this the bridge can't resolve `file:<id>` at all, and every file
    // node would silently be invisible to agents.
    const snapshot = buildSnapshot([terminal, fileNode], [edge]);
    expect(snapshot.files).toEqual([
      { id: "f1", path: "/home/tayh/spec.md", label: "spec.md", isDirectory: false, ignore: [] },
    ]);
  });

  it("marks folder nodes so the bridge lists them rather than reading bytes", () => {
    expect(buildSnapshot([folderNode], []).files[0].isDirectory).toBe(true);
  });

  it("carries a folder's extra ignore patterns to the bridge", () => {
    const configured = {
      ...folderNode,
      data: { ...folderNode.data, ignore: ["dist", "build"] },
    };
    expect(buildSnapshot([configured], []).files[0].ignore).toEqual(["dist", "build"]);
    // A file node with no config still sends an (empty) array, never undefined.
    expect(buildSnapshot([fileNode], []).files[0].ignore).toEqual([]);
  });

  it("sends the edge that grants access, since the edge is the permission", () => {
    const snapshot = buildSnapshot([terminal, fileNode], [edge]);
    expect(snapshot.edges).toEqual([
      { source: "f1", target: "t1", direction: "source-to-target", enabled: true },
    ]);
  });

  it("does not leak the runtime-only missing flag to the backend", () => {
    const snapshot = buildSnapshot([fileNode], []);
    expect(snapshot.files[0]).not.toHaveProperty("missing");
  });

  it("keeps file nodes out of the terminals list", () => {
    const snapshot = buildSnapshot([terminal, fileNode, folderNode], []);
    expect(snapshot.terminals.map((t) => t.id)).toEqual(["t1"]);
    expect(snapshot.files.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("reports no files for a canvas that has none", () => {
    expect(buildSnapshot([terminal], []).files).toEqual([]);
  });
});
