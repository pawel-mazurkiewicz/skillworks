import { useState, useEffect } from "react";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ProjectsPanel({ projectPath, onBrowse, onAdd, onScan }) {
  const [addPath, setAddPath] = useState("");
  const [scanFolder, setScanFolder] = useState("");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2" />
          </svg>
          <h3 className="text-base font-display font-bold text-ink">Projects</h3>
        </div>
        <p className="text-xs text-muted">Projects this vault links into.</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Add project path
            </label>
            <Input
              id="projectAddInput"
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              placeholder="/path/to/project"
              aria-label="Project path"
            />
            <div className="flex gap-2 mt-2">
              <Button onClick={() => onBrowse?.()} variant="secondary" size="sm">Browse</Button>
              <Button 
                onClick={() => addPath.trim() && onAdd?.(addPath.trim())} 
                variant="secondary" 
                size="sm"
                disabled={!addPath.trim()}
              >
                Add
              </Button>
            </div>
          </div>

          <div className="border-t border-line pt-4">
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Scan folder
            </label>
            <Input
              id="projectScanRootInput"
              value={scanFolder}
              onChange={(e) => setScanFolder(e.target.value)}
              placeholder="~/code or another workspace folder"
              aria-label="Scan folder path"
            />
            <div className="flex gap-2 mt-2 flex-wrap">
              <Button onClick={() => onBrowse?.()} variant="secondary" size="sm">Browse</Button>
              <Button 
                onClick={() => scanFolder.trim() && onScan?.(scanFolder.trim())} 
                variant="primary" 
                size="sm"
                disabled={!scanFolder.trim()}
              >
                Scan folder
              </Button>
              <Button onClick={() => onScan?.("~/workspaces")} variant="secondary" size="sm">Scan workspaces</Button>
              <Button onClick={() => {}} variant="danger" size="sm">Clear scanned</Button>
            </div>
          </div>

          <div className="border-t border-line pt-4">
            <h4 className="text-sm font-medium text-ink mb-2">Scanned projects</h4>
            <ul id="projectList" className="space-y-1 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {/* Legacy project list rendered here */}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
