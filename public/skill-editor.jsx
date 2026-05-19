import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { marked } from "marked";
import DOMPurify from "dompurify";

const editorRoots = new Map();

marked.setOptions({
  gfm: true,
  breaks: true,
});

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

function SkillEditor({ skill, initialContent, onSave, onToast }) {
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState("write");
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    setContent(initialContent);
    setLastSavedAt(null);
  }, [initialContent, skill.id]);

  useEffect(() => {
    if (!isExpanded) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setIsExpanded(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("skill-editor-locked");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("skill-editor-locked");
    };
  }, [isExpanded]);

  const isDirty = content !== initialContent;

  const previewHtml = useMemo(() => {
    const raw = marked.parse(content);
    return DOMPurify.sanitize(raw);
  }, [content]);

  async function handleSave() {
    if (!isDirty || isSaving) {
      return;
    }
    setIsSaving(true);
    try {
      await onSave(content);
      if (mountedRef.current) {
        setLastSavedAt(new Date());
      }
      onToast("Skill saved");
    } catch (error) {
      onToast(error.message || "Failed to save skill");
    } finally {
      if (mountedRef.current) {
        setIsSaving(false);
      }
    }
  }

  const editorShell = (
    <div className={classNames("skill-editor-shell", isExpanded && "is-expanded")}>
      <div className="skill-editor-toolbar">
        <div className="skill-editor-modes" role="tablist" aria-label="Skill editor mode">
          {[
            ["write", "Write"],
            ["preview", "Preview"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={classNames("button ghost", mode === value && "is-active")}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="skill-editor-actions">
          <button
            className="button ghost skill-editor-expand"
            type="button"
            aria-pressed={isExpanded}
            title={isExpanded ? "Collapse editor (Esc)" : "Expand editor"}
            onClick={() => setIsExpanded((v) => !v)}
          >
            <svg
              className="icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {isExpanded ? (
                <>
                  <path d="M15 9h6" />
                  <path d="M21 9V3" />
                  <path d="M15 9l6-6" />
                  <path d="M9 15H3" />
                  <path d="M3 15v6" />
                  <path d="M9 15l-6 6" />
                </>
              ) : (
                <>
                  <path d="M4 14v6h6" />
                  <path d="M20 10V4h-6" />
                  <path d="M14 4l6 6" />
                  <path d="M10 20l-6-6" />
                </>
              )}
            </svg>
            <span>{isExpanded ? "Collapse" : "Expand"}</span>
          </button>
          <span className="skill-editor-status">
            {isSaving ? "Saving…" : isDirty ? "Unsaved changes" : lastSavedAt ? "Saved" : "No changes"}
          </span>
          <button className="button primary" type="button" disabled={!isDirty || isSaving} onClick={handleSave}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className={classNames("skill-editor-panels", `mode-${mode}`)}>
        <section className="skill-editor-panel skill-editor-panel-editor" aria-label={`Markdown editor for ${skill.name}`}>
          <header className="skill-editor-panel-head">
            <strong>Markdown</strong>
            <span>{skill.id}/SKILL.md</span>
          </header>
          <CodeMirror
            value={content}
            height="420px"
            extensions={[markdown()]}
            theme="dark"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
            }}
            onChange={(value) => setContent(value)}
          />
        </section>

        <section className="skill-editor-panel skill-editor-panel-preview" aria-label={`Rendered preview for ${skill.name}`}>
          <header className="skill-editor-panel-head">
            <strong>Preview</strong>
            <span>{lastSavedAt ? `Saved ${lastSavedAt.toLocaleTimeString()}` : "Live render"}</span>
          </header>
          <div className="skill-markdown-preview prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </section>
      </div>
    </div>
  );

  if (isExpanded && typeof document !== "undefined") {
    return createPortal(
      <>
        <div
          className="skill-editor-backdrop"
          role="presentation"
          onClick={() => setIsExpanded(false)}
        />
        {editorShell}
      </>,
      document.body,
    );
  }
  return editorShell;
}

function skillTemplate(name) {
  const trimmed = name.trim() || "new-skill";
  return [
    "---",
    `name: ${trimmed}`,
    "description: Describe when this skill should be used.",
    "---",
    "",
    "# Workflow",
    "",
    "Add the operating instructions for this skill here.",
    "",
  ].join("\n");
}

function CreateSkillEditor({ onCreate, onCancel, onToast }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState(skillTemplate(""));
  const [mode, setMode] = useState("write");
  const [contentEdited, setContentEdited] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const nameInputRef = useRef(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!contentEdited) {
      setContent(skillTemplate(name));
    }
  }, [contentEdited, name]);

  const previewHtml = useMemo(() => {
    const raw = marked.parse(content);
    return DOMPurify.sanitize(raw);
  }, [content]);

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      onToast("Skill name is required");
      nameInputRef.current?.focus();
      return;
    }
    if (isCreating) {
      return;
    }
    setIsCreating(true);
    try {
      await onCreate({ name: trimmedName, content });
    } catch (error) {
      onToast(error.message || "Failed to create skill");
      setIsCreating(false);
    }
  }

  return (
    <div className="create-skill-editor">
      <label>
        <span>Skill name</span>
        <input
          ref={nameInputRef}
          value={name}
          placeholder="e.g. tidy-readme"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div className="skill-editor-toolbar">
        <div className="skill-editor-modes" role="tablist" aria-label="New skill editor mode">
          {[
            ["write", "Write"],
            ["preview", "Preview"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={classNames("button ghost", mode === value && "is-active")}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="skill-editor-status">{contentEdited ? "Custom scaffold" : "Generated scaffold"}</span>
      </div>

      <div className={classNames("skill-editor-panels", mode === "preview" ? "mode-preview" : "mode-write")}>
        <section className="skill-editor-panel skill-editor-panel-editor" aria-label="Markdown editor for new skill">
          <header className="skill-editor-panel-head">
            <strong>SKILL.md</strong>
            <span>New vault skill</span>
          </header>
          <CodeMirror
            value={content}
            height="360px"
            extensions={[markdown()]}
            theme="dark"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
            }}
            onChange={(value) => {
              setContentEdited(true);
              setContent(value);
            }}
          />
        </section>

        <section className="skill-editor-panel skill-editor-panel-preview" aria-label="Rendered preview for new skill">
          <header className="skill-editor-panel-head">
            <strong>Preview</strong>
            <span>Live render</span>
          </header>
          <div className="skill-markdown-preview prose" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </section>
      </div>

      <div className="modal-footer create-skill-actions">
        <button className="button ghost" type="button" onClick={onCancel}>Cancel</button>
        <button className="button primary" type="button" disabled={isCreating} onClick={handleCreate}>
          {isCreating ? "Creating…" : "Create skill"}
        </button>
      </div>
    </div>
  );
}

export function mountSkillEditor(container, props) {
  let root = editorRoots.get(container);
  if (!root) {
    root = createRoot(container);
    editorRoots.set(container, root);
  }
  root.render(<SkillEditor {...props} />);
}

export function mountCreateSkillEditor(container, props) {
  let root = editorRoots.get(container);
  if (!root) {
    root = createRoot(container);
    editorRoots.set(container, root);
  }
  root.render(<CreateSkillEditor {...props} />);
}

export function unmountSkillEditor(container) {
  const root = editorRoots.get(container);
  if (!root) {
    return;
  }
  root.unmount();
  editorRoots.delete(container);
}

export function unmountAllSkillEditors() {
  for (const [container, root] of editorRoots.entries()) {
    root.unmount();
    editorRoots.delete(container);
  }
}
