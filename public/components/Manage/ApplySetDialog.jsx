// public/components/Manage/ApplySetDialog.jsx — Dialog for applying a set.
// Uses the legacy DOM node approach (adopt via ref.appendChild) to preserve
// the existing escapeHtml/escapeAttr discipline and avoid dangerouslySetInnerHTML.

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ApplySetDialog({ open, onOpenChange, setRef }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Adopt the legacy DOM node if it exists and isn't already contained
    const existing = document.getElementById("apply-set-modal");
    if (existing && !containerRef.current.contains(existing)) {
      containerRef.current.appendChild(existing);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent ref={containerRef} className="max-w-2xl" aria-describedby="apply-set-description">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-4">
          <h2 id="apply-set-title" className="font-display text-lg font-bold text-ink">
            Apply Set
          </h2>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-full p-1 hover:bg-surface-mute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
            aria-label="Close dialog"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>

        {/* Body - adopts legacy DOM */}
        <div ref={setRef} id="apply-set-body" className="max-h-[60vh] overflow-y-auto py-4">
          {/* Content will be injected here via setRef.appendChild in app.js */}
        </div>

        {/* Footer */}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" id="apply-set-confirm">
            Apply Set
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
