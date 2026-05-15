import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";

export function SetEditor({ set, onSave }) {
  const [localSet, setLocalSet] = useState(set);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    setLocalSet(set);
    setIsEditing(!!set && !set.id);
  }, [set]);

  if (!localSet) {
    return (
      <article className="sets-editor text-center py-12">
        <p className="muted">Select a set on the left, or create a new one.</p>
      </article>
    );
  }

  function handleSave() {
    onSave?.(localSet);
    setIsEditing(false);
  }

  function handleCancel() {
    setLocalSet(set);
    setIsEditing(false);
  }

  return (
    <article className="sets-editor">
      {isEditing ? (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-display font-bold text-ink">Edit Set</h3>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">Name</label>
              <Input
                value={localSet.name}
                onChange={(e) => setLocalSet({ ...localSet, name: e.target.value })}
                placeholder="Set name"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">Description</label>
              <Input
                value={localSet.description || ""}
                onChange={(e) => setLocalSet({ ...localSet, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
          </CardContent>
          <CardFooter className="flex justify-end gap-2">
            <Button onClick={handleCancel} variant="secondary" size="sm">Cancel</Button>
            <Button onClick={handleSave} variant="primary" size="sm">Save</Button>
          </CardFooter>
        </Card>
      ) : (
        <div className="sets-editor-readonly space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-display font-bold text-ink">{localSet.name}</h3>
            <span className={cn(
              "badge",
              localSet._scope === "global" ? "bg-plum/10 text-plum border-plum/30" : "bg-green/10 text-green border-green/30"
            )}>
              {localSet._scope}
            </span>
          </div>

          {localSet.description && <p className="text-sm text-ink">{localSet.description}</p>}

          {!localSet.entries || localSet.entries.length === 0 ? (
            <p className="muted">No entries yet.</p>
          ) : (
            <ul className="set-entry-readlist space-y-2">
              {localSet.entries.map((e, i) => (
                <li key={i} className="flex items-center justify-between text-sm bg-surface-mute p-3 rounded border border-line/60">
                  <strong className="text-ink">{e.skillName}</strong>
                  <span className="text-muted">→ {e.targetKey}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={() => setIsEditing(true)} variant="secondary" size="sm">Edit</Button>
            <Button onClick={() => onSave?.(localSet)} variant="primary" size="sm">Apply</Button>
          </div>
        </div>
      )}
    </article>
  );
}

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}
