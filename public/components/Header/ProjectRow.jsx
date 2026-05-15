import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { emit } from "@/lib/state";

/**
 * ProjectRow — Project path input + Browse/Load/Refresh buttons.
 * Wires to legacy app.js via project:load|browse|refresh events.
 */
export function ProjectRow({ projectPath, onProjectChange }) {
  return (
    <form
      role="form"
      aria-label="Project context"
      className="flex items-center gap-2 w-full flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        emit("project:load", projectPath);
      }}
    >
      <label className="flex items-center gap-2.5 min-w-0 flex-[1_1_360px]">
        <span className="text-[0.65rem] tracking-[0.12em] uppercase text-muted/84">Project</span>
        <Input
          value={projectPath}
          onChange={(e) => onProjectChange(e.target.value)}
          placeholder="/path/to/project"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="flex gap-1.5 flex-wrap">
        <Button variant="secondary" type="button" onClick={() => emit("project:browse")}>
          Browse
        </Button>
        <Button variant="primary" type="submit">
          Load
        </Button>
        <Button variant="ghost" type="button" onClick={() => emit("project:refresh")}>
          Refresh
        </Button>
      </div>
    </form>
  );
}
