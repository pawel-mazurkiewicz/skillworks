import { useState, useEffect } from "react";
import { VaultPanel } from "./VaultPanel";
import { ProjectsPanel } from "./ProjectsPanel";
import { CustomTargetsPanel } from "./CustomTargetsPanel";
import { UnmanagedPanel } from "./UnmanagedPanel";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export function ConfigureTab() {
  const [projectPath, setProjectPath] = useState(() => localStorage.getItem("asm.projectPath") || "");
  const [vaultPath, setVaultPath] = useState(() => localStorage.getItem("asm.vaultPath") || "");

  useEffect(() => {
    if (window.__loadState && typeof window.__loadState === "function") {
      window.__loadState();
    }
  }, []);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <svg className="h-5 w-5 text-green" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M12.5 19h-7.5a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2h4l3 3h7a2 2 0 0 1 2 2v3" />
              <path fill="currentColor" d="M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
            </svg>
            <h2 className="text-lg font-display font-bold text-ink">Configure workspace</h2>
          </div>
          <p className="text-sm text-muted">Projects, targets, and vault settings.</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-6">
            <VaultPanel
              vaultPath={vaultPath}
              onBrowse={() => {
                if (window.__pickDirectoryInto && document.getElementById("vaultInput")) {
                  window.__pickDirectoryInto(document.getElementById("vaultInput"));
                }
              }}
              onSave={() => {
                const input = document.getElementById("vaultInput");
                if (input) localStorage.setItem("asm.vaultPath", input.value);
              }}
            />
            <div className="space-y-6">
              <ProjectsPanel
                projectPath={projectPath}
                onBrowse={() => {
                  if (window.__pickDirectoryInto && document.getElementById("projectAddInput")) {
                    window.__pickDirectoryInto(document.getElementById("projectAddInput"));
                  }
                }}
                onAdd={(path) => {
                  // Trigger legacy addProject flow
                  if (window.__runAction && typeof window.__runAction === "function") {
                    window.__runAction(async () => {
                      await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
                    });
                  }
                }}
                onScan={(folder) => {
                  if (window.__runAction && typeof window.__runAction === "function") {
                    window.__runAction(async () => {
                      await fetch("/api/projects/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) });
                    });
                  }
                }}
              />
              <CustomTargetsPanel
                onSave={(target) => {
                  if (window.__runAction && typeof window.__runAction === "function") {
                    window.__runAction(async () => {
                      await fetch("/api/targets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
                    });
                  }
                }}
              />
              <UnmanagedPanel />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
