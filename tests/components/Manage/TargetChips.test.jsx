import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TargetChips } from "@/components/Manage/TargetChips";
import * as stateModule from "@/lib/state";

describe("TargetChips", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__skillworksState;
  });

  it("renders nothing when no targets", () => {
    window.__skillworksState = { data: { targets: [], skills: [] } };

    const { container } = render(<TargetChips />);
    // When no targets, the component returns null (no target cards rendered)
    const chips = container.querySelectorAll('[role="radio"]');
    expect(chips.length).toBe(0);
  });

  it("renders target cards from legacy state", () => {
    window.__skillworksState = {
      data: {
        targets: [
          { id: "claude-global", label: "Claude global", path: "~/.claude/skills", enabledSkillIds: ["a", "b"], unmanaged: [] },
        ],
        skills: [],
      },
      filterTargetId: "all",
    };

    render(<TargetChips />);
    expect(screen.getByText("Claude global")).toBeInTheDocument();
  });

  it("renders target heading", () => {
    window.__skillworksState = {
      data: {
        targets: [
          { id: "t1", label: "Target 1", path: "/path/1", enabledSkillIds: [], unmanaged: [] },
        ],
        skills: [],
      },
    };

    render(<TargetChips />);
    expect(screen.getByText("Targets")).toBeInTheDocument();
  });

  it("renders link count and unmanaged status", () => {
    window.__skillworksState = {
      data: {
        targets: [
          { id: "t1", label: "Target 1", path: "/path/1", enabledSkillIds: ["a"], unmanaged: ["x", "y"] },
        ],
        skills: [],
      },
    };

    render(<TargetChips />);
    expect(screen.getByText(/1 linked, 2 unmanaged/)).toBeInTheDocument();
  });

  it("emits filter:target-toggle on click", async () => {
    const emitSpy = vi.spyOn(stateModule, "emit");

    window.__skillworksState = {
      data: {
        targets: [
          { id: "t1", label: "Target 1", path: "/path/1", enabledSkillIds: [], unmanaged: [] },
        ],
        skills: [],
      },
      filterTargetId: "all",
    };

    const user = userEvent.setup();
    render(<TargetChips />);

    await user.click(screen.getByRole("radio", { name: /target 1/i }));
    expect(emitSpy).toHaveBeenCalledWith("filter:target-toggle", { targetId: "t1" });
  });

  it("toggles active state on click", async () => {
    window.__skillworksState = {
      data: {
        targets: [
          { id: "t1", label: "Target 1", path: "/path/1", enabledSkillIds: [], unmanaged: [] },
        ],
        skills: [],
      },
      filterTargetId: "all",
    };

    const user = userEvent.setup();
    render(<TargetChips />);

    const chip = screen.getByRole("radio", { name: /target 1/i });
    expect(chip).toHaveAttribute("aria-checked", "false");

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-checked", "true");
  });
});
