import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Card, CardHeader, CardContent, CardFooter } from "@/components/ui/card";

describe("Card", () => {
  it("composes header/content/footer", () => {
    render(<Card><CardHeader>H</CardHeader><CardContent>C</CardContent><CardFooter>F</CardFooter></Card>);
    expect(screen.getByText("H")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByText("F")).toBeInTheDocument();
  });
  it("marks accent variant via data attribute", () => {
    const { container } = render(<Card accent />);
    expect(container.querySelector('[data-accent="true"]')).toBeTruthy();
  });
});
