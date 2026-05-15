import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { SearchRow } from "@/components/Header/SearchRow";
import * as stateModule from "@/lib/state";

describe("SearchRow", () => {
  beforeEach(() => {
    vi.spyOn(stateModule, "emit").mockImplementation(() => stateModule.events);
  });

  it("renders search input and New skill button", () => {
    render(<SearchRow searchValue="" onSearchChange={() => {}} />);
    expect(screen.getByPlaceholderText(/search skills/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New skill" })).toBeInTheDocument();
  });

  it("emits search:input on text change", async () => {
    let currentSearch = "";
    render(<SearchRow searchValue={currentSearch} onSearchChange={(v) => { currentSearch = v; }} />);
    const input = screen.getByPlaceholderText(/search skills/i);
    await userEvent.type(input, "a");
    expect(stateModule.emit).toHaveBeenCalledWith("search:input", "a");
  });

  it("emits create-skill:open on New skill click", async () => {
    render(<SearchRow searchValue="" onSearchChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "New skill" }));
    expect(stateModule.emit).toHaveBeenCalledWith("create-skill:open");
  });

  it("calls onSearchChange on input", async () => {
    const onChange = vi.fn();
    render(<SearchRow searchValue="" onSearchChange={onChange} />);
    const input = screen.getByPlaceholderText(/search skills/i);
    await userEvent.type(input, "test");
    expect(onChange).toHaveBeenCalled();
  });
});
