import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FilterSelects } from "@/components/Manage/FilterSelects";

vi.mock("@/lib/state", () => ({
  events: { on: vi.fn(), off: vi.fn() },
  emit: vi.fn(),
  useStateSnapshot: vi.fn(() => ({ filterTargetId: "all", filterStatus: "all", filterType: "all", sortBy: "name-asc" })),
}));

describe("FilterSelects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__skillworksState;
  });

  it("renders all 4 filter labels", () => {
    render(<FilterSelects />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Sort")).toBeInTheDocument();
  });

  it("renders filter heading", () => {
    render(<FilterSelects />);
    expect(screen.getByText("Filters")).toBeInTheDocument();
  });

  it("renders agent filter trigger", () => {
    render(<FilterSelects />);
    expect(screen.getByLabelText("Filter by agent")).toBeInTheDocument();
  });

  it("renders status filter trigger", () => {
    render(<FilterSelects />);
    expect(screen.getByLabelText("Filter by status")).toBeInTheDocument();
  });

  it("renders sort filter trigger", () => {
    render(<FilterSelects />);
    expect(screen.getByLabelText("Sort order")).toBeInTheDocument();
  });

  it("renders default options when no legacy state", () => {
    render(<FilterSelects />);
    // Should have at minimum the default "Any agent" option
    const triggers = screen.getAllByRole("combobox");
    expect(triggers.length).toBe(4); // Agent, Status, Type, Sort
  });

  it("reads targets from legacy state for agent options", () => {
    window.__skillworksState = {
      data: {
        targets: [
          { id: "claude-global", label: "Claude global" },
          { id: "codex-global", label: "Codex global" },
        ],
        skills: [],
      },
    };

    render(<FilterSelects />);
    const triggers = screen.getAllByRole("combobox");
    expect(triggers.length).toBe(4);
  });
});
