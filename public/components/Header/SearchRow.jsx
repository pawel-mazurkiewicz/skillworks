import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { emit } from "@/lib/state";

/**
 * SearchRow — Skill search input + "New skill" button.
 * Rendered only on the Manage tab (controlled by parent).
 * Wires to legacy app.js via search:input and create-skill:open events.
 */
export function SearchRow({ searchValue, onSearchChange }) {
  return (
    <div aria-label="Skill search" className="flex items-center gap-2.5 w-full">
      <Input
        leading={<Search className="h-4 w-4" />}
        value={searchValue}
        onChange={(e) => {
          onSearchChange(e.target.value);
          emit("search:input", e.target.value);
        }}
        placeholder="Search skills, tags, descriptions"
        autoComplete="off"
      />
      <div className="flex gap-1.5">
        <Button variant="primary" type="button" onClick={() => emit("create-skill:open")}>
          New skill
        </Button>
      </div>
    </div>
  );
}
