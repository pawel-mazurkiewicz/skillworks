import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  it("renders value and onChange", async () => {
    const onChange = vi.fn();
    render(<Input value="" onChange={onChange} aria-label="path" />);
    await userEvent.type(screen.getByLabelText("path"), "abc");
    expect(onChange).toHaveBeenCalledTimes(3);
  });
  it("supports leading icon slot", () => {
    render(<Input leading={<span data-testid="lead" />} aria-label="x" />);
    expect(screen.getByTestId("lead")).toBeInTheDocument();
  });
});
