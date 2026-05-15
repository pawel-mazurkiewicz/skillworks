import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { FilterSelects } from "./FilterSelects";
import { TargetChips } from "./TargetChips";
import { StatsStrip } from "./StatsStrip";
import { SkillList } from "./SkillList";
import { DetailPane } from "./DetailPane";

/**
 * ManageGrid — Composed layout for the Manage tab.
 *
 * Uses container queries (@container/manage) so the layout adapts to the actual
 * workspace width, not the viewport. This is the key Tauri-readiness change.
 *
 * Breakpoints:
 * - < 760px: single column, sidebar stacked on top
 * - 760px–1100px: two columns (sidebar + main), detail below
 * - 1100px–1500px: two columns (sidebar + main), detail beside
 * - 1500px+: three columns with wider panels
 */
export function ManageGrid({ className }) {
  return (
    <div className={cn("container", "w-full")}>
      {/* Inline container query styles */}
      <style>{`
        @container manage (max-width: 759px) {
          .manage-grid-inner {
            grid-template-columns: 1fr !important;
          }
          .manage-grid-detail {
            grid-column: 1 / -1 !important;
          }
        }
        @container manage (min-width: 760px) and (max-width: 1099px) {
          .manage-grid-inner {
            grid-template-columns: 1fr !important;
          }
          .manage-grid-detail {
            grid-column: 1 / -1 !important;
          }
        }
        @container manage (min-width: 1100px) and (max-width: 1499px) {
          .manage-grid-inner {
            grid-template-columns: minmax(0, 1fr) minmax(280px, 360px) !important;
          }
        }
        @container manage (min-width: 1500px) {
          .manage-grid-inner {
            grid-template-columns: minmax(0, 1fr) minmax(320px, 400px) !important;
          }
        }
      `}</style>

      <div className="@container/manage w-full">
        <div className="manage-grid-inner grid gap-4" style={{ gridTemplateColumns: "1fr" }}>
          {/* Sidebar */}
          <div className="manage-grid-sidebar">
            <Sidebar>
              <FilterSelects />
              <div className="h-px bg-line" />
              <TargetChips />
            </Sidebar>
          </div>

          {/* Main surface */}
          <section className="manage-grid-main flex flex-col gap-4 min-w-0">
            <StatsStrip />
            <SkillList />
          </section>

          {/* Detail pane */}
          <aside className="manage-grid-detail" aria-label="Skill details">
            <DetailPane className="sticky top-4" />
          </aside>
        </div>
      </div>
    </div>
  );
}

