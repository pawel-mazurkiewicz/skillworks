# Agent Skill Manager

A local, project-aware skill portfolio manager for coding agents.

The app keeps the canonical skill library in a hidden home-directory vault and activates skills by symlinking them into agent-specific global or project directories. The first implementation is dependency-light Node.js with a browser UI, so it runs on macOS, Linux, and Windows without Electron or Tauri build tooling.

## Run

```bash
npm run static
```

Open `http://127.0.0.1:5179`.

To start on a specific project:

```bash
node src/server.js --project /path/to/project --port 5179
```

## Storage

Default app state:

```text
~/.agent-skill-manager/config.json
~/.agent-skill-manager/vault/
```

Override the app home or vault:

```bash
AGENT_SKILL_MANAGER_HOME=/path/to/app-home node src/server.js
AGENT_SKILL_VAULT=/path/to/vault node src/server.js
```

## Targets

Global targets:

```text
~/.codex/skills
~/.claude/skills
~/.agents/skills
```

Project targets:

```text
<project>/.codex/skills
<project>/.claude/skills
<project>/.agents/skills
```

Each target gets a `.agent-skill-manager.json` manifest. Disabling a skill only removes symlinks that point back to the vault; unmanaged real directories are left alone.

## Importing Existing Skills

Use the Import panel with a folder that either is a skill directory or contains skill directories. A skill directory is any directory containing `SKILL.md`.

Importing moves skills into the vault. The source directory is removed from its original location, and existing symlinks in known global/project targets that pointed at that source are unlinked. This keeps imported skills disabled until Agent Skill Manager explicitly links them back.

Symlinked skills are importable too. When a target contains a symlink to a skill directory, the manager moves the real target directory into the vault and removes the old symlink.

If the vault already contains an identical `SKILL.md`, import deduplicates by removing the old source and keeping the existing vault copy.

Use the Browse buttons to open a native folder picker for project, vault, and import paths.

Use **Move suggested** to process every suggested global/project skill path in one batch. Missing paths are skipped, duplicate path entries are ignored, and the same move/dedupe rules are applied to each found skill.

## Multi-Source Discovery

The Install tab automatically scans:

```text
Global skill directories
Project skill directories
Plugin cache directories
Single-file instruction configs
The Skill Manager vault
```

Global and project skill folders are considered safe `Move suggested` sources. Plugin caches and single-file configs are shown for visibility but are scan-only, because moving plugin-owned cache files can break the owning plugin installation.

## Project Management

The Manage tab has a Projects panel for:

```text
Adding a project manually
Loading saved projects
Running a system scan for projects with skill directories
```

Saved projects are persisted in `~/.agent-skill-manager/config.json` and mirrored into browser `localStorage`, so the project list is restored on the next app launch without running the full scan again.

The scanner discovers project roots that contain any of:

```text
skills/**/SKILL.md
.agents/skills/**/SKILL.md
.codex/skills/**/SKILL.md
.claude/skills/**/SKILL.md
```

It skips global harness folders, plugin caches, the manager vault, and heavyweight directories such as `.git`, `node_modules`, build outputs, and OS cache/library folders.

## Install from Git

The Install tab can clone a Git repository, discover every `SKILL.md` under it, move those skills into the vault, and optionally link them to a selected target.

Supported source forms:

```text
https://github.com/org/repo.git
https://github.com/org/repo.git#branch-or-tag
https://github.com/org/repo.git#branch-or-tag:path/inside/repo
```

Install targets:

```text
Vault only
Codex global
Claude global
Agents global
Codex project
Claude project
Agents project
```

## Bulk Actions

Select skills in the matrix with the left checkbox column. Bulk actions support:

```text
Enable / Disable / Toggle selected skills in a chosen target
Copy selected vault skills to a destination folder
Move selected vault skills to a destination folder
Delete selected vault skills
```

Move and delete remove managed symlinks first. Delete requires UI confirmation before the endpoint is called.

## Sets

Sets are saveable, switchable collections of `(skill, target)` pairs.

Scopes:

- **Global** — stored in `~/.agent-skill-manager/config.json` and shared across projects.
- **Project** — stored in `<project>/.agent-skill-manager/sets.json` and travel with the project.

Apply replaces state only in the targets the set references; targets the set
doesn't mention are left alone. Skills missing from the vault are skipped with
a warning rather than blocking the apply.

The Sets tab supports creating, editing, snapshotting the current state, and
applying. Each project in the Manage tab can pin multiple sets and apply any
of them with one click.

## Test

```bash
npm test
```
