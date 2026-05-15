import { cn } from "@/lib/utils";
import { BrandBlock } from "./BrandBlock";
import { TopTabs } from "./TopTabs";
import { ProjectRow } from "./ProjectRow";
import { SearchRow } from "./SearchRow";

/**
 * Header — Permanent header: BrandBlock + TopTabs + ProjectRow + SearchRow.
 *
 * Replaces the legacy `<div class="app-header">` template block.
 * SearchRow is rendered only on the Manage tab (matching legacy `data-only-tab="manage"`).
 */
export function Header({ activeTab, projectPath, onProjectChange, searchValue, onSearchChange }) {
  return (
    <header
      data-active-tab={activeTab}
      className={cn(
        "flex flex-col gap-0",
        "py-2.5 px-[clamp(16px,2vw,32px)]",
        "bg-[linear-gradient(180deg,rgba(255,253,246,.96),rgba(255,253,246,.88)_70%,rgba(255,253,246,.78))]",
        "dark:bg-[linear-gradient(180deg,rgba(28,36,32,.96),rgba(28,36,32,.88)_70%,rgba(28,36,32,.78))]",
        "backdrop-blur-[10px] border-b border-line shadow-[0_8px_18px_-16px_rgba(23,33,27,.32)]",
        "z-[30]",
      )}
    >
      <div className="flex flex-wrap items-center gap-[clamp(12px,1.6vw,24px)] pb-2.5">
        <BrandBlock />
        <TopTabs />
      </div>

      <ProjectRow projectPath={projectPath} onProjectChange={onProjectChange} />

      {activeTab === "manage" && (
        <div className="flex items-center gap-2.5 pt-2 border-t border-line/55">
          <SearchRow searchValue={searchValue} onSearchChange={onSearchChange} />
        </div>
      )}
    </header>
  );
}
