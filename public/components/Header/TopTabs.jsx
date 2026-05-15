import { Wrench, Upload, Layers, Settings, ListX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTab } from "@/lib/state";

/**
 * TopTabs — 5-tab navigation for the workspace.
 * Uses plain buttons during migration (Radix Tabs added when tab panels migrate).
 * Emits `tab:change` events to bridge with legacy app.js.
 */
const TABS = [
  { value: "manage",    icon: Wrench,  label: "Manage",    hint: "Browse, toggle, organize" },
  { value: "install",   icon: Upload,  label: "Install",   hint: "Bring skills in" },
  { value: "sets",      icon: Layers,  label: "Sets",      hint: "Curated skill bundles" },
  { value: "configure", icon: Settings, label: "Configure", hint: "Projects, targets, vault" },
  { value: "cleanup",   icon: ListX,   label: "Cleanup",   hint: "Find & merge duplicates" },
];

export function TopTabs() {
  const { tab, switchTab } = useTab();

  return (
    <nav aria-label="Workspace sections" className="flex-1 min-w-0">
      <div role="tablist" aria-label="Workspace sections" className="grid grid-cols-5 gap-2 rounded-lg border border-line bg-surface p-2">
        {TABS.map(({ value, icon: Icon, label }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(value)}
              className={cn(
                "group flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded border border-transparent",
                "px-3 py-2 text-left transition-all duration-150 ease-[var(--ease-paper)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
                active
                  ? "border-ink bg-ink text-on-ink font-extrabold"
                  : "text-muted hover:border-line hover:text-ink",
              )}
            >
              <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
              <span className="text-[clamp(0.95rem,1vw,1.18rem)] tracking-[-0.005em]">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
