import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { NoteRFNode } from "../../types/workspace";
import "./NoteNode.css";

export function NoteNode({ id, data }: NodeProps<NoteRFNode>) {
  const removeNode = useWorkspace((s) => s.removeNode);
  const updateNoteContent = useWorkspace((s) => s.updateNoteContent);

  return (
    <div className="note-node">
      {/* Terminal -> note edges land here so agent output can flow in. */}
      <Handle type="target" position={Position.Left} />
      <div className="note-node__titlebar">
        <span className="note-node__label">note</span>
        <button type="button" onClick={() => removeNode(id)} title="Close">
          ×
        </button>
      </div>
      <textarea
        className="note-node__body nodrag nowheel"
        value={data.content}
        placeholder="Write a note, or connect a terminal to collect its output…"
        onChange={(e) => updateNoteContent(id, e.currentTarget.value)}
      />
    </div>
  );
}
