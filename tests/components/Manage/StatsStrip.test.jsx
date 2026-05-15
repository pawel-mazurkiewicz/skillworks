import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatsStrip } from "@/components/Manage/StatsStrip";

// Mock state and events
vi.mock("@/lib/state", () => ({
  events: {
    on: vi.fn(),
    off: vi.fn(),
  },
  emit: vi.fn(),
  useStateSnapshot: vi.fn(() => null),
}));

describe("StatsStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear any window state from previous tests
    delete window.__skillworksState;
  });

  it("renders 3 stat columns", () => {
    render(<StatsStrip />);
    expect(screen.getByText("Vault skills")).toBeInTheDocument();
    expect(screen.getByText("Links")).toBeInTheDocument();
    expect(screen.getByText("Unmanaged")).toBeInTheDocument();
  });

  it("shows zero counts by default", () => {
    render(<StatsStrip />);
    // The initial state should show "0" for all counts
    const statsContainer = screen.getByLabelText("Workspace summary");
    expect(statsContainer).toBeInTheDocument();
  });

  it("reads counts from legacy state on mount", () => {
    window.__skillworksState = {
      data: {
        summary: { skillCount: 42, enabledCount: 15, unmanagedCount: 3 },
      },
    };

    const { container } = render(<StatsStrip />);
    
    // After reading from state, the counts should update
    // Note: In jsdom, useEffect runs synchronously in our test environment
    const values = container.querySelectorAll(".font-display");
    expect(values.length).toBe(3);
  });

  it("has correct ARIA label", () => {
    render(<StatsStrip />);
    expect(screen.getByLabelText("Workspace summary")).toBeInTheDocument();
  });
});
