import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { ProjectRow } from "@/components/Header/ProjectRow";
import * as stateModule from "@/lib/state";

describe("ProjectRow", () => {
  beforeEach(() => {
    vi.spyOn(stateModule, "emit").mockReturnValue({ emit: () => {} });
  });

  it("renders input and buttons", () => {
    render(<ProjectRow projectPath="" onProjectChange={() => {}} />);
    expect(screen.getByPlaceholderText("/path/to/project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("emits project:browse on Browse click", async () => {
    render(<ProjectRow projectPath="" onProjectChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(stateModule.emit).toHaveBeenCalledWith("project:browse");
  });

  it("emits project:load on Load button click", async () => {
    const onChange = vi.fn();
    render(<ProjectRow projectPath="/test" onProjectChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(stateModule.emit).toHaveBeenCalledWith("project:load", "/test");
  });

  it("emits project:refresh on Refresh click", async () => {
    render(<ProjectRow projectPath="" onProjectChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(stateModule.emit).toHaveBeenCalledWith("project:refresh");
  });

  it("calls onProjectChange on input", async () => {
    const onChange = vi.fn();
    render(<ProjectRow projectPath="" onProjectChange={onChange} />);
    const input = screen.getByPlaceholderText("/path/to/project");
    await userEvent.type(input, "abc");
    expect(onChange).toHaveBeenCalled();
  });
});
