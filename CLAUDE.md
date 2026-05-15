# Skillworks

## Design Context

### Users
Developers running local AI coding agents (Claude Code, Codex, Gemini CLI, custom agents). They spend most of their day in a terminal or IDE, and Skillworks is the side window where they curate which "skills" — markdown capability docs — get symlinked into each agent's load path, per project or globally. Their context when opening Skillworks is usually mid-task: they need to flip a few skills on/off, install something from a repo, snapshot the current set, then get back to coding. The job to be done is "shape my agent's behavior without losing my place." The interface should feel like reaching for a notebook on the desk, not opening a SaaS dashboard.

### Brand Personality
**Editorial, considered, calm.** The voice is that of a craft tool — confident in its opinions, sparing with chrome, deliberate about typography. It assumes its user is technical and wants signal, not encouragement. Microcopy is precise and unhurried ("Move to vault", "Snapshot current", "Apply set"). No exclamation points, no celebratory toasts, no AI-shaped warmth. The emotional target is **quiet confidence**: the user should feel that the tool is doing serious work on their behalf and trusts them to know what they're doing.

### Aesthetic Direction
The established design language is **editorial paper**: warm cream surface (`#fbfaf3`), deep ink (`#17211b`), sage green primary (`#276c55`), gold accent (`#d6aa4f`), plum highlight (`#5e415b`), mint/amber soft fills. Display type is **Fraunces** at 760 weight with tight tracking and 0.92–1.0 line-height; body is Avenir Next; paths and IDs are **Berkeley Mono**. Cards have a 5/8/18px radius scale, low-elevation `--shadow-soft`, and 0.5–1px ink-tinted borders. The brand block has a 3–4px ink "spine" to the left; cards often carry a thin gold/green/plum gradient stripe along the top. Body has a paper-grain background (radial gold wash + repeating vertical 1px guides). The eyebrow caps (`SKILL WORKSPACE`) are 0.6–0.7rem with 0.14em letter-spacing and uppercase. Motion uses `cubic-bezier(0.22, 1, 0.36, 1)` for entrances and 140–200ms eases for interactive feedback.

**References that capture the right feel:** Things 3 and iA Writer — editorial restraint, generous whitespace, typography-led hierarchy, content over chrome.

**Anti-references:** SaaS dashboards (Stripe-aesthetic gradients, blue-and-purple primaries), generic AI app chrome (glassmorphism, neon accents, animated borders), Material Design density, anything that signals "built by an LLM in 2024."

**Theme**: ship light + dark from day one, gated on `prefers-color-scheme`. The dark palette must preserve the editorial mood — not flip to terminal-green-on-black. Think well-lit study at dusk: ink surface, parchment foreground type, the same green/gold/plum accents at adjusted luminance.

### Accessibility & Inclusion
**WCAG 2.2 AA floor** with `prefers-reduced-motion` honored throughout. All color pairings must clear AA contrast against both light and dark surfaces — verify when tweaking palette. Every interactive element needs a visible focus ring (not removed in favor of `:focus-visible`-only when the user is keyboard-navigating). Reduced-motion users get no entrance animations, no smooth scrolls, only essential state-change feedback. Targets are at least 36px tall for primary controls, 44px for header-level controls.

### Design Principles

1. **Type leads layout.** Hierarchy comes from Fraunces weight/size + letter-spaced eyebrows, not from heavy backgrounds or borders. When in doubt, give the content more whitespace and let the typography do the work.
2. **Restraint over expression.** Every decoration earns its place. The gold/green/plum gradient stripe, the ink spine, the paper grain — these are the brand. Avoid adding more flourish; instead, use the existing motifs intentionally.
3. **Calm interactions.** No bouncy springs, no sparkles, no celebratory states. Motion should feel like a page settling — 140–200ms eases on the `cubic-bezier(0.22, 1, 0.36, 1)` curve. Reduced motion is fully respected.
4. **Density without crowding.** This is a tool that lists many skills. Rows are compact but breathable — never sacrifice line-height for row count. Stats and counts use Fraunces numerals at display size; metadata uses Berkeley Mono at 0.7rem.
5. **Reactive, not just responsive.** Skillworks is a Tauri desktop window of variable width. Use container queries and resize-friendly grid (`Resizable` panels where appropriate) so the layout adapts to the actual workspace, not just screen breakpoints. The sidebar, list, and detail pane must all stay usable from ~720px to 2500px+.
