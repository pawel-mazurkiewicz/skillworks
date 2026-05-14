import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("composes classNames", () => {
    expect(cn("a", "b")).toBe("a b");
  });
  it("filters falsy", () => {
    expect(cn("a", false, null, undefined, "b")).toBe("a b");
  });
  it("merges Tailwind conflicts: later wins", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
