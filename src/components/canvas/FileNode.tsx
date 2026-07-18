import { useEffect, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { openPath } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { FileRFNode } from "../../types/workspace";
import { dirname, kindForPath } from "../../lib/fileKind";
import "./FileNode.css";

const KIND_ICON: Record<string, string> = {
  image: "🖼",
  text: "📄",
  file: "📎",
};

/**
 * A file or folder pinned to the canvas (F003). The node holds a *live* path —
 * reads hit the disk each time — and wiring it to a terminal is what lets that
 * agent read it. An unwired file node is inert by design: no agent can see it.
 */
export function FileNode({ id, data }: NodeProps<FileRFNode>) {
  const removeNode = useWorkspace((s) => s.removeNode);
  const refreshFileNode = useWorkspace((s) => s.refreshFileNode);
  const relocateFile = useWorkspace((s) => s.relocateFile);
  const renameFileNode = useWorkspace((s) => s.renameFileNode);
  const setFileIgnore = useWorkspace((s) => s.setFileIgnore);

  // Rename is label-only — a draft the input edits, committed on blur/Enter.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(data.label);

  // Re-check on mount so a file deleted while the app was closed (or since the
  // node was last drawn) shows its missing state rather than lying.
  useEffect(() => {
    void refreshFileNode(id);
  }, [id, refreshFileNode]);

  const icon = data.isDirectory ? "📁" : (KIND_ICON[kindForPath(data.path, false)] ?? "📎");
  const parent = dirname(data.path);

  async function handleLocate() {
    const picked = await open({
      directory: data.isDirectory,
      multiple: false,
      title: data.isDirectory ? "Locate folder" : "Locate file",
    });
    if (typeof picked === "string") await relocateFile(id, picked);
  }

  function startRename() {
    setDraft(data.label);
    setRenaming(true);
  }

  function commitRename() {
    renameFileNode(id, draft);
    setRenaming(false);
  }

  function commitIgnore(value: string) {
    setFileIgnore(id, value.split(",").map((p) => p.trim()).filter(Boolean));
  }

  return (
    <div className={`file-node${data.missing ? " file-node--missing" : ""}`}>
      {/* Either orientation authorizes the read (can_reach), so both ends take
          a wire — draw from the file to an agent or from an agent to the file. */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      <div className="file-node__titlebar">
        <span className="file-node__kind">{data.isDirectory ? "folder" : "file"}</span>
        <button type="button" onClick={() => removeNode(id)} title="Remove from canvas">
          ×
        </button>
      </div>

      <div
        className="file-node__body nodrag"
        title={data.missing ? `Not found:\n${data.path}` : data.path}
        onClick={() => {
          // Ignore the click that lands while renaming — the input owns it.
          if (!data.missing && !renaming) void openPath(data.path);
        }}
      >
        <span className="file-node__icon">{icon}</span>
        <span className="file-node__text">
          {renaming ? (
            <input
              className="file-node__rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenaming(false);
              }}
            />
          ) : (
            <span
              className="file-node__label"
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
            >
              {data.label}
            </span>
          )}
          {parent && <span className="file-node__dir">{parent}</span>}
        </span>
      </div>

      {data.isDirectory && !data.missing && (
        <label className="file-node__ignore nodrag" title="Comma-separated folder names to skip when this folder is listed. .git and node_modules are always skipped.">
          <span>ignore</span>
          <input
            defaultValue={(data.ignore ?? []).join(", ")}
            placeholder="dist, build"
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => commitIgnore(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
      )}

      {data.missing && (
        <div className="file-node__missing nodrag">
          <span>file not found</span>
          <button type="button" onClick={handleLocate}>
            Locate…
          </button>
        </div>
      )}
    </div>
  );
}
