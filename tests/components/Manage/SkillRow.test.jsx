import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRow } from "@/components/Manage/SkillRow";
import * as stateModule from "@/lib/state";

const mockSkill = {
  id: "owner/skill-name",
  name: "Test Skill",
  description: "A test skill for testing",
  type: "Testing",
  tags: ["test"],
};

const mockTargets = [
  { id: "claude-global", label: "Claude global", shortLabel: "Claude", skillStatuses: { "owner/skill-name": { enabled: true } }, enabledSkillIds: [], unmanaged: [] },
];

describe("SkillRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders skill name and author", () => {
    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);
    expect(screen.getByText("Test Skill")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
  });

  it("renders skill description", () => {
    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);
    expect(screen.getByText("A test skill for testing")).toBeInTheDocument();
  });

  it("renders type tag", () => {
    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);
    expect(screen.getByText("Testing")).toBeInTheDocument();
  });

  it("renders assignment text for enabled skill", () => {
    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("renders 'Disabled' when no active targets", () => {
    const disabledTargets = [
      { id: "t1", label: "Target 1", skillStatuses: { "owner/skill-name": { enabled: false } }, enabledSkillIds: [], unmanaged: [] },
    ];
    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={disabledTargets} />);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("emits selection:toggle on checkbox change", async () => {
    const emitSpy = vi.spyOn(stateModule, "emit");
    const user = userEvent.setup();

    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);

    const checkbox = screen.getByLabelText("Select Test Skill");
    await user.click(checkbox);
    expect(emitSpy).toHaveBeenCalledWith("selection:toggle", { skillId: "owner/skill-name", checked: true });
  });

  it("emits selection:select on row click", async () => {
    const emitSpy = vi.spyOn(stateModule, "emit");
    const user = userEvent.setup();

    render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);

    const button = screen.getByRole("button");
    await user.click(button);
    expect(emitSpy).toHaveBeenCalledWith("selection:select", "owner/skill-name");
  });

  it("applies selected styling when isSelected is true", () => {
    const { container } = render(<SkillRow skill={mockSkill} isSelected={true} isChecked={false} targets={mockTargets} />);
    const article = container.querySelector("[data-select-skill]");
    expect(article).toHaveClass("bg-surface-mute");
  });

  it("falls back to 'General' type when no type or tags", () => {
    const skill = { id: "local/no-type", name: "No Type", description: "", tags: [] };
    render(<SkillRow skill={skill} isSelected={false} isChecked={false} targets={[]} />);
    expect(screen.getByText("General")).toBeInTheDocument();
  });

  it("renders 'No description' when description is empty", () => {
    const skill = { ...mockSkill, description: "" };
    render(<SkillRow skill={skill} isSelected={false} isChecked={false} targets={mockTargets} />);
    expect(screen.getByText("No description")).toBeInTheDocument();
  });

  it("has correct data-select-skill attribute", () => {
    const { container } = render(<SkillRow skill={mockSkill} isSelected={false} isChecked={false} targets={mockTargets} />);
    const article = container.querySelector("[data-select-skill]");
    expect(article).toHaveAttribute("data-select-skill", "owner/skill-name");
  });
});
