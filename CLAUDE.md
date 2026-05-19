# Skillworks

A local, project-aware skill workspace for coding agents (Claude Code, Codex, Cursor, OpenCode, etc.). The app keeps a canonical skill library in a hidden home-directory vault and symlinks skills into agent-specific global or project directories on demand.

Stack: Tauri desktop shell with a **native Rust backend** (`src-tauri/src/backend/`) + Vite + React frontend + plain CSS design tokens. The frontend invokes Tauri commands directly — there is no Node sidecar in the desktop build. A legacy MCP stdio server (`src/mcp-server.js`) is the only remaining Node entrypoint; it shares vault, config, and manifest files on disk with the desktop app but runs as an independent process for agent-driven activation.

## Design Context

### Users

Power users who run local coding agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode, etc.) and curate a personal library of reusable skills. Their context when using Skillworks is **between tasks** — they're not solving a coding problem here; they're managing the toolbelt they'll use to solve coding problems elsewhere. The job to be done is "see what skills I have, link them to the right agent + project, keep the library clean."

Expected behavior:
- Keyboard-friendly but not keyboard-only.
- Comfortable with technical paths (`~/.codex/skills`), CLI vocabulary, dotfiles.
- Will run the app every few days, not all day. Should feel pleasant on return — never punishing.

### Brand Personality

**Calm, earnest, utilitarian.**

A workshop tool, not a SaaS dashboard. Closer in feel to classic Mac apps (Coda, Tot, Things) than to enterprise admin consoles. Friendly but never cute; precise but never sterile. The voice is plain English describing what each control does ("Move skills from another location into the vault."), not marketing copy.

Emotionally: the user should feel **organized and in control**, with quiet satisfaction. No urgency, no celebration confetti, no "wow" moments — just things in the right places.

### Aesthetic Direction

Warm light theme on cream surfaces, with forest-green ink as the accent. Soft rounded corners (4 / 8 / 14 / 18 px), generous breathing room, monoline 24px stroke icons via an inline SVG sprite. Fraunces serif for display, Avenir Next for body, Berkeley Mono for code.

**Anchor references:** Mac-classic workshop tools (Coda, Tot, Things, Bear). Familiar, soft, slightly nostalgic, deeply tactile.

**Anti-references:**
- Cold gray-and-black SaaS aesthetics (default shadcn, Linear-but-without-warmth).
- AI-startup gradient marketing pages, neon, cyberpunk.
- Enterprise admin consoles (Salesforce, SAP).
- Playful illustrative styles (Notion-style empty-state characters).

**Theme:** Light only for the foreseeable future. Use CSS custom properties (`var(--surface)`, `var(--ink)`, `var(--green)`, etc.) rather than hardcoded hex values so a future dark theme can ship without rewriting components.

### Design Principles

1. **Workshop, not showroom.** Every surface should make the user feel like they're at their workbench: tools are close at hand, labeled, and exactly where they were left. Decoration that doesn't help the task is removed.

2. **Plain language over branding.** Section titles, buttons, and copy describe what they do in literal terms ("Move to vault", "Visible harnesses", "Apply suggestions"). No marketing voice, no jokes, no metaphor stretching.

3. **Density with breathing room.** This is a power-user app — pack functional surface densely. But always with predictable rhythm: consistent spacing scale, clear group boundaries, real whitespace between groups instead of dividers.

4. **Tokens before pixels.** Use the existing CSS custom properties for color, radius, and spacing. New components should compose from the established palette; introducing a new color or radius is a design-system decision, not a one-off.

5. **Motion is subtle and skippable.** Micro-interactions confirm state changes (button lift, count bump, fade-in modal). Nothing slows the user down. Every animation must honor `prefers-reduced-motion: reduce`.

6. **Accessibility floor: WCAG 2.1 AA.** Contrast ≥ 4.5:1 body / ≥ 3:1 large text. Every interactive control reachable by keyboard with a visible focus state. Reduced motion respected. Labels and ARIA used consistently — never decorative-only icons for actions.

### Implementation Notes (for future sessions)

- Design tokens live in `public/styles.css` (the `:root { ... }` block around line 2148). Multiple `:root` blocks exist due to layered overrides — the latest definitions win.
- Components mostly use plain HTML + CSS classes (BEM-ish names), not Tailwind utility soup. New surfaces should follow this pattern.
- The skill detail pane, bulk action panel, and editor modal are the most polished surfaces — model new components on their visual rhythm.
- Always run `npm test` and `npm run build` before committing UI changes. Playwright is available locally via the project's `node_modules` for visual verification — see `git log` for prior sessions where it was used to diagnose layout bugs.
