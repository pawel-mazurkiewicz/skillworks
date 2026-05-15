import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import { SkillRow } from "./SkillRow";
import { events, useStateSnapshot } from "@/lib/state";

/**
 * filteredSkills — Re-derive the same filter + sort logic as app.js.
 */
function getFilteredSkills() {
  try {
    const s = window.__skillworksState;
    if (!s?.data) return { skills: [], summary: "All skills" };

    const query = (s.search || "").trim().toLowerCase();
    const { skills, targets } = s.data;

    // Re-use app.js helper functions
    const skillTypeFn = (skill) => skill.type || (Array.isArray(skill.tags) && skill.tags[0]) || "General";
    const skillAuthorFn = (skill) => skill.author || (String(skill.id || "").split("/").filter(Boolean)[0] || "Local");

    const filtered = skills.filter((skill) => {
      const type = skillTypeFn(skill);
      const enabledTargets = targets.filter((t) => t.skillStatuses?.[skill.id]?.enabled);
      const matchesTarget = s.filterTargetId === "all" || enabledTargets.some((t) => t.id === s.filterTargetId);
      const matchesStatus = s.filterStatus === "all"
        || (s.filterStatus === "enabled" && enabledTargets.length > 0)
        || (s.filterStatus === "disabled" && enabledTargets.length === 0);
      const matchesType = s.filterType === "all" || type === s.filterType;
      const haystack = `${skill.name} ${skill.description} ${skill.tags.join(" ")} ${skill.id} ${skillAuthorFn(skill)} ${type}`.toLowerCase();
      return matchesType && matchesTarget && matchesStatus && (!query || haystack.includes(query));
    });

    // Sort
    filtered.sort((a, b) => {
      if (s.sortBy === "name-desc") return b.name.localeCompare(a.name);
      if (s.sortBy === "author-asc") return skillAuthorFn(a).localeCompare(skillAuthorFn(b)) || a.name.localeCompare(b.name);
      if (s.sortBy === "author-desc") return skillAuthorFn(b).localeCompare(skillAuthorFn(a)) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

    // Filter summary
    const parts = [];
    if (s.filterTargetId !== "all") {
      const target = targets.find((t) => t.id === s.filterTargetId);
      if (target) parts.push(target.label);
    }
    if (s.filterStatus !== "all") parts.push(s.filterStatus === "enabled" ? "enabled" : "disabled");
    if (s.filterType !== "all") parts.push(s.filterType);

    return {
      skills: filtered,
      targets,
      summary: parts.length ? parts.join(" / ") : "All skills",
    };
  } catch {
    return { skills: [], summary: "All skills" };
  }
}

/**
 * SkillList — Scrollable skill list with select-all checkbox and filter summary.
 * Replaces the imperative renderMatrix row rendering.
 */
export function SkillList({ className }) {
  const snapshot = useStateSnapshot();

  // Local state for re-rendering when filters change
  const [data, setData] = useState(() => getFilteredSkills());
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    // Sync selected IDs from legacy state
    try {
      setSelectedIds(new Set(window.__skillworksState?.selectedSkillIds || []));
    } catch {}

    // Listen for filter changes, selection changes, state snapshots
    const onFilter = () => {
      setData(getFilteredSkills());
      try { setSelectedIds(new Set(window.__skillworksState?.selectedSkillIds || [])); } catch {}
    };
    const onSnapshot = () => {
      setData(getFilteredSkills());
      try { setSelectedIds(new Set(window.__skillworksState?.selectedSkillIds || [])); } catch {}
    };

    events.on("filter:change", onFilter);
    events.on("selection:toggle", onSnapshot);
    events.on("state:snapshot", onSnapshot);

    return () => {
      events.off("filter:change", onFilter);
      events.off("selection:toggle", onSnapshot);
      events.off("state:snapshot", onSnapshot);
    };
  }, [snapshot]);

  const { skills, targets = [], summary } = data;

  const allSelected = skills.length > 0 && skills.every((s) => selectedIds.has(s.id));

  const handleSelectAll = (checked) => {
    try {
      const s = window.__skillworksState;
      if (s) {
        for (const skill of skills) {
          if (checked) s.selectedSkillIds.add(skill.id);
          else s.selectedSkillIds.delete(skill.id);
        }
      }
    } catch {}
    // Trigger re-render via event
    events.emit("state:snapshot");
  };

  if (skills.length === 0) {
    return (
      <div className={cn("flex flex-col", className)}>
        <div className="flex items-center justify-between border-b border-line bg-surface-mute px-3 py-2 text-[0.78rem] font-extrabold text-muted">
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" disabled aria-label="Select all skills" className="h-[18px] w-[18px]" />
            <span>0 skills</span>
          </label>
        </div>
        <div className="flex items-center justify-center py-12 text-muted">
          No skills match the current filter.
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-line bg-surface-strong shadow-soft", className)}>
      {/* Head */}
      <div className="flex items-center justify-between border-b border-line bg-surface-mute px-3 py-2 text-[0.78rem] font-extrabold text-muted">
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => handleSelectAll(e.target.checked)}
            aria-label="Select visible skills"
            className="h-[18px] w-[18px]"
          />
          <span>{skills.length} skill{skills.length === 1 ? "" : "s"}</span>
        </label>
        <span>{summary}</span>
      </div>

      {/* Body */}
      <ScrollArea.Root type="auto" className="max-h-[min(68vh,860px)]">
        <ScrollArea.Viewport className="h-full w-full">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              isSelected={window.__skillworksState?.selectedSkillId === skill.id}
              isChecked={selectedIds.has(skill.id)}
              targets={targets}
            />
          ))}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar orientation="vertical" className="flex w-2.5 touch-none select-none bg-transparent after:absolute after:inset-y-0 after:w-full after:bg-line/40 hover:after:bg-line" />
        <ScrollArea.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none select-none bg-transparent after:absolute after:inset-x-0 after:h-full after:bg-line/40 hover:after:bg-line" />
        <ScrollArea.Corner className="bg-line/20" />
      </ScrollArea.Root>
    </div>
  );
}
