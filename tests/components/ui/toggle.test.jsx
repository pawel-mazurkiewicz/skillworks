import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Toggle } from "@/components/ui/toggle";

describe("Toggle", () => {
  it("toggles on click", async () => {
    const onCheckedChange = vi.fn();
    render(<Toggle aria-label="enable" onCheckedChange={onCheckedChange} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
  it("supports conflict variant", () => {
    render(<Toggle aria-label="t" variant="conflict" />);
    expect(screen.getByRole("switch")).toHaveAttribute("data-variant", "conflict");
  });
});
