import { useState } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function CustomTargetsPanel({ onSave }) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [harness, setHarness] = useState("Custom");
  const [scope, setScope] = useState("global");
  const [path, setPath] = useState("");

  function handleSubmit(e) {
    e.preventDefault();
    if (id.trim() && path.trim()) {
      onSave?.({ id: id.trim(), label: label.trim() || id.trim(), harness, scope, path: path.trim() });
      setId("");
      setLabel("");
      setPath("");
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M19.001 15.5v1.5" />
            <path fill="currentColor" d="M19.001 21v1.5" />
            <path fill="currentColor" d="M22.032 17.25l-1.299 .75" />
            <path fill="currentColor" d="M17.27 20l-1.3 .75" />
            <path fill="currentColor" d="M15.97 17.25l1.3 .75" />
          </svg>
          <h3 className="text-base font-display font-bold text-ink">Custom targets</h3>
        </div>
        <p className="text-xs text-muted">Extra destinations beyond the default Claude paths.</p>
      </CardHeader>
      <CardContent>
        <form id="customTargetForm" onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Identifier
            </label>
            <Input
              id="customTargetId"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. cursor-global"
              aria-label="Custom target identifier"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Label
            </label>
            <Input
              id="customTargetLabel"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Cursor global"
              aria-label="Custom target label"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Harness
            </label>
            <Input
              id="customTargetHarness"
              value={harness}
              onChange={(e) => setHarness(e.target.value)}
              placeholder="optional, default: Custom"
              aria-label="Custom target harness"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Scope
            </label>
            <select
              id="customTargetScope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full h-9 rounded-sm border border-line bg-surface px-3 text-sm text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30"
            >
              <option value="global">Global (absolute path)</option>
              <option value="project">Project (relative path)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Path
            </label>
            <Input
              id="customTargetPath"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/abs/path or .relative/path"
              aria-label="Custom target path"
            />
          </div>
          <Button type="submit" variant="primary" size="sm">Add custom target</Button>
        </form>
      </CardContent>
    </Card>
  );
}
