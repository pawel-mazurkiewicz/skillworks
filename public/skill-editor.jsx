import React, { useEffect, useMemo, useRef, useState } from "react";
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
  const [mode, setMode] = useState("split");
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    setContent(initialContent);
    setLastSavedAt(null);
  }, [initialContent, skill.id]);

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

  return (
    <div className="skill-editor-shell">
      <div className="skill-editor-toolbar">
        <div className="skill-editor-modes" role="tablist" aria-label="Skill editor mode">
          {[
            ["write", "Write"],
            ["split", "Split"],
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
}

export function mountSkillEditor(container, props) {
  let root = editorRoots.get(container);
  if (!root) {
    root = createRoot(container);
    editorRoots.set(container, root);
  }
  root.render(<SkillEditor {...props} />);
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
