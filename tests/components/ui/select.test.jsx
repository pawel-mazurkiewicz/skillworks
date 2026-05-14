import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

describe("Select", () => {
  it("renders trigger with placeholder", () => {
    render(
      <Select>
        <SelectTrigger aria-label="agent"><SelectValue placeholder="pick" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByLabelText("agent")).toBeInTheDocument();
  });
});
