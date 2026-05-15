// public/components/Manage/BulkFloating.jsx — Floating bulk action panel.
// Visible when >1 skill selected. Wraps existing legacy DOM #bulkFloating.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { events } from "@/lib/state";

// Legacy handler refs — populated by app.js via window.__skillworksBulkHandlers
let bulkToggleHandler = null;
let bulkCopyHandler = null;
let bulkMoveHandler = null;
let bulkDeleteHandler = null;

export function registerBulkHandlers(handlers) {
  bulkToggleHandler = handlers.toggle;
  bulkCopyHandler = handlers.copy;
  bulkMoveHandler = handlers.move;
  bulkDeleteHandler = handlers["delete"];
}

// Get count from legacy state
function getSelectedCount() {
  const state = window.__skillworksState;
  return (state?.selectedSkillIds?.size || 0) > 1 ? state.selectedSkillIds.size : 0;
}

export function BulkFloating() {
  const containerRef = useRef(null);
  const [count, setCount] = useState(getSelectedCount());

  useEffect(() => {
    // Subscribe to selection changes via events
    const unsubscribe = events.on("selection:toggle", () => {
      setCount(getSelectedCount());
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Adopt legacy DOM node if it exists
    const existing = document.getElementById("bulkFloating");
    if (existing && !containerRef.current.contains(existing)) {
      containerRef.current.appendChild(existing);
    }
  }, [count]);

  useEffect(() => {
    // Wire up legacy button handlers
    const buttons = containerRef.current?.querySelectorAll("button[data-bulk-action]");
    buttons?.forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.bulkAction;
        if (action === "enable" || action === "disable" || action === "toggle") {
          bulkToggleHandler?.(action);
        } else if (action === "copy") {
          bulkCopyHandler?.();
        } else if (action === "move") {
          bulkMoveHandler?.();
        } else if (action === "delete") {
          bulkDeleteHandler?.();
        }
      });
    });

    // Wire up target select
    const targetSelect = containerRef.current?.querySelector("#bulkTargetSelect");
    targetSelect?.addEventListener("change", () => {
      const value = targetSelect.value;
      if (value) {
        events.emit("bulk:destination", { destinationId: value });
      }
    });

    // Wire up clear selection
    const clearBtn = containerRef.current?.querySelector("#clearSelectionButton");
    clearBtn?.addEventListener("click", () => {
      events.emit("bulk:clear");
    });

    return () => {
      buttons?.forEach((btn) => btn.removeEventListener("click", () => {}));
    };
  }, [count]);

  if (count < 2) return null;

  const hasDestination = containerRef.current?.querySelector("#bulkTargetSelect")?.value;

  return (
    <div
      ref={containerRef}
      id="bulkFloating"
      className={cn(
        "bulk-floating",
        count > 1 ? "is-visible" : "",
      )}
      hidden={count < 2}
    >
      <div className="bulk-floating-head">
        <span className="bulk-count">
          <strong>{count}</strong> selected
        </span>
        <Button variant="ghost" size="sm" id="clearSelectionButton">
          Clear
        </Button>
      </div>
      
      <div className="bulk-floating-body">
        {/* Target selection (shown when destination needed) */}
        {hasDestination && (
          <Select defaultValue={hasDestination} onValueChange={(v) => {
            if (v) events.emit("bulk:destination", { destinationId: v });
          }}>
            <SelectTrigger aria-label="Bulk destination">
              <SelectValue placeholder="Choose destination" />
            </SelectTrigger>
            <SelectContent>
              {(window.__skillworksState?.data?.targets || []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Action buttons */}
        <div className="bulk-controls">
          <div className="inline-field" style={{ flex: "1 1 140px" }}>
            <span>Action</span>
            <div className="bulk-button-row">
              <Button variant="secondary" data-bulk-action="enable" disabled={!hasDestination}>
                Enable
              </Button>
              <Button variant="secondary" data-bulk-action="disable" disabled={!hasDestination}>
                Disable
              </Button>
              <Button variant="secondary" data-bulk-action="toggle">
                Toggle
              </Button>
            </div>
          </div>

          <div className="inline-field grow">
            <span>Move / Copy</span>
            <div className="bulk-button-row">
              <Button variant="primary" data-bulk-action="copy">
                Copy to...
              </Button>
              <Button variant="danger" data-bulk-action="delete">
                Delete
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Re-export for convenience
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
