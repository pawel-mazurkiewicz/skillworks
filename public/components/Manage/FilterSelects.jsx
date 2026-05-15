import { useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Eyebrow } from "@/components/ui/typography";
import { events, emit, useStateSnapshot } from "@/lib/state";

const AGENT_OPTIONS = []; // Populated from state.data.targets
const STATUS_OPTIONS = [
  { value: "all", label: "Any status" },
  { value: "enabled", label: "Enabled anywhere" },
  { value: "disabled", label: "Disabled everywhere" },
];
const TYPE_OPTIONS = []; // Populated dynamically
const SORT_OPTIONS = [
  { value: "name-asc", label: "Name A-Z" },
  { value: "name-desc", label: "Name Z-A" },
  { value: "author-asc", label: "Author A-Z" },
  { value: "author-desc", label: "Author Z-A" },
];

/**
 * FilterSelects — Agent / Status / Type / Sort dropdowns.
 * Reads current filter state from legacy window.__skillworksState on mount,
 * stays in sync via state:snapshot events. Emits filter:change on selection.
 */
export function FilterSelects({ className }) {
  const snapshot = useStateSnapshot();

  // Read filter values from legacy state or snapshot
  const agentFilter = snapshot?.filterTargetId || "all";
  const statusFilter = snapshot?.filterStatus || "all";
  const typeFilter = snapshot?.filterType || "all";
  const sortValue = snapshot?.sortBy || "name-asc";

  // Agent options from legacy state targets
  const agentOptions = (() => {
    try {
      const targets = window.__skillworksState?.data?.targets || [];
      return [
        { value: "all", label: "Any agent" },
        ...targets.map((t) => ({ value: t.id, label: t.label })),
      ];
    } catch {
      return [{ value: "all", label: "Any agent" }];
    }
  })();

  // Type options from legacy state skills
  const typeOptions = (() => {
    try {
      const skills = window.__skillworksState?.data?.skills || [];
      const types = new Set();
      for (const skill of skills) {
        const type = skill.type || (Array.isArray(skill.tags) && skill.tags[0]) || "General";
        types.add(type);
      }
      return [
        { value: "all", label: "Any type" },
        ...[...types].sort().map((t) => ({ value: t, label: t })),
      ];
    } catch {
      return [{ value: "all", label: "Any type" }];
    }
  })();

  const handleFilterChange = (filterKey, value) => {
    // Update legacy state
    try {
      const s = window.__skillworksState;
      if (s) {
        if (filterKey === "agent") s.filterTargetId = value;
        else if (filterKey === "status") s.filterStatus = value;
        else if (filterKey === "type") s.filterType = value;
        else if (filterKey === "sort") s.sortBy = value;
      }
    } catch {}
    emit("filter:change", { [filterKey]: value });
  };

  return (
    <div className="flex flex-col gap-3">
      <Eyebrow as="h3">Filters</Eyebrow>

      <div className="flex flex-col gap-2">
        <label className="text-[0.68rem] uppercase tracking-[0.12em] text-muted font-bold">
          Agent
        </label>
        <Select value={agentFilter} onValueChange={(v) => handleFilterChange("agent", v)}>
          <SelectTrigger aria-label="Filter by agent">
            <SelectValue placeholder="Any agent" />
          </SelectTrigger>
          <SelectContent>
            {agentOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[0.68rem] uppercase tracking-[0.12em] text-muted font-bold">
          Status
        </label>
        <Select value={statusFilter} onValueChange={(v) => handleFilterChange("status", v)}>
          <SelectTrigger aria-label="Filter by status">
            <SelectValue placeholder="Any status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[0.68rem] uppercase tracking-[0.12em] text-muted font-bold">
          Type
        </label>
        <Select value={typeFilter} onValueChange={(v) => handleFilterChange("type", v)}>
          <SelectTrigger aria-label="Filter by type">
            <SelectValue placeholder="Any type" />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-[0.68rem] uppercase tracking-[0.12em] text-muted font-bold">
          Sort
        </label>
        <Select value={sortValue} onValueChange={(v) => handleFilterChange("sort", v)}>
          <SelectTrigger aria-label="Sort order">
            <SelectValue placeholder="Name A-Z" />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
