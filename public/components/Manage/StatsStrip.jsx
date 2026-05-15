import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { events } from "@/lib/state";

/**
 * StatsStrip — 3-column vault / links / unmanaged summary grid.
 * Reads counts from legacy state on mount, stays in sync via state:snapshot events.
 */
export function StatsStrip({ className }) {
  const [counts, setCounts] = useState({ skillCount: "0", enabledCount: "0", unmanagedCount: "0" });

  useEffect(() => {
    readCounts();
    const handler = () => readCounts();
    events.on("state:snapshot", handler);
    return () => events.off("state:snapshot", handler);
  }, []);

  function readCounts() {
    try {
      const summary = window.__skillworksState?.data?.summary;
      if (summary) {
        setCounts({
          skillCount: String(summary.skillCount ?? "0"),
          enabledCount: String(summary.enabledCount ?? "0"),
          unmanagedCount: String(summary.unmanagedCount ?? "0"),
        });
      }
    } catch {}
  }

  const items = [
    { label: "Vault skills", value: counts.skillCount },
    { label: "Links", value: counts.enabledCount },
    { label: "Unmanaged", value: counts.unmanagedCount },
  ];

  return (
    <div
      role="list"
      aria-label="Workspace summary"
      className={cn(
        "grid grid-cols-3 gap-4 rounded-lg border border-line bg-surface-strong px-5 py-3 shadow-[0_1px_0_rgba(255,255,255,0.76)]",
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} role="listitem" className="flex flex-col items-center text-center">
          <span className="text-[0.62rem] uppercase tracking-[0.14em] text-muted font-bold">
            {item.label}
          </span>
          <span className="font-display font-[760] text-2xl leading-tight text-ink">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}
