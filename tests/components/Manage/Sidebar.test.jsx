import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sidebar } from "@/components/Manage/Sidebar";

vi.mock("@/lib/state", () => ({
  events: { on: vi.fn(), off: vi.fn() },
  emit: vi.fn(),
  useStateSnapshot: vi.fn(() => null),
}));

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders with filter heading", () => {
    render(<Sidebar><div data-testid="content">Test</div></Sidebar>);
    expect(screen.getByText("Filters & targets")).toBeInTheDocument();
  });

  it("renders children inside collapsible content", () => {
    render(<Sidebar><div data-testid="content">Child content</div></Sidebar>);
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("toggles on button click", async () => {
    const user = userEvent.setup();
    render(<Sidebar><div data-testid="content">Child</div></Sidebar>);

    const trigger = screen.getByRole("button", { name: /filters & targets/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("persists open state to localStorage", async () => {
    const user = userEvent.setup();
    render(<Sidebar><div>Child</div></Sidebar>);

    const trigger = screen.getByRole("button", { name: /filters & targets/i });
    await user.click(trigger);

    expect(localStorage.getItem("skillworks.sidebarOpen")).toBe("false");
  });

  it("has correct ARIA label", () => {
    render(<Sidebar><div>Child</div></Sidebar>);
    expect(screen.getByLabelText("Skill filters")).toBeInTheDocument();
  });
});
