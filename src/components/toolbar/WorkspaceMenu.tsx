import { useState } from "react";
import { useWorkspace } from "../../hooks/useWorkspace";
import type { WorkspaceSummary } from "../../types/workspace";
import "./WorkspaceMenu.css";

export function WorkspaceMenu() {
  const saveWorkspace = useWorkspace((s) => s.saveWorkspace);
  const loadWorkspace = useWorkspace((s) => s.loadWorkspace);
  const listWorkspaces = useWorkspace((s) => s.listWorkspaces);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summaries, setSummaries] = useState<WorkspaceSummary[]>([]);

  async function handleSave() {
    setSaving(true);
    try {
      await saveWorkspace();
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleLoad() {
    if (!open) {
      setSummaries(await listWorkspaces());
    }
    setOpen((o) => !o);
  }

  return (
    <div className="workspace-menu">
      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      <div className="workspace-menu__load">
        <button type="button" onClick={handleToggleLoad}>
          Load
        </button>
        {open && (
          <ul className="workspace-menu__list">
            {summaries.length === 0 && (
              <li className="workspace-menu__empty">No saved workspaces</li>
            )}
            {summaries.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  onClick={() => {
                    void loadWorkspace(summary.id);
                    setOpen(false);
                  }}
                >
                  {summary.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
