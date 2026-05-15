import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function FromFolder({ onBrowse, onImport, onImportSuggested }) {
  const [sourcePath, setSourcePath] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path fill="currentColor" d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
            <path fill="currentColor" d="M12 11v6" />
            <path fill="currentColor" d="M9.5 13.5l2.5 -2.5l2.5 2.5" />
          </svg>
          <h2 className="text-lg font-display font-bold text-ink">From local folder</h2>
        </div>
        <p className="text-sm text-muted">Move skills from another location into the vault.</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Source preset
            </label>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              className={cn(
                "w-full h-9 rounded-sm border border-line bg-surface px-3 text-sm text-ink",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
                "focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30",
              )}
            >
              <option value="">Suggested paths</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Source path
            </label>
            <Input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="~/path/to/skills"
              aria-label="Source path"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={() => onBrowse?.()} variant="secondary" size="sm">
              Browse
            </Button>
            <Button
              onClick={() => onImport?.(sourcePath)}
              variant="primary"
              size="sm"
              disabled={!sourcePath.trim()}
            >
              Move to vault
            </Button>
            <Button
              onClick={() => onImportSuggested?.()}
              variant="secondary"
              size="sm"
            >
              Move suggested
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
