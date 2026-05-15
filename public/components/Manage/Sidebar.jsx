import { useState, useEffect, useCallback } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/typography";

const SIDEBAR_OPEN_KEY = "skillworks.sidebarOpen";

/**
 * Sidebar — Collapsible filter + target panel.
 * Persists open state in localStorage (key: skillworks.sidebarOpen).
 */
export function Sidebar({ className, children }) {
  const stored = (() => {
    try { return localStorage.getItem(SIDEBAR_OPEN_KEY); } catch { return null; }
  })();
  const [open, setOpen] = useState(stored !== "false"); // default open

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_OPEN_KEY, String(open)); } catch {}
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <aside
      aria-label="Skill filters"
      className={cn(
        "flex flex-col gap-0",
        "border border-line bg-surface shadow-soft rounded-lg overflow-hidden",
        className,
      )}
    >
      <CollapsiblePrimitive.Root open={open} onOpenChange={setOpen}>
        <CollapsiblePrimitive.Trigger
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={cn(
            "flex items-center gap-2 w-full px-4 py-3 text-sm font-bold text-ink",
            "border-b border-line bg-surface-strong",
            "hover:bg-surface-mute transition-colors duration-150 ease-[var(--ease-paper)]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
          )}
        >
          <Filter className="h-4 w-4 text-muted" aria-hidden />
          <span>Filters &amp; targets</span>
          <span className="ml-auto text-muted transition-transform duration-200 ease-[var(--ease-paper)]">
            {open ? "▾" : "▸"}
          </span>
        </CollapsiblePrimitive.Trigger>

        <CollapsiblePrimitive.Content
          className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
        >
          <div className="flex flex-col gap-4 p-4">
            {children}
          </div>
        </CollapsiblePrimitive.Content>
      </CollapsiblePrimitive.Root>
    </aside>
  );
}
