import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BrandBlock } from "@/components/Header/BrandBlock";

describe("BrandBlock", () => {
  it("renders icon, eyebrow, and title", () => {
    render(<BrandBlock />);
    expect(screen.getByAltText("Skillworks icon")).toBeInTheDocument();
    expect(screen.getByText(/skill workspace/i)).toBeInTheDocument();
  });

  it("applies ink spine via data attribute", () => {
    const { container } = render(<BrandBlock />);
    expect(container.querySelector('[data-ink-spine="true"]')).toBeTruthy();
  });

  it("renders DisplayTitle with Fraunces font", () => {
    render(<BrandBlock />);
    const title = screen.getByText("Skillworks");
    expect(title).toHaveClass("font-display");
  });
});
