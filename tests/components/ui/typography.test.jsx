import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Eyebrow, DisplayTitle, MonoText } from "@/components/ui/typography";

describe("Typography", () => {
  it("Eyebrow uppercases", () => {
    render(<Eyebrow>Skill workspace</Eyebrow>);
    expect(screen.getByText("Skill workspace")).toHaveClass("uppercase");
  });
  it("DisplayTitle uses display font", () => {
    render(<DisplayTitle>Skillworks</DisplayTitle>);
    expect(screen.getByText("Skillworks")).toHaveClass("font-display");
  });
  it("MonoText uses mono font", () => {
    render(<MonoText>/abs/path</MonoText>);
    expect(screen.getByText("/abs/path")).toHaveClass("font-mono");
  });
});
