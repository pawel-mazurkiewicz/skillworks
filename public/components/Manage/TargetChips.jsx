import { useState, useEffect } from "react";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { Eyebrow, MonoText } from "@/components/ui/typography";
import { events, emit } from "@/lib/state";

/**
 * TargetChips — Clickable target filter cards.
 * Reads targets from legacy state, renders clickable cards.
 * Emits filter:target-toggle on click.
 */
export function TargetChips({ className }) {
  const [targets, setTargets] = useState([]);
  const [activeId, setActiveId] = useState("all");

  useEffect(() => {
    // Read targets from legacy state on mount
    readTargets();

    // Stay in sync via snapshot events
    const handler = () => readTargets();
    events.on("state:snapshot", handler);
    return () => events.off("state:snapshot", handler);
  }, []);

  function readTargets() {
    try {
      const data = window.__skillworksState?.data;
      if (data) {
        setTargets(data.targets || []);
        const filterId = window.__skillworksState?.filterTargetId;
        setActiveId(filterId && filterId !== "all" ? filterId : "all");
      }
    } catch {}
  }

  const handleToggle = (targetId) => {
    const next = activeId === targetId ? "all" : targetId;
    setActiveId(next);

    // Update legacy state
    try {
      const s = window.__skillworksState;
      if (s) s.filterTargetId = next;
    } catch {}

    emit("filter:target-toggle", { targetId: next });
  };

  if (targets.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <Eyebrow as="h3">Targets</Eyebrow>
      <p className="text-[0.76rem] text-muted leading-snug">
        Click a target to filter the list to skills enabled there.
      </p>

      <div className={cn("flex flex-col gap-2", className)}>
        {targets.map((target) => {
          const isActive = activeId === target.id;
          const unmanaged = target.unmanaged?.length || 0;

          return (
            <button
              key={target.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => handleToggle(target.id)}
              title={target.path}
              className={cn(
                "text-left rounded-md border p-3 transition-all duration-150 ease-[var(--ease-paper)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
                isActive
                  ? "border-ink bg-ink text-on-ink shadow-soft"
                  : "border-line bg-surface-strong hover:border-line-strong",
              )}
            >
              <div className="flex items-center gap-2">
                <Folder className={cn("h-4 w-4 shrink-0", isActive ? "text-on-ink/70" : "text-muted")} aria-hidden />
                <strong className="text-sm truncate">{target.label}</strong>
              </div>
              <span className={cn(
                "block text-[0.76rem] mt-1",
                isActive ? "text-on-ink/70" : "text-muted",
              )}>
                {target.enabledSkillIds?.length || 0} linked{unmanaged > 0 ? `, ${unmanaged} unmanaged` : ""}
              </span>
              <MonoText className="block truncate mt-1 opacity-70">
                {target.path}
              </MonoText>
            </button>
          );
        })}
      </div>
    </div>
  );
}
