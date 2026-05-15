import { useState, useEffect } from "react";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { Header } from "@/components/Header";
import { ManageGrid } from "@/components/Manage/ManageGrid";
import { InstallTab } from "@/components/Install";
import { SetsTab } from "@/components/Sets";
import { ConfigureTab } from "@/components/Configure";
import { CleanupTab } from "@/components/Cleanup";
import { events, emit } from "@/lib/state";

/**
 * AppShell — Top-level shell: React Header + legacy workspace template.
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

  // Hide legacy manage tab when ManageGrid renders
  useEffect(() => {
    const manageTab = document.getElementById("manageTab");
    if (!manageTab) return;

    const applyVisibility = () => {
      const currentTab = window.__skillworksState?.activeTopTab || activeTab;
      if (currentTab === "manage") {
        manageTab.style.display = "none";
      } else {
        manageTab.style.display = "";
      }
    };

    applyVisibility();
    const handler = () => applyVisibility();
    events.on("tab:change", handler);
    return () => {
      events.off("tab:change", handler);
      manageTab.style.display = "";
    };
  }, [activeTab]);

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

  // Bridge: sets:snapshot → legacy renderSets
  useEffect(() => {
    const handler = (state) => {
      if (window.__setsState && window.__renderSets) {
        Object.assign(window.__setsState, state);
        window.__renderSets();
      }
    };
    events.on("sets:snapshot", handler);
    return () => events.off("sets:snapshot", handler);
  }, []);

  // Bridge: sets:* events from legacy
  useEffect(() => {
    const handler = (action) => {
      if (window.__runAction && typeof window.__runAction === "function") {
        window.__runAction(async () => {
          await window.__loadSets();
          window.__renderSets();
        });
      }
    };
    events.on("sets:refresh", handler);
    return () => events.off("sets:refresh", handler);
  }, []);

  // Bridge: configure:* events
  useEffect(() => {
    const handler = (action) => {
      if (window.__runAction && typeof window.__runAction === "function") {
        window.__runAction(async () => {
          await window.__loadState();
        });
      }
    };
    events.on("configure:refresh", handler);
    return () => events.off("configure:refresh", handler);
  }, []);

  // Bridge: cleanup:* events
  useEffect(() => {
    const handler = (action) => {
      if (window.__runAction && typeof window.__runAction === "function") {
        window.__runAction(async () => {
          await window.__loadState();
        });
      }
    };
    events.on("cleanup:refresh", handler);
    return () => events.off("cleanup:refresh", handler);
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
      {/* PR3: ManageGrid renders for the manage tab surface */}
      {activeTab === "manage" && (
        <div className="flex-1 p-[clamp(12px,1.6vw,24px)]">
          <ManageGrid />
        </div>
      )}

      {/* Install tab - new React implementation */}
      {activeTab === "install" && <InstallTab />}

      {/* Sets tab - new React implementation */}
      {activeTab === "sets" && <SetsTab />}

      {/* Configure tab - new React implementation */}
      {activeTab === "configure" && <ConfigureTab />}

      {/* Cleanup tab - new React implementation */}
      {activeTab === "cleanup" && <CleanupTab />}

      {/* Legacy workspace template — manage tab hidden when ManageGrid renders */}
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
