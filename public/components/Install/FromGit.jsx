import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function FromGit({ onPreview, onInstall }) {
  const [repoUrl, setRepoUrl] = useState("");
  const [refInput, setRefInput] = useState("");
  const [targets, setTargets] = useState([]);

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M9 16V6a3 3 0 0 1 6 0v10a3 3 0 0 1-6 0Zm9-5h-2.5a2.5 2.5 0 0 0-2.5 2.5V14h5V8.5A2.5 2.5 0 0 0 16 6H19Z" />
          </svg>
          <h2 className="text-lg font-display font-bold text-ink">From Git</h2>
        </div>
        <p className="text-sm text-muted">Clone a repo and install the skills it ships.</p>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onInstall?.({ repoUrl, ref: refInput.trim(), targets });
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Repository
            </label>
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo.git"
              aria-label="Repository URL"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Branch or tag
            </label>
            <Input
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              placeholder="optional, defaults to main"
              aria-label="Branch or tag"
            />
          </div>
          <details className="relative">
            <summary className="cursor-pointer list-none flex items-center justify-between py-2 px-3 bg-surface-mute rounded-sm hover:bg-surface transition-colors">
              <span className="flex items-center gap-2 text-sm font-medium text-ink">
                <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
                <strong>Install targets</strong>
              </span>
              <span className="text-xs text-muted">Vault only</span>
            </summary>
            <div className="mt-3 space-y-2">
              {targets.length === 0 && (
                <p className="text-sm text-muted pl-1">No targets configured.</p>
              )}
              {targets.map((target) => (
                <label key={target.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={target.checked || false}
                    onChange={() => {}}
                    className="h-4 w-4 rounded border-line bg-surface text-green focus:ring-green/30"
                  />
                  <span>{target.label}</span>
                </label>
              ))}
            </div>
          </details>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => onPreview?.({ repoUrl, ref: refInput.trim(), targets })}
              variant="secondary"
              size="sm"
            >
              Preview
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!repoUrl.trim()}
            >
              Clone and install
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
