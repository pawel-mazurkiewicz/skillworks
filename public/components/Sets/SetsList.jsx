import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SetsList({ sets, filter, selectedId, onFilterChange, onSelect, onEdit, onDelete, onApply, onNew, onSnapshot }) {
  const filtered = sets.filter(s => filter === "all" || s._scope === filter);

  return (
    <aside className="sets-list space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 bg-surface p-1 rounded-lg border border-line">
          {["all", "global", "project"].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFilterChange(f)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-all duration-150",
                filter === f
                  ? "bg-green text-on-green shadow-sm"
                  : "text-muted hover:bg-surface-mute hover:text-ink",
              )}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onNew} variant="secondary" size="sm">
            New set
          </Button>
          <Button onClick={onSnapshot} variant="secondary" size="sm">
            Snapshot current
          </Button>
        </div>
      </div>

      <ul className="sets-rows space-y-2 max-h-[60vh] overflow-y-auto pr-2 custom-scrollbar">
        {filtered.length === 0 ? (
          <li className="set-row-empty text-sm text-muted py-4">No sets yet.</li>
        ) : (
          filtered.map((s) => (
            <li
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "set-row group p-3 rounded-lg border transition-all duration-150 cursor-pointer",
                selectedId === s.id
                  ? "border-green bg-surface shadow-sm"
                  : "border-line hover:border-ink/40 hover:bg-surface-mute",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink truncate">{s.name}</div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className={cn(
                      "badge badge-sm",
                      s._scope === "global" ? "bg-plum/10 text-plum border-plum/30" : "bg-green/10 text-green border-green/30"
                    )}>
                      {s._scope}
                    </span>
                    <span className="text-xs text-muted">
                      {(s.entries || []).length} entr{((s.entries || []).length === 1) ? "y" : "ies"}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onApply(s.id); }}
                    className="btn-sm btn-secondary px-2 py-1 text-xs"
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onEdit(s); }}
                    className="btn-sm btn-secondary px-2 py-1 text-xs"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                    className="btn-sm btn-danger px-2 py-1 text-xs"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}
