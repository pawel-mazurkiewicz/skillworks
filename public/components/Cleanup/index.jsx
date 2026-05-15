import { useState, useEffect } from "react";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function CleanupTab() {
  const [dedupeState, setDedupeState] = useState({
    scanning: false,
    summary: "",
    groups: [],
    selectedKeepers: {},
  });

  useEffect(() => {
    if (window.__loadState && typeof window.__loadState === "function") {
      window.__loadState();
    }
  }, []);

  async function handleScan() {
    setDedupeState((prev) => ({ ...prev, scanning: true }));
    try {
      const response = await fetch("/api/dedupe/scan", { method: "POST" });
      if (response.ok) {
        const data = await response.json();
        setDedupeState({
          scanning: false,
          summary: data.summary || "No duplicates found.",
          groups: data.groups || [],
          selectedKeepers: {},
        });
      }
    } catch (e) {
      setDedupeState((prev) => ({ ...prev, scanning: false, summary: "Scan failed." }));
    }
  }

  function handleSelectKeeper(groupIndex, skillId) {
    setDedupeState((prev) => ({
      ...prev,
      selectedKeepers: { ...prev.selectedKeepers, [groupIndex]: skillId },
    }));
  }

  async function handleApply() {
    const keepers = Object.entries(dedupeState.selectedKeepers).map(([groupId, keeperId]) => ({
      groupId: parseInt(groupId),
      keeperId,
    }));
    
    try {
      await fetch("/api/dedupe/apply", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepers }),
      });
      setDedupeState((prev) => ({ ...prev, groups: [], selectedKeepers: {} }));
    } catch (e) {
      console.error("Failed to apply deduplication:", e);
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 className="text-lg font-display font-bold text-ink">Cleanup</h2>
          </div>
          <p className="text-sm text-muted">Find and merge duplicate skills in your vault.</p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <Button onClick={handleScan} variant="primary" size="sm" disabled={dedupeState.scanning}>
              {dedupeState.scanning ? "Scanning..." : "Scan for duplicates"}
            </Button>
          </div>

          <div className="mb-4">
            <p className="text-sm text-ink">{dedupeState.summary}</p>
          </div>

          {dedupeState.groups.length > 0 && (
            <div className="space-y-6 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
              {dedupeState.groups.map((group, idx) => (
                <div key={idx} className="border border-line rounded-lg p-4 bg-surface-mute/30">
                  <h3 className="text-sm font-medium text-ink mb-2">Duplicate group {idx + 1}</h3>
                  <ul className="space-y-2">
                    {group.skills.map((skill) => (
                      <li key={skill.id} className="flex items-center justify-between gap-2">
                        <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                          <input
                            type="radio"
                            name={`keeper-${idx}`}
                            value={skill.id}
                            checked={dedupeState.selectedKeepers[idx] === skill.id}
                            onChange={() => handleSelectKeeper(idx, skill.id)}
                            className="h-4 w-4 text-green focus:ring-green/30 border-line bg-surface"
                          />
                          <span className="text-sm text-ink truncate">{skill.name}</span>
                        </label>
                        <span className="text-xs text-muted whitespace-nowrap ml-2">
                          {skill.path}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        {dedupeState.groups.length > 0 && (
          <CardFooter className="flex justify-end gap-2 pt-4 border-t border-line">
            <Button onClick={handleApply} variant="primary" size="sm">Apply cleanup</Button>
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
