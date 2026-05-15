import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { MonoText } from "@/components/ui/typography";
import { events, emit } from "@/lib/state";

/**
 * skillType — Derive type from skill object (matches app.js logic).
 */
function skillType(skill) {
  return skill.type || (Array.isArray(skill.tags) && skill.tags[0]) || "General";
}

/**
 * skillAuthor — Derive author from skill object (matches app.js logic).
 */
function skillAuthor(skill) {
  return skill.author || (String(skill.id || "").split("/").filter(Boolean)[0] || "Local");
}

/**
 * SkillRow — Single skill row in the list.
 * Handles checkbox toggle and selection click via event bus.
 */
export function SkillRow({ skill, isSelected, isChecked, targets }) {
  const activeTargets = targets.filter((t) => t.skillStatuses?.[skill.id]?.enabled);
  const assignmentText = activeTargets.length
    ? activeTargets.map((t) => t.shortLabel || t.label).join(", ")
    : "Disabled";

  const handleCheckboxChange = (checked) => {
    emit("selection:toggle", { skillId: skill.id, checked });
  };

  const handleClick = () => {
    emit("selection:select", skill.id);
  };

  return (
    <article
      data-select-skill={skill.id}
      className={cn(
        "grid min-h-[118px] border-b border-line bg-surface-strong transition-all duration-150 ease-[var(--ease-paper)]",
        "grid-cols-[44px_minmax(0,1fr)_minmax(92px,auto)] items-center",
        isSelected && "bg-surface-mute before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] before:bg-green",
      )}
    >
      {/* Checkbox */}
      <label className="flex cursor-pointer items-center justify-center" title={`Select ${skill.name}`}>
        <input
          type="checkbox"
          checked={isChecked}
          onChange={(e) => handleCheckboxChange(e.target.checked)}
          aria-label={`Select ${skill.name}`}
          data-select-row={skill.id}
          className="h-[18px] w-[18px]"
        />
      </label>

      {/* Main button */}
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "text-left min-w-0 border-0 bg-transparent p-0 text-ink",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:rounded-sm",
        )}
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <strong className="truncate text-base">{skill.name}</strong>
          <span className="text-[0.76rem] font-extrabold text-muted">{skillAuthor(skill)}</span>
        </span>

        <span className="text-muted text-[0.9rem] line-clamp-2 leading-relaxed">
          {skill.description || "No description"}
        </span>

        <span className="flex flex-wrap gap-[5px] mt-2">
          <span className={cn(
            "rounded-full bg-amber-soft px-[9px] py-[3px] text-[0.72rem] font-extrabold text-amber",
          )}>
            {skillType(skill)}
          </span>
          {skill.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-green-soft px-[9px] py-[3px] text-[0.72rem] font-extrabold text-green">
              {tag}
            </span>
          ))}
        </span>
      </button>

      {/* Assignment summary */}
      <span className={cn(
        "self-end text-right text-[0.76rem] font-extrabold max-w-[160px]",
        "overflow-hidden text-ellipsis whitespace-nowrap",
        activeTargets.length ? "text-muted" : "text-line-strong",
      )}>
        {assignmentText}
      </span>
    </article>
  );
}
