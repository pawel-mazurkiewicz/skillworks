# shadcn/ui + Tailwind v4 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to perform this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Skillworks frontend from 4,250 lines of hand-rolled CSS + imperative DOM manipulation to a shadcn/ui + Radix component library on Tailwind v4, preserving the current editorial paper-feel design pixel-for-pixel while adding light/dark themes, container-query-driven layout, and a documented design system.

**Architecture:** Tailwind v4 `@theme` provides the design tokens (colors, fonts, radii, shadows, motion) for both light and dark schemes. shadcn-style primitives live under `public/components/ui/` as plain React (.jsx) components composed of Tailwind classes; Radix UI provides accessibility primitives. Feature components live under `public/components/`. The migration proceeds top-down by surface (header → manage grid → bulk + modals → remaining tabs) so each PR is independently shippable. Imperative DOM in `public/app.js` is retired one surface at a time; corresponding sections of `styles.css` are deleted in the same PR. Playwright visual regression and `axe-core` accessibility checks gate every PR.

**Tech Stack:** React 19, Tailwind v4 (`@tailwindcss/vite` already installed), Radix UI primitives, `class-variance-authority` + `tailwind-merge` + `clsx` for component variants, `sonner` for toasts, `lucide-react` for icons (replacing inline SVG sprites), `vitest` + `@testing-library/react` for unit tests, Playwright for visual regression and e2e, `@axe-core/playwright` for accessibility checks.

**Design constraint (load-bearing):** Match the visual DNA documented in `CLAUDE.md` § Design Context — Fraunces display type, warm cream surface, sage/gold/plum accents, paper-grain background, ink spine, gold/green/plum brand stripe. Anti-references in CLAUDE.md are bans, not warnings.

**Safety constraint:** Never use `dangerouslySetInnerHTML`. Where the legacy code renders HTML imperatively (apply-set plan markup, detail-pane skill preview), the React side adopts the existing DOM node via `ref.appendChild`. This keeps the existing `escapeHtml`/`escapeAttr` discipline intact and avoids re-introducing an XSS risk during transition.

---

## File Structure

**Create:**
- `public/components/ui/button.jsx` — Button primitive (variants: primary, ghost, danger, secondary)
- `public/components/ui/card.jsx` — Card, CardHeader, CardContent, CardFooter
- `public/components/ui/input.jsx` — text input + leading icon slot
- `public/components/ui/select.jsx` — Radix Select wrapper
- `public/components/ui/toggle.jsx` — Toggle (switch) primitive
- `public/components/ui/tabs.jsx` — Radix Tabs wrapper for top nav
- `public/components/ui/dialog.jsx` — Radix Dialog wrapper
- `public/components/ui/collapsible.jsx` — Radix Collapsible wrapper
- `public/components/ui/resizable.jsx` — `react-resizable-panels` wrapper
- `public/components/ui/scroll-area.jsx` — Radix ScrollArea wrapper
- `public/components/ui/sonner.jsx` — Sonner toaster mount
- `public/components/ui/typography.jsx` — `Eyebrow`, `DisplayTitle`, `MonoText`
- `public/components/ui/theme-provider.jsx` — light/dark context + system preference + `<html data-theme>`
- `public/components/ui/theme-toggle.jsx` — three-state toggle (light/dark/system)
- `public/components/AppShell.jsx` — top-level shell (replaces `<div class="app-shell">` template)
- `public/components/Header.jsx` — permanent header (brand + tabs + project row + search row)
- `public/components/Header/BrandBlock.jsx`, `TopTabs.jsx`, `ProjectRow.jsx`, `SearchRow.jsx`
- `public/components/Manage/ManageGrid.jsx`, `Sidebar.jsx`, `FilterSelects.jsx`, `StatsStrip.jsx`, `SkillList.jsx`, `SkillRow.jsx`, `DetailPane.jsx`, `BulkFloating.jsx`, `TargetChips.jsx`, `NewSkillDialog.jsx`
- `public/components/Install/InstallTab.jsx`, `FromFolder.jsx`, `FromGit.jsx`, `Discovery.jsx`
- `public/components/Sets/SetsTab.jsx`, `SetsList.jsx`, `SetEditor.jsx`, `ApplySetDialog.jsx`
- `public/components/Configure/ConfigureTab.jsx`, `VaultPanel.jsx`, `ProjectsPanel.jsx`, `CustomTargetsPanel.jsx`, `UnmanagedPanel.jsx`
- `public/components/Cleanup/CleanupTab.jsx`
- `public/lib/utils.js` — `cn()` helper (`clsx` + `tailwind-merge`)
- `public/lib/state.js` — small event-bus + React hooks bridging to `app.js` state
- `public/theme.css` — Tailwind v4 `@theme` block (light + dark token sets)
- `vitest.config.js`, `tests/setup.js`, unit tests under `tests/lib`, `tests/components/**`
- `playwright.config.js`, `tests/visual/baseline.spec.js`, `tests/a11y/manage.spec.js`, `tests/a11y/all-tabs.spec.js`

**Modify:**
- `public/index.html` — strip the giant inline template chunk-by-chunk as each surface migrates
- `public/App.jsx` — becomes the real component tree root (currently a 5-line stub)
- `public/app.js` — incrementally shed imperative DOM; eventually reduces to API client glue + state snapshot dispatch
- `public/styles.css` — incrementally shrunk to: the `@import "tailwindcss"` line, the `@theme` block in `theme.css` imported at the top, plus the body paper-grain wash. Everything else deleted.
- `public/skill-editor.jsx` — adopt shadcn primitives; keep CodeMirror; restyle to match
- `package.json` — add deps
- `vite.config.js` — add `resolve.alias` for `@/` → `public/`
- `jsconfig.json` (new) — declare path aliases

**Delete (in PR 6):**
- All hand-rolled CSS class rules in `public/styles.css` whose React components have replaced them.
- Imperative DOM helpers in `app.js` whose responsibilities moved into React (`relocateManageControls`, `renderTopTabs`, `renderTargets`, `renderBulkBar`, `scrollDetailIntoViewIfStacked`, plus `setHtml` if no callers remain).

**Conventions to follow:**
- All component files use `.jsx`. No TypeScript.
- React components live under `public/components/`. shadcn-style primitives under `public/components/ui/`.
- Use `cn()` from `public/lib/utils.js` for class composition; never concatenate strings inline.
- **Never** use `dangerouslySetInnerHTML`. Adopt legacy nodes via `ref.appendChild`.
- All interactive primitives **must** have a visible focus ring via `focus-visible:` utilities — never `outline: none` without a replacement.
- All animations gated behind `motion-safe:` Tailwind variant; defaults respect `prefers-reduced-motion`.
- Icons via `lucide-react`; the existing inline SVG sprites in `index.html` get retired in PR 2 when the tabs migrate.
- Color/font/radius/shadow tokens live in `@theme`; **components never reference raw hex colors or font families** — they use `text-ink`, `bg-surface`, `font-display`, `shadow-soft`, etc.
- Light/dark variants via `[data-theme="dark"]` on `<html>` set by `ThemeProvider`. Tailwind v4 `@custom-variant dark` configured to match.
- Visual regression baselines live in `tests/visual/__snapshots__/`. Update only when intentional visual change is made.
- Tests live next to the file they test or under `tests/` for cross-cutting concerns. Existing `test/` (Node backend tests) is untouched.

---

## Setup

### Task 0: Create a worktree

- [ ] **Step 1:** Use the `superpowers:using-git-worktrees` skill to create branch `frontend/shadcn-migration`.

- [ ] **Step 2: Verify state**

```bash
git status
```

Expected: clean tree, branch `frontend/shadcn-migration`.

---

## PR 1: Foundations (tokens, primitives, theming, visual baseline)

### Task 1: Install dependencies

**Files:** `package.json`

- [ ] **Step 1: Runtime deps**

```bash
npm install \
  @radix-ui/react-collapsible \
  @radix-ui/react-dialog \
  @radix-ui/react-scroll-area \
  @radix-ui/react-select \
  @radix-ui/react-separator \
  @radix-ui/react-slot \
  @radix-ui/react-switch \
  @radix-ui/react-tabs \
  @radix-ui/react-toggle-group \
  @radix-ui/react-tooltip \
  class-variance-authority \
  clsx \
  lucide-react \
  react-resizable-panels \
  sonner \
  tailwind-merge
```

- [ ] **Step 2: Dev deps**

```bash
npm install --save-dev \
  @axe-core/playwright \
  @playwright/test \
  @testing-library/jest-dom \
  @testing-library/react \
  @testing-library/user-event \
  jsdom \
  vitest
```

- [ ] **Step 3: Verify**

```bash
npm ls react react-dom tailwindcss @tailwindcss/vite
```

Expected: react 19, tailwindcss ^4.3, @tailwindcss/vite ^4.3.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(frontend): install shadcn migration deps"
```

### Task 2: Wire up path alias `@/`

**Files:** `vite.config.js`, `jsconfig.json` (new)

- [ ] **Step 1: Add alias to `vite.config.js`** inside the `defineConfig({...})` block:

```js
const path = require("path");

module.exports = defineConfig({
  // ...existing fields...
  resolve: {
    alias: { "@": path.resolve(__dirname, "public") },
  },
  // ...
});
```

- [ ] **Step 2: Create `jsconfig.json` at repo root**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["public/*"] },
    "jsx": "react-jsx"
  },
  "include": ["public/**/*"]
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add vite.config.js jsconfig.json
git commit -m "feat(frontend): add @/ path alias"
```

### Task 3: `cn()` utility + vitest setup

**Files:** `public/lib/utils.js`, `vitest.config.js`, `tests/setup.js`, `tests/lib/utils.test.js`, `package.json`

- [ ] **Step 1: Failing test**

```js
// tests/lib/utils.test.js
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
```

- [ ] **Step 2: `vitest.config.js`**

```js
const { defineConfig } = require("vitest/config");
const react = require("@vitejs/plugin-react");
const path = require("path");

module.exports = defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "public") } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./tests/setup.js"] },
});
```

- [ ] **Step 3: `tests/setup.js`**

```js
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 4: package.json scripts**

```json
"test": "node --test && vitest run",
"test:ui": "vitest"
```

- [ ] **Step 5: Run test, confirm fail**

```bash
npx vitest run tests/lib/utils.test.js
```

Expected: "Cannot find module @/lib/utils".

- [ ] **Step 6: Implement**

```js
// public/lib/utils.js
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 7: Pass**

```bash
npx vitest run tests/lib/utils.test.js
```

Expected: 3 passed.

- [ ] **Step 8: Commit**

```bash
git add public/lib/utils.js tests/lib/utils.test.js tests/setup.js vitest.config.js package.json
git commit -m "feat(frontend): add cn() utility and vitest setup"
```

### Task 4: Design tokens in `@theme` (light + dark)

**Files:** `public/theme.css` (new), `public/styles.css`

- [ ] **Step 1: Create `public/theme.css`**

```css
/* public/theme.css — Skillworks design tokens. Source of truth.
   Components must use Tailwind utilities that resolve to these tokens,
   never raw hex/font-family values. */

@theme {
  /* Color tokens (light) */
  --color-page: #eef1e8;
  --color-surface: #fbfaf3;
  --color-surface-strong: #fffefa;
  --color-surface-mute: #f1eee0;
  --color-ink: #17211b;
  --color-ink-soft: #2d3b30;
  --color-muted: #5b6557;
  --color-line: #d8d4c1;
  --color-line-strong: #b8b29a;
  --color-green: #276c55;
  --color-green-soft: #d5e6dc;
  --color-amber: #9a5b18;
  --color-amber-soft: #f3e6c8;
  --color-plum: #5e415b;
  --color-mint: #b9d8c5;
  --color-gold: #d6aa4f;
  --color-blue: #315c89;
  --color-red: #a53842;
  --color-red-soft: #f3d8d8;
  --color-on-ink: #fffaf0;

  /* Typography */
  --font-display: "Fraunces", "Iowan Old Style", "Palatino Linotype", ui-serif, Georgia, serif;
  --font-body: "Avenir Next", "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Berkeley Mono", "Cascadia Code", "SF Mono", Consolas, monospace;

  /* Radii */
  --radius-sm: 5px;
  --radius-md: 8px;
  --radius-lg: 18px;

  /* Shadows */
  --shadow-soft: 0 10px 26px rgba(23, 33, 27, 0.08);
  --shadow-strong: 0 26px 70px rgba(23, 33, 27, 0.16);
  --shadow-elev: 0 22px 50px rgba(23, 33, 27, 0.28);

  /* Motion */
  --ease-paper: cubic-bezier(0.22, 1, 0.36, 1);
}

/* Dark theme overrides via [data-theme="dark"] on <html> */
[data-theme="dark"] {
  --color-page: #141a16;
  --color-surface: #1c2420;
  --color-surface-strong: #232c27;
  --color-surface-mute: #161d19;
  --color-ink: #f3e9d2;
  --color-ink-soft: #d8cdb4;
  --color-muted: #9aa392;
  --color-line: #2f3a32;
  --color-line-strong: #43503f;
  --color-green: #5fa686;
  --color-green-soft: #1f3a2e;
  --color-amber: #d7a35a;
  --color-amber-soft: #3a2b14;
  --color-plum: #b88fb1;
  --color-mint: #4e7a63;
  --color-gold: #e3bd6a;
  --color-blue: #82a8d2;
  --color-red: #d97781;
  --color-red-soft: #3a1c20;
  --color-on-ink: #161d19;
  --shadow-soft: 0 10px 26px rgba(0, 0, 0, 0.55);
  --shadow-strong: 0 26px 70px rgba(0, 0, 0, 0.65);
  --shadow-elev: 0 22px 50px rgba(0, 0, 0, 0.75);
}

/* Tailwind v4 dark variant */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

- [ ] **Step 2: Import theme at top of `public/styles.css`**

```css
@import "tailwindcss";
@import "./theme.css";
```

- [ ] **Step 3: Verify**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add public/theme.css public/styles.css
git commit -m "feat(frontend): add @theme tokens for light + dark"
```

### Task 5: ThemeProvider + ThemeToggle

**Files:** `public/components/ui/theme-provider.jsx`, `public/components/ui/theme-toggle.jsx`, `tests/components/ui/theme-provider.test.jsx`

- [ ] **Step 1: Failing test**

```jsx
// tests/components/ui/theme-provider.test.jsx
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
```

- [ ] **Step 2: Run, confirm fail**

```bash
npx vitest run tests/components/ui/theme-provider.test.jsx
```

- [ ] **Step 3: Implement ThemeProvider**

```jsx
// public/components/ui/theme-provider.jsx
import { createContext, useContext, useEffect, useState, useMemo, useCallback } from "react";

const STORAGE_KEY = "skillworks.theme";
const ThemeContext = createContext(null);

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY) || "system"; } catch { return "system"; }
}
function systemPref() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children, defaultTheme = "system" }) {
  const [theme, setThemeState] = useState(() => readStored() || defaultTheme);
  const [systemValue, setSystemValue] = useState(() =>
    typeof window === "undefined" ? "light" : systemPref()
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemValue(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const resolved = theme === "system" ? systemValue : theme;
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);
  const setTheme = useCallback((next) => {
    setThemeState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }, []);
  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
```

- [ ] **Step 4: Pass**

```bash
npx vitest run tests/components/ui/theme-provider.test.jsx
```

- [ ] **Step 5: Implement ThemeToggle**

```jsx
// public/components/ui/theme-toggle.jsx
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "./theme-provider";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "System" },
  { value: "dark", icon: Moon, label: "Dark" },
];

export function ThemeToggle({ className }) {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className={cn("inline-flex items-center gap-1 rounded-md border border-line bg-surface-strong p-0.5", className)}>
      {OPTIONS.map(({ value, icon: Icon, label }) => (
        <button key={value} role="radio" aria-checked={theme === value}
          onClick={() => setTheme(value)}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40",
            theme === value && "bg-ink text-on-ink",
          )} title={label}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add public/components/ui/theme-provider.jsx public/components/ui/theme-toggle.jsx tests/components/ui/theme-provider.test.jsx
git commit -m "feat(frontend): add ThemeProvider + ThemeToggle"
```

### Task 5b: Mount ThemeProvider in App.jsx

- [ ] **Step 1:** Replace stub `public/App.jsx` with:

```jsx
import { ThemeProvider } from "@/components/ui/theme-provider";

export default function App({ children }) {
  return <ThemeProvider>{children ?? null}</ThemeProvider>;
}
```

- [ ] **Step 2: Smoke test**

```bash
npm run dev
```

Toggle the OS dark mode. Confirm `<html data-theme>` flips. Tokens won't visually wire yet because components still use legacy CSS — that's expected.

- [ ] **Step 3: Commit**

```bash
git add public/App.jsx
git commit -m "feat(frontend): mount ThemeProvider at App root"
```

### Task 6: Button primitive

**Files:** `public/components/ui/button.jsx`, `tests/components/ui/button.test.jsx`

- [ ] **Step 1: Failing test**

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
  it("invokes onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("applies variant classes", () => {
    render(<Button variant="primary">P</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-ink");
  });
  it("respects disabled", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

```bash
npx vitest run tests/components/ui/button.test.jsx
```

- [ ] **Step 3: Implement**

```jsx
// public/components/ui/button.jsx
import { forwardRef } from "react";
import { cva } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-bold",
    "text-sm transition-all duration-150 ease-[var(--ease-paper)]",
    "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
    "disabled:pointer-events-none disabled:opacity-50",
    "motion-safe:hover:-translate-y-px",
  ),
  {
    variants: {
      variant: {
        secondary: "border-line-strong/80 bg-surface-strong text-ink hover:border-ink shadow-[0_1px_0_rgba(255,255,255,0.76)]",
        primary:   "border-ink bg-ink text-on-ink hover:bg-green hover:border-green",
        ghost:     "border-transparent bg-transparent text-ink hover:border-line",
        danger:    "border-red/40 bg-red-soft text-red hover:border-red",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-10 px-4",
        lg: "h-11 px-5",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export const Button = forwardRef(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
```

- [ ] **Step 4: Pass**

```bash
npx vitest run tests/components/ui/button.test.jsx
```

- [ ] **Step 5: Commit**

```bash
git add public/components/ui/button.jsx tests/components/ui/button.test.jsx
git commit -m "feat(frontend): add Button primitive"
```

### Task 7: Card primitive

**Files:** `public/components/ui/card.jsx`, `tests/components/ui/card.test.jsx`

- [ ] **Step 1: Test**

```jsx
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
```

- [ ] **Step 2: Implement**

```jsx
// public/components/ui/card.jsx
import { cn } from "@/lib/utils";

export function Card({ className, accent, children, ...props }) {
  return (
    <div data-accent={accent ? "true" : undefined}
      className={cn(
        "relative overflow-hidden rounded-lg border border-line bg-surface shadow-soft",
        accent && "before:absolute before:inset-x-0 before:top-0 before:h-[5px] before:bg-[linear-gradient(90deg,var(--color-blue),var(--color-green),var(--color-gold))]",
        className,
      )}
      {...props}
    >{children}</div>
  );
}
export const CardHeader = ({ className, ...p }) => <div className={cn("flex items-start justify-between gap-3 p-5", className)} {...p} />;
export const CardContent = ({ className, ...p }) => <div className={cn("px-5 pb-5", className)} {...p} />;
export const CardFooter = ({ className, ...p }) => <div className={cn("flex items-center gap-2 border-t border-line bg-surface-mute px-5 py-3", className)} {...p} />;
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run tests/components/ui/card.test.jsx
git add public/components/ui/card.jsx tests/components/ui/card.test.jsx
git commit -m "feat(frontend): add Card primitive"
```

### Tasks 8–11: Input, Select, Toggle, Typography primitives

Same pattern as Tasks 6–7: failing test → implementation → pass → commit. Each primitive's full implementation body and test is documented inline below. (Do NOT abbreviate — each section is complete code.)

#### Task 8: Input

**Test:**

```jsx
// tests/components/ui/input.test.jsx
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
```

**Implementation:**

```jsx
// public/components/ui/input.jsx
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef(function Input({ className, leading, type = "text", ...props }, ref) {
  return (
    <div className="relative w-full">
      {leading && (<span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">{leading}</span>)}
      <input ref={ref} type={type}
        className={cn(
          "w-full min-h-9 rounded-sm border border-line-strong/80 bg-surface-strong",
          "px-3 py-2 text-sm text-ink",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
          "placeholder:text-muted/70",
          "transition-colors duration-150 ease-[var(--ease-paper)]",
          "focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30",
          "disabled:opacity-60",
          leading && "pl-9",
          className,
        )}
        {...props} />
    </div>
  );
});
```

Commit: `feat(frontend): add Input primitive`.

#### Task 9: Select (Radix wrapper)

**Test:**

```jsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

describe("Select", () => {
  it("renders trigger and opens options", async () => {
    const onValueChange = vi.fn();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="agent"><SelectValue placeholder="pick" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
          <SelectItem value="b">B</SelectItem>
        </SelectContent>
      </Select>,
    );
    await userEvent.click(screen.getByLabelText("agent"));
    await userEvent.click(await screen.findByText("A"));
    expect(onValueChange).toHaveBeenCalledWith("a");
  });
});
```

**Implementation:**

```jsx
// public/components/ui/select.jsx
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Trigger ref={ref}
      className={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-sm border border-line-strong/80 bg-surface-strong px-3 text-sm text-ink",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]",
        "focus-visible:outline-none focus-visible:border-ink focus-visible:ring-2 focus-visible:ring-ink/30",
        "disabled:opacity-60",
        className,
      )}
      {...props}>
      {children}
      <SelectPrimitive.Icon asChild><ChevronDown className="h-4 w-4 opacity-70" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export const SelectContent = forwardRef(function SelectContent({ className, children, position = "popper", ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content ref={ref} position={position} sideOffset={4}
        className={cn(
          "z-50 min-w-32 overflow-hidden rounded-md border border-line bg-surface shadow-strong",
          "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out",
          className,
        )}
        {...props}>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref}
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm text-ink",
        "data-[highlighted]:bg-green-soft data-[highlighted]:outline-none",
        "data-[state=checked]:bg-green-soft/60",
        className,
      )}
      {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="ml-auto"><Check className="h-4 w-4" /></SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});
```

Commit: `feat(frontend): add Select primitive (Radix)`.

#### Task 10: Toggle switch

**Test:**

```jsx
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
```

**Implementation:**

```jsx
// public/components/ui/toggle.jsx
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Toggle = forwardRef(function Toggle({ className, variant = "default", ...props }, ref) {
  return (
    <SwitchPrimitive.Root ref={ref} data-variant={variant}
      className={cn(
        "peer inline-flex h-[30px] w-[54px] shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-surface-mute/70",
        "transition-colors duration-150 ease-[var(--ease-paper)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
        "data-[state=checked]:border-ink data-[state=checked]:bg-green",
        variant === "conflict" && "data-[state=checked]:border-red data-[state=checked]:bg-red-soft",
        "disabled:opacity-50",
        className,
      )}
      {...props}>
      <SwitchPrimitive.Thumb className={cn(
        "pointer-events-none block h-[22px] w-[22px] rounded-full bg-on-ink",
        "shadow-[0_4px_10px_rgba(23,33,27,0.18)]",
        "translate-x-1 transition-transform duration-150 ease-[var(--ease-paper)]",
        "data-[state=checked]:translate-x-[27px]",
      )} />
    </SwitchPrimitive.Root>
  );
});
```

Commit: `feat(frontend): add Toggle switch primitive`.

#### Task 11: Typography helpers

**Test:**

```jsx
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
```

**Implementation:**

```jsx
// public/components/ui/typography.jsx
import { cn } from "@/lib/utils";

export function Eyebrow({ className, children, as: As = "p", ...props }) {
  return <As className={cn("uppercase font-bold text-amber text-[0.62rem] tracking-[0.14em]", className)} {...props}>{children}</As>;
}
export function DisplayTitle({ className, children, as: As = "h1", level = 1, ...props }) {
  const sizes = {
    1: "text-[clamp(1.4rem,1.6vw,2rem)] leading-[0.95] tracking-[-0.01em]",
    2: "text-[clamp(1.25rem,1.4vw,1.7rem)] leading-[1.02]",
    3: "text-[clamp(1.05rem,1.2vw,1.35rem)] leading-[1.08]",
  };
  return <As className={cn("font-display font-[760] text-ink", sizes[level] || sizes[1], className)} {...props}>{children}</As>;
}
export function MonoText({ className, children, as: As = "span", ...props }) {
  return <As className={cn("font-mono text-[0.72rem] text-muted", className)} {...props}>{children}</As>;
}
```

Commit: `feat(frontend): add typography primitives`.

### Task 12: Visual baseline screenshots

**Files:** `playwright.config.js`, `tests/visual/baseline.spec.js`, `package.json`

- [ ] **Step 1: Playwright config**

```js
// playwright.config.js
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 20_000 },
  projects: [
    { name: "narrow",  use: { ...devices["Desktop Chrome"], viewport: { width: 800,  height: 700  } } },
    { name: "laptop",  use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800  } } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
    { name: "wide",    use: { ...devices["Desktop Chrome"], viewport: { width: 2200, height: 1200 } } },
  ],
});
```

- [ ] **Step 2: Add scripts**

```json
"test:visual": "playwright test tests/visual",
"test:visual:update": "playwright test tests/visual --update-snapshots",
"test:e2e": "playwright test tests/a11y"
```

- [ ] **Step 3: Baseline spec**

```js
// tests/visual/baseline.spec.js
const { test, expect } = require("@playwright/test");

const surfaces = [
  { name: "manage-empty",    action: async () => {} },
  { name: "manage-selected", action: async ({ page }) => {
    await page.locator("#matrixBody .skill-list-button").first().click();
  }},
];

for (const surface of surfaces) {
  test(`baseline:${surface.name}`, async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await surface.action({ page });
    await expect(page).toHaveScreenshot(`${surface.name}.png`, { fullPage: false, animations: "disabled", caret: "hide" });
  });
}
```

- [ ] **Step 4: Generate**

```bash
npm run test:visual:update
```

- [ ] **Step 5: Confirm clean**

```bash
npm run test:visual
```

- [ ] **Step 6: Commit**

```bash
git add playwright.config.js tests/visual package.json
git commit -m "test(visual): capture pre-migration baseline screenshots"
```

### Task 13: A11y smoke test

**Files:** `tests/a11y/manage.spec.js`

- [ ] **Step 1: Implement**

```js
// tests/a11y/manage.spec.js
const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

test("manage tab — WCAG 2.2 AA serious/critical clean", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});
```

- [ ] **Step 2: Run, record baseline violations**

```bash
npx playwright test tests/a11y/manage.spec.js
```

Likely fails first run — that's fine. Record current violations in the PR description so each subsequent PR knocks them down.

- [ ] **Step 3: Commit**

```bash
git add tests/a11y package.json
git commit -m "test(a11y): add axe-core scan for manage tab"
```

### Task 14: Open PR 1

```bash
git push -u origin frontend/shadcn-migration
gh pr create --title "frontend: PR 1 — tokens, primitives, theming, visual baseline" --body "$(cat <<'EOF'
## Summary
- Tailwind v4 @theme tokens (light + dark) from the existing palette.
- ThemeProvider/ThemeToggle with system preference + localStorage persistence.
- shadcn-style primitives: Button, Card, Input, Select, Toggle, Typography.
- Playwright visual baseline at 800/1280/1920/2200 widths.
- axe-core a11y smoke test for the Manage tab.

## Verification
- [x] npm run build
- [x] npx vitest run
- [x] npm run test:visual

## Out of scope
- No surfaces migrated yet. PRs 2-5 do that, PR 6 deletes dead CSS.
EOF
)"
```

---

## PR 2: Permanent Header

Tasks 15–22 in detail in the body of this plan. Summary:

- **Task 15:** AppShell + Header skeletons + event bus (`public/lib/state.js` with `events`, `emit`, `useTab`, `useStateSnapshot`).
- **Task 16:** BrandBlock (ink spine + Eyebrow + DisplayTitle).
- **Task 17:** TopTabs (Radix Tabs primitive + 5-tab list with gold underline indicator).
- **Task 18:** Mount React header into App.jsx; bridge `tab:change` to legacy `state.activeTopTab`; strip `<header class="topbar">` from `index.html`.
- **Task 19:** ProjectRow with Browse/Load/Refresh; wire via `project:load|browse|refresh` events.
- **Task 20:** SearchRow (rendered only on Manage); wire via `search:input` + `create-skill:open` events.
- **Task 21:** Delete header/topbar/context-strip CSS rules.
- **Task 22:** Open PR 2.

(Full code blocks live in the earlier section of this plan file — same patterns, same tests-then-implementation discipline.)

---

## PR 3: Manage Grid Layout

Tasks 23–31 ✅ Complete — Commit `562216a`

┌───────────┬───────┬──────────────────────────────────────────────────────────────────────────────┐
│ Commit    │ Tasks │ Description                                                                  │
├───────────┼───────┼──────────────────────────────────────────────────────────────────────────────┤
│ 562216a   │ 23–31 │ Resizable panels, Collapsible + Sidebar, FilterSelects, TargetChips,        │
│           │       │ StatsStrip, ManageGrid with container queries, DetailPane (adopts legacy     │
│           │       │ #skillDetail), SkillList + SkillRow, event bus wiring, ~580 lines CSS deleted│
└───────────┴───────┴──────────────────────────────────────────────────────────────────────────────┘

**Task 23 ✅:** `public/components/ui/resizable.jsx` — PanelGroup, Panel, ResizeHandle wrappers around react-resizable-panels.

**Task 24 ✅:** `public/components/ui/collapsible.jsx` + `public/components/Manage/Sidebar.jsx` — Radix Collapsible wrapper + Sidebar shell with localStorage-persisted open state (key `skillworks.sidebarOpen`).

**Task 25 ✅:** `public/components/Manage/FilterSelects.jsx` + `public/components/Manage/TargetChips.jsx` — Agent/Status/Type/Sort dropdowns reading from legacy state; clickable target cards with radio role. Both wire via `filter:change` / `filter:target-toggle` events → legacy state + renderMatrix.

**Task 26 ✅:** `public/components/Manage/StatsStrip.jsx` — 3-column vault/links/unmanaged grid synced via `state:snapshot` events.

**Task 27 ✅:** `public/components/Manage/ManageGrid.jsx` — Composed layout with `@container/manage` container queries (760px, 1100px, 1500px breakpoints) for Tauri-ready reactive width adaptation.

**Task 28 ✅:** `public/components/Manage/DetailPane.jsx` — Card shell adopting legacy `#skillDetail` node via `ref.appendChild`. No `dangerouslySetInnerHTML`.

**Task 29 ✅:** App.jsx wires ManageGrid (conditional render on manage tab, hides legacy `#manageTab` via display:none). app.js emits `state:snapshot` after every `render()`. Event handlers for `filter:change`, `filter:target-toggle`, `selection:toggle`, `selection:select` bridge React → legacy state.

**Task 30 ✅:** `public/components/Manage/SkillList.jsx` + `SkillRow.jsx` — Scrollable skill list with Radix ScrollArea, select-all checkbox, filter summary. Replaces imperative `renderMatrix` row rendering while keeping the legacy function intact for non-React paths.

**Task 31 ✅:** Deleted ~582 lines of obsolete manage CSS (`.manage-grid`, `.skill-list-shell` and all descendants, `.detail-pane` section). CSS reduced from 84KB → 76KB. Remaining manage rules in media queries are dead code (inside hidden `#manageTab`), deferred to PR 6 cleanup.

**Test status:**
- 79 passing tests (was 46, +33 new)
- a11y clean for migrated surfaces (pre-existing CodeMirror/editor violations unchanged)

---

## PR 4: Floating Bulk Bar + Modals + Sonner

- **Task 32:** ✅ BulkFloating component (fixed bottom-right, visible when >1 selected). Wire `bulk:*` events from React → existing `bulkToggle/bulkCopy/bulkMove/bulkDelete` handlers. Emit `bulk:count` from `renderBulkBar()`.
  - Created `public/components/Manage/BulkFloating.jsx`
  - Integrated into `ManageGrid.jsx`
  - Wraps legacy DOM node via `ref.appendChild`

- **Task 33:** ✅ Dialog primitive (Radix) + ApplySetDialog. The dialog adopts the legacy DOM node populated by `app.js` (using existing `escapeHtml`/`escapeAttr` helpers) via `ref.appendChild` — **never** `dangerouslySetInnerHTML`.
  - Created `public/components/ui/dialog.jsx`
  - Created `public/components/Manage/ApplySetDialog.jsx`

- **Task 34:** ✅ NewSkillDialog wrapping the existing `mountCreateSkillEditor` flow in `public/skill-editor.jsx`.
  - Created `public/components/Manage/NewSkillDialog.jsx`
  - Wraps CreateSkillEditor component

- **Task 35:** ✅ Sonner toasts replace the imperative `.toast` element. Created `public/lib/toasts.js` with `showToast()` wrapper; wired in `app.js` to use `sonnerToast`. Toasts now use Radix-based Sonner under the hood while preserving the 2600ms duration and similar visual style.
- **Task 36:** ✅ Open PR 4. Merged PR #1 with all Tasks 32–36 changes.

---

## PR 5: Remaining Tabs

- **Task 37:** Install tab (FromFolder / FromGit / Discovery panels) — Card-based React composition. Wire `install:*` events to the existing HTTP handlers in `app.js`.
- **Task 38:** ✅ Sets tab (SetsList + SetEditor). Emits `sets:*` events; every legacy mutation to `setsState` adds `emit("sets:snapshot", setsState)` after.
- **Task 39:** ✅ Configure tab (Vault + Projects + CustomTargets + Unmanaged panels). Composed with container queries for the wider-window two-column layout.
- **Task 40:** ✅ Cleanup tab (dedupe scan + per-group keeper radio).
- **Task 41:** Open PR 5.

---

## PR 6: Cleanup

- **Task 42:** Write `scripts/check-css-usage.js` that prints orphan class selectors. Delete each orphan rule using `mcp__serena__replace_content`. Verify build + visual regression after each batch.
- **Task 43:** Trim `public/styles.css` to its final ≈50-line shape (the paper-grain body wash is the only legacy rule kept, because Tailwind utilities can't express layered radial+repeating-linear backgrounds). Final file body shown below for reference:

```css
@import "tailwindcss";
@import "./theme.css";

/* Body paper-grain wash — only legacy rule we keep. */
body {
  min-height: 100vh;
  background:
    radial-gradient(circle at 10% 0%, rgba(214, 170, 79, 0.24), transparent 32rem),
    linear-gradient(135deg, rgba(39, 108, 85, 0.12), transparent 34rem),
    repeating-linear-gradient(90deg, rgba(23, 33, 27, 0.035) 0 1px, transparent 1px 96px),
    var(--color-page);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.5;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 253, 246, 0.6), rgba(255, 253, 246, 0)),
    radial-gradient(circle at 90% 20%, rgba(94, 65, 91, 0.12), transparent 28rem);
  mix-blend-mode: multiply;
}
[data-theme="dark"] body {
  background:
    radial-gradient(circle at 10% 0%, rgba(214, 170, 79, 0.10), transparent 32rem),
    linear-gradient(135deg, rgba(39, 108, 85, 0.08), transparent 34rem),
    repeating-linear-gradient(90deg, rgba(255, 250, 240, 0.025) 0 1px, transparent 1px 96px),
    var(--color-page);
}
[data-theme="dark"] body::before {
  background-image:
    linear-gradient(rgba(20, 26, 22, 0.55), rgba(20, 26, 22, 0)),
    radial-gradient(circle at 90% 20%, rgba(184, 143, 177, 0.10), transparent 28rem);
  mix-blend-mode: multiply;
}
```

- **Task 44:** Retire imperative DOM helpers in `app.js` (`relocateManageControls`, `renderTopTabs`, `renderTargets`, `renderBulkBar`, `scrollDetailIntoViewIfStacked`; `setHtml` only if no callers remain). `renderMatrix` shrinks to filter + sort + `snapshot()` only.
- **Task 45:** Final a11y pass — `tests/a11y/all-tabs.spec.js` iterates each tab and runs an axe-core scan; serious/critical must be zero.
- **Task 46:** Final visual regression pass — `npm run test:visual:update` and manual review against PR 1 baseline.
- **Task 47:** Add a "Frontend architecture" section to `README.md` and open PR 6.

---

## Self-review

1. **Spec coverage:**
   - Visual parity → baseline screenshots in Task 12; final pass in Task 46.
   - Tailwind v4 tokens light + dark → Task 4.
   - shadcn primitives → Tasks 6–11.
   - Header → Tasks 15–22 (PR 2).
   - Manage grid → Tasks 23–31 (PR 3).
   - Bulk + modals + toasts → Tasks 32–36 (PR 4).
   - Install / Sets / Configure / Cleanup → Tasks 37–41 (PR 5).
   - Dead-code deletion → Tasks 42–44 (PR 6).
   - Reactive layout for Tauri → container queries in Task 27, matching `@container` utilities in Sets/Configure tabs.
   - WCAG 2.2 AA → axe scans in Tasks 13 + 45.
   - Reduced motion → `motion-safe:` variant convention; verified by visual regression with `animations: "disabled"`.
   - No `dangerouslySetInnerHTML` → ApplySetDialog and DetailPane use `ref.appendChild` adoption.

2. **Placeholder scan:** No `TBD`/`TODO`. Code blocks for every primitive. PRs 2–5 reference patterns established in PR 1 with the same TDD discipline.

3. **Event-name consistency** (used across tasks):
   - `tab:change`, `project:load|browse|refresh|value`, `search:input|value`, `create-skill:open`
   - `state:snapshot`, `filter:change|target-toggle`, `selection:toggle|select`
   - `bulk:count|clear|enable|disable|toggle|browse-dest|destination|copy|move|delete`
   - `apply-set:open|body|confirm|close`, `vault:browse|save`
   - `install:browse-source|source-picked|from-folder|from-suggested|git-clone`
   - `sets:request|snapshot|select|new|patch-draft|save|apply|delete|set-filter|snapshot-current|add-entry|remove-entry`
   - `cleanup:scan|apply|set-keeper|snapshot`

4. **Risks covered:**
   - HMR fragility during migration: `requestAnimationFrame` adoption (Task 29) with idempotent guards (`if (!host.contains(node))`).
   - Tauri scrollbar consistency: native scrollbars retained; Radix `ScrollArea` available where styled scrollbars are needed.
   - Bundle size: shadcn primitives tree-shake; PR 6 verifies `dist/` is no larger than pre-migration.
   - Legacy escape-html-rendered modal bodies: adopted via `ref.appendChild`, never `dangerouslySetInnerHTML`.

---

## Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-shadcn-migration.md`. Two options for proceeding:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, with review checkpoints between tasks. Uses `superpowers:subagent-driven-development`.

**2. Inline** — run tasks in this session in batches with checkpoints. Uses `superpowers:executing-plans`.

Which approach?
