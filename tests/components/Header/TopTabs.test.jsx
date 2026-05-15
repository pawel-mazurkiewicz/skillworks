import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TopTabs } from "@/components/Header/TopTabs";
import * as stateModule from "@/lib/state";

describe("TopTabs", () => {
  beforeEach(() => {
    vi.spyOn(stateModule, "useTab").mockReturnValue({
      tab: "manage",
      switchTab: vi.fn(),
    });
  });

  it("renders all 5 tabs", () => {
    render(<TopTabs />);
    expect(screen.getByText("Manage")).toBeInTheDocument();
    expect(screen.getByText("Install")).toBeInTheDocument();
    expect(screen.getByText("Sets")).toBeInTheDocument();
    expect(screen.getByText("Configure")).toBeInTheDocument();
    expect(screen.getByText("Cleanup")).toBeInTheDocument();
  });

  it("emits tab:change on click", async () => {
    const switchTab = vi.fn();
    vi.spyOn(stateModule, "useTab").mockReturnValue({ tab: "manage", switchTab });
    render(<TopTabs />);
    await userEvent.click(screen.getByRole("tab", { name: "Install" }));
    expect(switchTab).toHaveBeenCalledWith("install");
  });

  it("marks active tab with aria-selected", () => {
    vi.spyOn(stateModule, "useTab").mockReturnValue({ tab: "sets", switchTab: vi.fn() });
    render(<TopTabs />);
    const setsTab = screen.getByRole("tab", { name: "Sets" });
    expect(setsTab).toHaveAttribute("aria-selected", "true");
  });

  it("has nav landmark with aria-label", () => {
    const { container } = render(<TopTabs />);
    expect(container.querySelector('nav[aria-label="Workspace sections"]')).toBeTruthy();
  });
});
