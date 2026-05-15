import { useState, useEffect } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { Header } from "@/components/Header";
import { events, emit } from "@/lib/state";

/**
 * AppShell — Top-level shell: React Header + legacy workspace template.
 *
 * During migration the header is React; the main content still renders
 * from the legacy `#appShellTemplate`. The event bus bridges React → app.js.
 */
function AppShell() {
  const template = document.querySelector("#appShellTemplate");

  // Read initial state from legacy app.js (exposed on window during bootstrap)
  const [activeTab, setActiveTab] = useState(
    () => window.__skillworksState?.activeTopTab || "manage"
  );
  const [projectPath, setProjectPath] = useState(
    () => localStorage.getItem("asm.projectPath") || ""
  );
  const [searchValue, setSearchValue] = useState("");

  // Bridge: React tab changes → legacy app.js state
  useEffect(() => {
    const handler = (tab) => {
      setActiveTab(tab);
      if (window.__skillworksState) {
        window.__skillworksState.activeTopTab = tab;
      }
      // Trigger legacy render so tab panels flip
      if (window.__skillworksState) {
        const renderTopTabs = window.__renderTopTabs;
        if (typeof renderTopTabs === "function") renderTopTabs();
      }
    };
    events.on("tab:change", handler);
    return () => events.off("tab:change", handler);
  }, []);

  // Bridge: project:browse → legacy pickDirectoryInto
  useEffect(() => {
    const handler = () => {
      if (window.__pickDirectoryInto && document.getElementById("projectInput")) {
        window.__pickDirectoryInto(document.getElementById("projectInput"));
      }
    };
    events.on("project:browse", handler);
    return () => events.off("project:browse", handler);
  }, []);

  // Bridge: project:load → legacy form submit
  useEffect(() => {
    const handler = (path) => {
      setProjectPath(path);
      if (window.__skillworksState) {
        window.__skillworksState.projectPath = path;
      }
      // Trigger legacy load flow
      const form = document.getElementById("pathForm");
      if (form) form.dispatchEvent(new SubmitEvent("submit", { bubbles: true }));
    };
    events.on("project:load", handler);
    return () => events.off("project:load", handler);
  }, []);

  // Bridge: project:refresh → legacy loadState
  useEffect(() => {
    const handler = () => {
      if (window.__loadState && typeof window.__loadState === "function") {
        window.__loadState();
      }
    };
    events.on("project:refresh", handler);
    return () => events.off("project:refresh", handler);
  }, []);

  // Bridge: search:input → legacy state + renderMatrix
  useEffect(() => {
    const handler = (value) => {
      setSearchValue(value);
      if (window.__skillworksState) {
        window.__skillworksState.search = value;
      }
    };
    events.on("search:input", handler);
    return () => events.off("search:input", handler);
  }, []);

  // Bridge: create-skill:open → legacy modal
  useEffect(() => {
    const handler = () => {
      if (window.__openCreateSkillModal && typeof window.__openCreateSkillModal === "function") {
        window.__openCreateSkillModal();
      }
    };
    events.on("create-skill:open", handler);
    return () => events.off("create-skill:open", handler);
  }, []);

  return (
    <div className="flex flex-col min-h-screen">
      <Header
        activeTab={activeTab}
        projectPath={projectPath}
        onProjectChange={setProjectPath}
        searchValue={searchValue}
        onSearchChange={setSearchValue}
      />
      {/* Legacy workspace template — header already stripped from index.html */}
      <div dangerouslySetInnerHTML={{ __html: template?.innerHTML.trim() || "" }} />
    </div>
  );
}

export default function App({ children }) {
  return (
    <ThemeProvider>
      {children ?? <AppShell />}
    </ThemeProvider>
  );
}
