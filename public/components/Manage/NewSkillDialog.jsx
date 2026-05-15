// public/components/Manage/NewSkillDialog.jsx — Dialog wrapper for creating new skills.
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { mountCreateSkillEditor, unmountAllSkillEditors, CreateSkillEditor } from "../skill-editor.jsx";
import { events } from "@/lib/state";

export function NewSkillDialog({ open, onOpenChange }) {
  const [editorRef, setEditorRef] = useState(null);

  // Clean up editor when dialog closes
  useEffect(() => {
    if (!open && editorRef) {
      unmountAllSkillEditors();
      setEditorRef(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby="new-skill-description">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line pb-4">
          <h2 id="new-skill-title" className="font-display text-lg font-bold text-ink">
            New Skill
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

        {/* Body - mounts CreateSkillEditor */}
        <div ref={setEditorRef} className="max-h-[70vh] overflow-y-auto py-4">
          {editorRef && (
            <CreateSkillEditorWrapper onOpenChange={onOpenChange} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Wrapper component that provides the CreateSkillEditor with necessary props
function CreateSkillEditorWrapper({ onOpenChange }) {
  const handleCreate = async ({ name, content }) => {
    // Emit event for app.js to handle
    events.emit("create-skill:submit", { name, content });
    onOpenChange(false);
  };

  return (
    <CreateSkillEditor 
      onCreate={handleCreate}
      onCancel={() => onOpenChange(false)}
      onToast={(msg) => console.log(msg)} // Will be wired by app.js
    />
  );
}
