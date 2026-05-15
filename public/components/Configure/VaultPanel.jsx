import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function VaultPanel({ vaultPath, onBrowse, onSave }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M14 3v4a1 1 0 0 0 1 1h4" />
            <path fill="currentColor" d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" />
          </svg>
          <h3 className="text-base font-display font-bold text-ink">Vault</h3>
        </div>
        <p className="text-xs text-muted">Where Skillworks reads and writes skills. Save to update the workspace.</p>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-amber tracking-wide uppercase mb-1.5">
              Vault path
            </label>
            <Input
              id="vaultInput"
              value={vaultPath}
              onChange={(e) => {
                localStorage.setItem("asm.vaultPath", e.target.value);
              }}
              placeholder="~/.claude/skills"
              aria-label="Vault path"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={onBrowse} variant="secondary" size="sm">Browse</Button>
            <Button onClick={onSave} variant="primary" size="sm">Save</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
