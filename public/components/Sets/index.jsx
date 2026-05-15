import { useState, useEffect } from "react";
import { SetsList } from "./SetsList";
import { SetEditor } from "./SetEditor";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SetsTab() {
  const [setsState, setSetsState] = useState({
    global: [],
    project: [],
    pinned: { ids: [], resolved: [], missing: [] },
    loaded: false,
    filter: "all",
    selectedId: null,
    draft: null,
  });
  const [projectPath, setProjectPath] = useState(() => localStorage.getItem("asm.projectPath") || "");

  useEffect(() => {
    loadSets();
  }, [projectPath]);

  async function loadSets() {
    try {
      const response = await fetch(`/api/sets?project=${encodeURIComponent(projectPath)}`);
      if (response.ok) {
        const data = await response.json();
        setSetsState((prev) => ({
          ...prev,
          global: Array.isArray(data.global) ? data.global : [],
          project: Array.isArray(data.project) ? data.project : [],
          pinned: data.pinned || { ids: [], resolved: [], missing: [] },
          loaded: true,
        }));
      }
    } catch (e) {
      console.error("Failed to load sets:", e);
    }
  }

  function updateSetsState(updater) {
    setSetsState((prev) => {
      const next = updater(prev);
      // Emit snapshot event for legacy app.js bridge
      if (window.__skillworksState && typeof window.__emit === "function") {
        window.__emit("sets:snapshot", next);
      }
      return next;
    });
  }

  function handleFilterChange(filter) {
    updateSetsState((prev) => ({ ...prev, filter }));
  }

  function handleNewSet() {
    updateSetsState((prev) => ({
      ...prev,
      draft: { id: null, name: "", description: "", scope: "project", entries: [] },
      selectedId: null,
    }));
  }

  function handleSnapshotCurrent() {
    // Trigger legacy snapshot flow
    if (window.__runAction && typeof window.__runAction === "function") {
      window.__runAction(async () => {
        await window.__loadSets();
        window.__renderSets();
      });
    }
  }

  function handleSetSelect(id) {
    updateSetsState((prev) => ({ ...prev, selectedId: id, draft: null }));
  }

  function handleEditSet(set) {
    updateSetsState((prev) => ({
      ...prev,
      draft: { ...set },
      selectedId: set.id,
    }));
  }

  function handleDeleteSet(id) {
    if (window.__runAction && typeof window.__runAction === "function") {
      window.__runAction(async () => {
        await fetch(`/api/sets/${encodeURIComponent(id)}?project=${encodeURIComponent(projectPath)}`, { method: "DELETE" });
        await loadSets();
      });
    }
  }

  function handleSaveSet(set) {
    if (window.__runAction && typeof window.__runAction === "function") {
      window.__runAction(async () => {
        const method = set.id ? "PUT" : "POST";
        const url = set.id 
          ? `/api/sets/${encodeURIComponent(set.id)}?project=${encodeURIComponent(projectPath)}`
          : `/api/sets?project=${encodeURIComponent(projectPath)}`;
        await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(set) });
        await loadSets();
      });
    }
  }

  function handleApplySet(id) {
    if (window.__runAction && typeof window.__runAction === "function") {
      window.__runAction(async () => {
        await fetch(`/api/sets/${encodeURIComponent(id)}/apply?project=${encodeURIComponent(projectPath)}`, { method: "POST" });
      });
    }
  }

  const allSets = setsState.global.concat(setsState.project).map(s => ({ ...s, _scope: s.scope }));
  const filteredSets = allSets.filter(s => setsState.filter === "all" || s._scope === setsState.filter);
  const selectedSet = setsState.draft || allSets.find(s => s.id === setsState.selectedId);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M14 12l6 -3l-8 -4l-8 4l6 3" />
              <path fill="currentColor" d="M10 12l-6 3l8 4l8 -4l-6 -3l-2 1l-2 -1" />
            </svg>
            <h2 className="text-lg font-display font-bold text-ink">Sets</h2>
          </div>
          <p className="text-sm text-muted">Curated bundles of skills and targets you can apply on demand.</p>
        </CardHeader>
        <CardContent>
          <div className="sets-layout grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
            <SetsList
              sets={allSets}
              filter={setsState.filter}
              selectedId={setsState.selectedId}
              onFilterChange={handleFilterChange}
              onSelect={handleSetSelect}
              onEdit={handleEditSet}
              onDelete={handleDeleteSet}
              onApply={handleApplySet}
              onNew={handleNewSet}
              onSnapshot={handleSnapshotCurrent}
            />
            <SetEditor
              set={selectedSet}
              onSave={handleSaveSet}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
