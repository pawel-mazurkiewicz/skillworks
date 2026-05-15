import { describe, it, expect, vi } from "vitest";
import { events, emit, on, off } from "@/lib/state";

describe("event bus", () => {
  it("emits and receives events", () => {
    const handler = vi.fn();
    on("test:event", handler);
    emit("test:event", { value: 42 });
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it("off removes listener", () => {
    const handler = vi.fn();
    on("test:off", handler);
    off("test:off", handler);
    emit("test:off");
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports multiple listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    on("test:multi", a);
    on("test:multi", b);
    emit("test:multi", "hello");
    expect(a).toHaveBeenCalledWith("hello");
    expect(b).toHaveBeenCalledWith("hello");
  });

  it("emit returns the events instance", () => {
    expect(emit("test:return")).toBe(events);
  });
});
