import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider";

function Probe() {
  const { theme, setTheme } = useTheme();
  return (<><span data-testid="theme">{theme}</span><button onClick={() => setTheme("dark")}>dark</button></>);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider", () => {
  it("defaults to system", () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId("theme").textContent).toBe("system");
  });
  it("sets data-theme and persists on toggle", async () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await act(() => screen.getByText("dark").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("skillworks.theme")).toBe("dark");
  });
});
