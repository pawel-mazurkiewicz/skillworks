import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { mountCreateSkillEditor, mountSkillEditor, unmountAllSkillEditors, unmountSkillEditor } from "./skill-editor.jsx";
import "./styles.css";

const PROJECT_CACHE_KEY = "asm.projects";
const DESKTOP_API_ORIGIN = "http://127.0.0.1:5179";
const SIDEBAR_COLLAPSE_KEY = "skillworks.sidebarCollapsed";

const state = {
  data: null,
  selectedSkillId: null,
  selectedSkillIds: new Set(),
  activeTag: "All",
  activeTopTab: "manage",
  search: "",
  filterTargetId: "all",
  filterStatus: "all",
  filterType: "all",
  sortBy: "name-asc",
  preview: null,
  dedupe: null,
  dedupeChoices: new Map(),
  activeInstallTab: "marketplace",
  marketplace: {
    query: "",
    view: "trending",
    page: 0,
    perPage: 24,
    items: [],
    pagination: null,
    loaded: false,
    error: "",
  },
};

let setsState = {
  global: [],
  project: [],
  pinned: { ids: [], resolved: [], missing: [] },
  filter: "all",
  selectedId: null,
  draft: null,
  loaded: false,
};

let pendingApplySetId = null;
let lastAppliedSet = null; // { id, name, touchedTargets, modified }

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

flushSync(() => {
  createRoot(rootElement).render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  );
});

const elements = {
  appShell: document.querySelector(".app-shell"),
  topTabs: document.querySelectorAll("[data-top-tab]"),
  tabPanels: document.querySelectorAll("[data-top-tab-panel]"),
  contextStrip: document.querySelector(".context-strip"),
  mainSurface: document.querySelector(".main-surface"),
  toolbar: document.querySelector(".toolbar"),
  bulkBar: document.querySelector(".bulk-bar"),
  pathForm: document.querySelector("#pathForm"),
  projectInput: document.querySelector("#projectInput"),
  browseProjectButton: document.querySelector("#browseProjectButton"),
  vaultInput: document.querySelector("#vaultInput"),
  browseVaultButton: document.querySelector("#browseVaultButton"),
  saveVaultButton: document.querySelector("#saveVaultButton"),
  refreshButton: document.querySelector("#refreshButton"),
  skillCount: document.querySelector("#skillCount"),
  enabledCount: document.querySelector("#enabledCount"),
  unmanagedCount: document.querySelector("#unmanagedCount"),
  importSelect: document.querySelector("#importSelect"),
  importInput: document.querySelector("#importInput"),
  browseImportButton: document.querySelector("#browseImportButton"),
  importButton: document.querySelector("#importButton"),
  importSuggestedButton: document.querySelector("#importSuggestedButton"),
  discoverySummary: document.querySelector("#discoverySummary"),
  discoveryList: document.querySelector("#discoveryList"),
  unmanagedList: document.querySelector("#unmanagedList"),
  openCreateSkillButton: document.querySelector("#openCreateSkillButton"),
  closeCreateSkillButton: document.querySelector("#closeCreateSkillButton"),
  createSkillModal: document.querySelector('[data-modal="create-skill"]'),
  createSkillEditorRoot: document.querySelector("#createSkillEditorRoot"),
  gitInstallForm: document.querySelector("#gitInstallForm"),
  gitRepoInput: document.querySelector("#gitRepoInput"),
  gitRefInput: document.querySelector("#gitRefInput"),
  gitTargetPicker: document.querySelector("#gitTargetPicker"),
  gitTargetSummary: document.querySelector("#gitTargetSummary"),
  gitTargetCheckboxes: document.querySelector("#gitTargetCheckboxes"),
  gitPreviewButton: document.querySelector("#gitPreviewButton"),
  gitPreviewResult: document.querySelector("#gitPreviewResult"),
  installTabs: document.querySelectorAll("[data-install-tab]"),
  installPanels: document.querySelectorAll("[data-install-panel]"),
  marketplaceSearchInput: document.querySelector("#marketplaceSearchInput"),
  marketplaceViewSelect: document.querySelector("#marketplaceViewSelect"),
  marketplaceRefreshButton: document.querySelector("#marketplaceRefreshButton"),
  marketplaceTargetSummary: document.querySelector("#marketplaceTargetSummary"),
  marketplaceTargetCheckboxes: document.querySelector("#marketplaceTargetCheckboxes"),
  marketplaceStatus: document.querySelector("#marketplaceStatus"),
  marketplaceResults: document.querySelector("#marketplaceResults"),
  marketplacePreviousButton: document.querySelector("#marketplacePreviousButton"),
  marketplaceNextButton: document.querySelector("#marketplaceNextButton"),
  searchInput: document.querySelector("#searchInput"),
  agentFilterSelect: document.querySelector("#agentFilterSelect"),
  statusFilterSelect: document.querySelector("#statusFilterSelect"),
  typeFilterSelect: document.querySelector("#typeFilterSelect"),
  sortSelect: document.querySelector("#sortSelect"),
  bulkSelectedCount: document.querySelector("#bulkSelectedCount"),
  clearSelectionButton: document.querySelector("#clearSelectionButton"),
  bulkTargetSelect: document.querySelector("#bulkTargetSelect"),
  bulkEnableButton: document.querySelector("#bulkEnableButton"),
  bulkDisableButton: document.querySelector("#bulkDisableButton"),
  bulkToggleButton: document.querySelector("#bulkToggleButton"),
  bulkDestinationInput: document.querySelector("#bulkDestinationInput"),
  browseBulkDestinationButton: document.querySelector("#browseBulkDestinationButton"),
  bulkCopyButton: document.querySelector("#bulkCopyButton"),
  bulkMoveButton: document.querySelector("#bulkMoveButton"),
  bulkDeleteButton: document.querySelector("#bulkDeleteButton"),
  projectAddInput: document.querySelector("#projectAddInput"),
  browseProjectAddButton: document.querySelector("#browseProjectAddButton"),
  projectScanRootInput: document.querySelector("#projectScanRootInput"),
  browseProjectScanRootButton: document.querySelector("#browseProjectScanRootButton"),
  addProjectButton: document.querySelector("#addProjectButton"),
  scanProjectsButton: document.querySelector("#scanProjectsButton"),
  scanDefaultProjectsButton: document.querySelector("#scanDefaultProjectsButton"),
  clearScannedProjectsButton: document.querySelector("#clearScannedProjectsButton"),
  projectList: document.querySelector("#projectList"),
  customTargetForm: document.querySelector("#customTargetForm"),
  customTargetId: document.querySelector("#customTargetId"),
  customTargetLabel: document.querySelector("#customTargetLabel"),
  customTargetHarness: document.querySelector("#customTargetHarness"),
  customTargetScope: document.querySelector("#customTargetScope"),
  customTargetPath: document.querySelector("#customTargetPath"),
  customTargetList: document.querySelector("#customTargetList"),
  targetVisibilityList: document.querySelector("#targetVisibilityList"),
  targetStrip: document.querySelector("#targetStrip"),
  matrixHead: document.querySelector("#matrixHead"),
  matrixBody: document.querySelector("#matrixBody"),
  emptyDetail: document.querySelector("#emptyDetail"),
  skillDetail: document.querySelector("#skillDetail"),
  detailTags: document.querySelector("#detailTags"),
  detailName: document.querySelector("#detailName"),
  detailDescription: document.querySelector("#detailDescription"),
  detailPath: document.querySelector("#detailPath"),
  detailId: document.querySelector("#detailId"),
  detailLinks: document.querySelector("#detailLinks"),
  skillPreview: document.querySelector("#skillPreview"),
  copyPathButton: document.querySelector("#copyPathButton"),
  toast: document.querySelector("#toast"),
  bulkFloating: document.querySelector("#bulkFloating"),
  manageGrid: document.querySelector("#manageTab .manage-grid"),
  sidebarToggle: document.querySelector('[data-action="sidebar-toggle"]'),
  dedupeScanButton: document.querySelector("#dedupeScanButton"),
  dedupeApplyButton: document.querySelector("#dedupeApplyButton"),
  dedupeSummary: document.querySelector("#dedupeSummary"),
  dedupeList: document.querySelector("#dedupeList"),
};

bootstrap();

async function bootstrap() {
  elements.topTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTopTab = button.dataset.topTab;
      renderTopTabs();
      if (state.activeTopTab === "sets") {
        runAction(async () => {
          await loadSets();
          renderSets();
        });
      } else if (state.activeTopTab === "install" && !state.marketplace.loaded) {
        runAction(() => loadMarketplace());
      }
    });
  });
  initSidebarToggle();
  renderTopTabs();

  initSetsPanel();

  elements.pathForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      localStorage.setItem("asm.projectPath", elements.projectInput.value);
      await loadState();
    });
  });

  elements.refreshButton.addEventListener("click", () => runAction(() => loadState()));

  elements.browseProjectButton.addEventListener("click", () => pickDirectoryInto(elements.projectInput));
  elements.browseVaultButton.addEventListener("click", () => pickDirectoryInto(elements.vaultInput));
  elements.browseImportButton.addEventListener("click", () => pickDirectoryInto(elements.importInput));
  elements.browseBulkDestinationButton.addEventListener("click", () => pickDirectoryInto(elements.bulkDestinationInput));
  elements.browseProjectAddButton.addEventListener("click", () => pickDirectoryInto(elements.projectAddInput));
  elements.browseProjectScanRootButton.addEventListener("click", () => pickDirectoryInto(elements.projectScanRootInput));

  elements.saveVaultButton.addEventListener("click", () => runAction(async () => {
    await api("/api/config", {
      method: "POST",
      body: {
        vaultRoot: elements.vaultInput.value,
        recentProjects: state.data?.recentProjects || [],
        projects: state.data?.projects || readCachedProjects(),
      },
    });
    await loadState();
    showToast("Vault saved");
  }));

  elements.importSelect.addEventListener("change", () => {
    elements.importInput.value = elements.importSelect.value;
  });

  elements.importButton.addEventListener("click", () => runAction(async () => {
    const sourcePath = elements.importInput.value.trim();
    if (!sourcePath) {
      showToast("Choose an import path");
      return;
    }
    applyState(await api("/api/import", {
      method: "POST",
      body: {
        sourcePath,
        projectPath: elements.projectInput.value,
      },
    }));
    render();
    showToast("Moved into vault");
  }));

  elements.importSuggestedButton.addEventListener("click", () => runAction(async () => {
    const result = await api("/api/import-suggested", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        sourcePaths: state.data?.suggestedImports || [],
      },
    });
    applyState(result.state);
    render();
    const report = result.report || { imported: 0, skipped: 0, errors: 0 };
    showToast(`Moved ${report.imported}, skipped ${report.skipped}, errors ${report.errors}`);
  }));

  elements.installTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeInstallTab = button.dataset.installTab;
      renderInstallTabs();
      if (state.activeInstallTab === "marketplace" && !state.marketplace.loaded) {
        runAction(() => loadMarketplace());
      }
    });
  });

  elements.marketplaceSearchInput.addEventListener("input", () => {
    state.marketplace.query = elements.marketplaceSearchInput.value;
    state.marketplace.page = 0;
    window.clearTimeout(elements.marketplaceSearchInput.searchTimeout);
    elements.marketplaceSearchInput.searchTimeout = window.setTimeout(() => {
      runAction(() => loadMarketplace());
    }, 260);
  });

  elements.marketplaceViewSelect.addEventListener("change", () => {
    state.marketplace.view = elements.marketplaceViewSelect.value;
    state.marketplace.page = 0;
    runAction(() => loadMarketplace());
  });

  elements.marketplaceRefreshButton.addEventListener("click", () => runAction(() => loadMarketplace()));
  elements.marketplacePreviousButton.addEventListener("click", () => runAction(() => loadMarketplacePage(-1)));
  elements.marketplaceNextButton.addEventListener("click", () => runAction(() => loadMarketplacePage(1)));
  elements.marketplaceTargetCheckboxes.addEventListener("change", (event) => {
    if (event.target.matches("input[type=checkbox]")) {
      updateMarketplaceTargetSummary();
    }
  });

  elements.openCreateSkillButton.addEventListener("click", () => openCreateSkillModal());
  elements.closeCreateSkillButton.addEventListener("click", () => closeCreateSkillModal());
  elements.createSkillModal.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCreateSkillModal();
  });
  elements.createSkillModal.addEventListener("close", () => {
    if (!elements.createSkillModal.open) {
      unmountCreateSkillModal();
    }
  });

  elements.gitPreviewButton.addEventListener("click", () => runAction(async () => {
    const repoUrl = elements.gitRepoInput.value.trim();
    if (!repoUrl) {
      showToast("Git URL is required");
      return;
    }
    const targetIds = Array.from(
      elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked"),
    ).map((input) => input.value);
    const plan = await api("/api/install-git/preview", {
      method: "POST",
      body: {
        repoUrl,
        ref: elements.gitRefInput.value.trim(),
        targetIds,
        projectPath: elements.projectInput.value,
      },
    });
    renderInstallPreview(plan, { repoUrl });
    showToast(`Preview: ${plan.summary.toMove} to move, ${plan.summary.toDedupe} dedupe, ${plan.summary.toSkip} skip`);
  }));

  elements.gitTargetCheckboxes.addEventListener("change", (event) => {
    if (event.target.matches("input[type=checkbox]")) {
      updateGitTargetSummary();
    }
  });

  elements.gitInstallForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      const repoUrl = elements.gitRepoInput.value.trim();
      if (!repoUrl) {
        showToast("Git URL is required");
        return;
      }
      const targetIds = Array.from(
        elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked"),
      ).map((input) => input.value);
      const body = {
        repoUrl,
        ref: elements.gitRefInput.value.trim(),
        targetIds,
        projectPath: elements.projectInput.value,
      };
      if (state.preview && state.preview.repoUrl === repoUrl) {
        body.perSkillTargets = state.preview.perSkillTargets;
      }
      const result = await api("/api/install-git", {
        method: "POST",
        body,
      });
      applyState(result.state);
      state.preview = null;
      elements.gitPreviewResult.hidden = true;
      elements.gitPreviewResult.innerHTML = "";
      render();
      const report = result.report || { imported: 0, skipped: 0, enabled: 0, errors: 0 };
      showToast(`Installed ${report.imported}, linked ${report.enabled}, errors ${report.errors}`);
    });
  });

  elements.searchInput.addEventListener("input", () => {
    state.search = elements.searchInput.value;
    renderMatrix();
    renderBulkBar();
  });

  elements.agentFilterSelect.addEventListener("change", () => {
    state.filterTargetId = elements.agentFilterSelect.value;
    renderMatrix();
    renderBulkBar();
  });

  elements.statusFilterSelect.addEventListener("change", () => {
    state.filterStatus = elements.statusFilterSelect.value;
    renderMatrix();
    renderBulkBar();
  });

  elements.typeFilterSelect.addEventListener("change", () => {
    state.filterType = elements.typeFilterSelect.value;
    renderMatrix();
    renderBulkBar();
  });

  elements.sortSelect.addEventListener("change", () => {
    state.sortBy = elements.sortSelect.value;
    renderMatrix();
  });

  elements.clearSelectionButton.addEventListener("click", () => {
    state.selectedSkillIds.clear();
    renderMatrix();
    renderBulkBar();
  });

  elements.bulkEnableButton.addEventListener("click", () => bulkToggle("enable"));
  elements.bulkDisableButton.addEventListener("click", () => bulkToggle("disable"));
  elements.bulkToggleButton.addEventListener("click", () => bulkToggle("toggle"));
  elements.bulkCopyButton.addEventListener("click", () => bulkCopy());
  elements.bulkMoveButton.addEventListener("click", () => bulkMove());
  elements.bulkDeleteButton.addEventListener("click", () => bulkDelete());
  elements.addProjectButton.addEventListener("click", () => addProject());
  elements.scanProjectsButton.addEventListener("click", () => scanProjects({ scoped: true }));
  elements.scanDefaultProjectsButton.addEventListener("click", () => scanProjects({ scoped: false }));
  elements.clearScannedProjectsButton.addEventListener("click", () => clearScannedProjects());
  elements.dedupeScanButton.addEventListener("click", () => scanDuplicates());
  elements.dedupeApplyButton.addEventListener("click", () => applyDedupe());

  const updateCustomTargetPlaceholder = () => {
    elements.customTargetPath.placeholder = elements.customTargetScope.value === "global"
      ? "/abs/path (e.g. ~/.cursor/rules)"
      : ".relative/path (e.g. .myrules/skills)";
  };
  updateCustomTargetPlaceholder();
  elements.customTargetScope.addEventListener("change", updateCustomTargetPlaceholder);
  elements.customTargetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    addCustomTarget();
  });

  if (elements.copyPathButton) {
    elements.copyPathButton.addEventListener("click", () => copySelectedSkillPath());
  }

  elements.projectInput.value = localStorage.getItem("asm.projectPath") || "";
  await runAction(() => loadState());
}

function openCreateSkillModal() {
  mountCreateSkillEditor(elements.createSkillEditorRoot, {
    onCancel: closeCreateSkillModal,
    onToast: showToast,
    onCreate: async ({ name, content }) => {
      applyState(await api("/api/create-skill", {
        method: "POST",
        body: {
          name,
          content,
          projectPath: elements.projectInput.value,
        },
      }));
      state.selectedSkillId = state.data.skills.find((skill) => skill.name === name)?.id || state.selectedSkillId;
      closeCreateSkillModal();
      render();
      showToast("Skill created");
    },
  });

  if (typeof elements.createSkillModal.showModal === "function") {
    elements.createSkillModal.showModal();
  } else {
    elements.createSkillModal.setAttribute("open", "");
  }
}

function closeCreateSkillModal() {
  if (elements.createSkillModal.open && typeof elements.createSkillModal.close === "function") {
    elements.createSkillModal.close();
  } else {
    elements.createSkillModal.removeAttribute("open");
    unmountCreateSkillModal();
  }
}

function unmountCreateSkillModal() {
  if (elements.createSkillEditorRoot) {
    unmountSkillEditor(elements.createSkillEditorRoot);
  }
}

async function loadState() {
  const project = elements.projectInput.value.trim();
  const url = new URL("/api/state", window.location.origin);
  if (project) {
    url.searchParams.set("project", project);
  }
  applyState(await api(url.pathname + url.search));
  if (!state.selectedSkillId && state.data.skills[0]) {
    state.selectedSkillId = state.data.skills[0].id;
  }
  try {
    await loadSets();
  } catch {
    // Sets are optional context for Manage tab — ignore failures here.
  }
  render();
}

function applyState(nextData) {
  const cachedProjects = readCachedProjects();
  const serverProjects = normalizeProjectCache(nextData?.projects || []);
  const projects = mergeProjects(serverProjects, cachedProjects);

  const hiddenIds = new Set(Array.isArray(nextData?.hiddenTargetIds) ? nextData.hiddenTargetIds : []);
  const allTargets = Array.isArray(nextData?.targets) ? nextData.targets : [];
  const visibleTargets = allTargets.filter((target) => !hiddenIds.has(target.id));

  state.data = {
    ...nextData,
    projects,
    allTargets,
    targets: visibleTargets,
    hiddenTargetIds: Array.from(hiddenIds),
  };

  writeCachedProjects(projects);
}

function readCachedProjects() {
  try {
    const rawProjects = JSON.parse(localStorage.getItem(PROJECT_CACHE_KEY) || "[]");
    return normalizeProjectCache(rawProjects);
  } catch {
    return [];
  }
}

function writeCachedProjects(projects) {
  try {
    localStorage.setItem(PROJECT_CACHE_KEY, JSON.stringify(normalizeProjectCache(projects)));
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
}

function clearCachedProjects() {
  try {
    localStorage.removeItem(PROJECT_CACHE_KEY);
  } catch {
    // Local storage can be unavailable in private or restricted browser contexts.
  }
}

function removeCachedProject(projectPath) {
  writeCachedProjects(readCachedProjects().filter((project) => project.path !== projectPath));
}

function mergeProjects(primaryProjects, fallbackProjects) {
  return normalizeProjectCache([...fallbackProjects, ...primaryProjects]);
}

function normalizeProjectCache(projects) {
  const byPath = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    const projectPath = String(project?.path || "").trim();
    if (!projectPath) {
      continue;
    }
    const skillSources = Array.isArray(project.skillSources) ? project.skillSources : [];
    const existing = byPath.get(projectPath) || {};
    byPath.set(projectPath, {
      ...existing,
      ...project,
      path: projectPath,
      name: project.name || existing.name || projectNameFromPath(projectPath),
      source: project.source || existing.source || "local",
      skillSourceCount: Number.isFinite(project.skillSourceCount)
        ? project.skillSourceCount
        : skillSources.length || existing.skillSourceCount || 0,
      skillSources,
      lastSeenAt: project.lastSeenAt || existing.lastSeenAt || null,
    });
  }
  return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function projectNameFromPath(projectPath) {
  const trimmed = String(projectPath).replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || projectPath;
}

function render() {
  const { data } = state;
  if (!data) {
    return;
  }

  elements.projectInput.value = data.project.path;
  elements.vaultInput.value = data.vaultRoot;
  elements.skillCount.textContent = data.summary.skillCount;
  elements.enabledCount.textContent = data.summary.enabledCount;
  elements.unmanagedCount.textContent = data.summary.unmanagedCount;

  renderImports();
  renderProjects();
  renderCustomTargets();
  renderTargetVisibility();
  renderDiscovery();
  renderInstallTargets();
  renderInstallTabs();
  renderMarketplace();
  renderBulkTargets();
  renderBulkBar();
  renderTopTabs();
  renderUnmanaged();
  renderTargets();
  renderTags();
  renderMatrix();
  renderDrift();
  renderDetail();
}

function renderProjects() {
  const projects = state.data.projects || [];
  if (!projects.length) {
    elements.projectList.innerHTML = `<p class="empty-copy">No saved projects yet.</p>`;
    return;
  }

  elements.projectList.innerHTML = projects
    .map((project) => {
      const active = project.path === state.data.project.path;
      return `
        <article class="project-item ${active ? "is-active" : ""}">
          <div class="project-item-head">
            <div>
              <strong class="item-title">${iconSprite("folder", "icon item-icon")}${escapeHtml(project.name)}</strong>
              <span>${escapeHtml(project.source)} / ${project.skillSourceCount || 0} skill source${project.skillSourceCount === 1 ? "" : "s"}</span>
            </div>
            <button class="button ghost" type="button" data-load-project="${escapeHtml(project.path)}">Load</button>
            <button class="button ghost" type="button" data-forget-project="${escapeHtml(project.path)}">Forget</button>
          </div>
          <div class="project-path">${escapeHtml(project.path)}</div>
        </article>
      `;
    })
    .join("");

  elements.projectList.querySelectorAll("[data-load-project]").forEach((button) => {
    button.addEventListener("click", () => runAction(async () => {
      elements.projectInput.value = button.dataset.loadProject;
      localStorage.setItem("asm.projectPath", elements.projectInput.value);
      await loadState();
      showToast("Project loaded");
    }));
  });

  elements.projectList.querySelectorAll("[data-forget-project]").forEach((button) => {
    button.addEventListener("click", () => forgetProject(button.dataset.forgetProject));
  });

  renderProjectPinnedControls();
}

function renderProjectPinnedControls() {
  const activeProjectPath = state.data && state.data.project && state.data.project.path;
  if (!activeProjectPath) return;
  const items = elements.projectList.querySelectorAll(".project-item");
  items.forEach((article, index) => {
    const project = (state.data.projects || [])[index];
    if (!project || project.path !== activeProjectPath) return;

    // Remove any previously-rendered pinned controls.
    const old = article.querySelector("[data-project-pinned]");
    if (old) old.remove();

    const wrap = makeEl("div", { class: "project-pinned", dataset: { projectPinned: "true" } });

    const allSets = [...setsState.global, ...setsState.project];
    const pinnedResolved = (setsState.pinned && setsState.pinned.resolved) || [];
    const pinnedIds = (setsState.pinned && setsState.pinned.ids) || [];

    const chips = makeEl("div", { class: "project-pinned-chips" });
    if (pinnedResolved.length === 0) {
      chips.appendChild(makeEl("span", { class: "muted" }, "No pinned sets yet."));
    } else {
      for (const ps of pinnedResolved) {
        const chip = makeEl("span", { class: "project-pinned-chip" });
        chip.appendChild(makeEl("span", {}, ps.name));
        chip.appendChild(makeEl("button", {
          type: "button",
          dataset: { action: "unpin-set", id: ps.id },
          "aria-label": `Unpin ${ps.name}`,
        }, "×"));
        chips.appendChild(chip);
      }
    }
    wrap.appendChild(chips);

    const controls = makeEl("div", { class: "project-pinned-controls" });

    const pinSelect = makeEl("select", { dataset: { action: "pin-set" }, "aria-label": "Pin a set" });
    pinSelect.appendChild(makeEl("option", { value: "" }, "Pin set…"));
    const pinnedSet = new Set(pinnedIds);
    for (const s of allSets) {
      if (pinnedSet.has(s.id)) continue;
      pinSelect.appendChild(makeEl("option", { value: s.id }, `${s.name} (${s.scope})`));
    }
    controls.appendChild(pinSelect);

    const applySelect = makeEl("select", { dataset: { action: "apply-pinned-set" }, "aria-label": "Apply pinned set" });
    applySelect.appendChild(makeEl("option", { value: "" }, "Apply pinned set…"));
    for (const ps of pinnedResolved) {
      applySelect.appendChild(makeEl("option", { value: ps.id }, ps.name));
    }
    controls.appendChild(applySelect);

    wrap.appendChild(controls);
    article.appendChild(wrap);
  });
}

function renderCustomTargets() {
  const customs = state.data.customTargets || [];
  if (!customs.length) {
    elements.customTargetList.innerHTML = `<p class="empty-copy">No custom targets yet.</p>`;
    return;
  }

  elements.customTargetList.innerHTML = customs
    .map((target) => {
      const locator = target.scope === "global"
        ? escapeHtml(target.path || "")
        : escapeHtml(target.relativePath || "");
      return `
        <article class="project-item">
          <div class="project-item-head">
            <div>
              <strong class="item-title">${iconSprite("folder-cog", "icon item-icon")}${escapeHtml(target.label)}</strong>
              <span>${escapeHtml(target.scope)} / ${escapeHtml(target.harness || "Custom")} / id: ${escapeHtml(target.id)}</span>
            </div>
            <button class="button ghost" type="button" data-remove-custom-target="${escapeHtml(target.id)}">Remove</button>
          </div>
          <div class="project-path">${locator}</div>
        </article>
      `;
    })
    .join("");

  elements.customTargetList.querySelectorAll("[data-remove-custom-target]").forEach((button) => {
    button.addEventListener("click", () => removeCustomTarget(button.dataset.removeCustomTarget));
  });
}

function renderTargetVisibility() {
  if (!elements.targetVisibilityList) return;
  const all = state.data?.allTargets || [];
  const builtins = all.filter((target) => !target.custom);
  if (!builtins.length) {
    elements.targetVisibilityList.innerHTML = `<p class="empty-copy">No built-in harnesses available.</p>`;
    return;
  }

  const hiddenIds = new Set(state.data?.hiddenTargetIds || []);
  const groups = new Map();
  const order = [];
  for (const target of builtins) {
    const harness = (target.harness && target.harness.trim()) || "Custom";
    if (!groups.has(harness)) {
      order.push(harness);
      groups.set(harness, { harness, global: null, project: null, extras: [] });
    }
    const group = groups.get(harness);
    if (target.scope === "global" && !group.global) {
      group.global = target;
    } else if (target.scope === "project" && !group.project) {
      group.project = target;
    } else {
      group.extras.push(target);
    }
  }

  const renderScopeBox = (target, fallbackLabel) => {
    if (!target) {
      return `<label class="visibility-scope is-empty" aria-hidden="true"><span class="scope-name">${escapeHtml(fallbackLabel)}</span></label>`;
    }
    const isVisible = !hiddenIds.has(target.id);
    const scopeLabel = target.scope === "global" ? "Global" : "Project";
    return `
      <label class="visibility-scope" title="${escapeHtml(target.label)}">
        <input
          type="checkbox"
          data-visibility-toggle="${escapeHtml(target.id)}"
          ${isVisible ? "checked" : ""}
        />
        <span class="scope-name">${escapeHtml(scopeLabel)}</span>
      </label>
    `;
  };

  elements.targetVisibilityList.innerHTML = order
    .map((harness) => {
      const group = groups.get(harness);
      const cells = [
        renderScopeBox(group.global, "Global"),
        renderScopeBox(group.project, "Project"),
      ];
      const extras = group.extras
        .map((target) => renderScopeBox(target, target.scope === "global" ? "Global" : "Project"))
        .join("");
      return `
        <div class="visibility-row">
          <div class="visibility-label">
            <strong>${escapeHtml(harness)}</strong>
          </div>
          <div class="visibility-scopes">${cells.join("")}${extras}</div>
        </div>
      `;
    })
    .join("");

  elements.targetVisibilityList.querySelectorAll("[data-visibility-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      const targetId = input.dataset.visibilityToggle;
      const nextHidden = !input.checked;
      setTargetVisibility(targetId, nextHidden);
    });
  });
}

async function setTargetVisibility(targetId, hidden) {
  await runAction(async () => {
    const current = new Set(state.data?.hiddenTargetIds || []);
    if (hidden) {
      current.add(targetId);
    } else {
      current.delete(targetId);
    }
    const nextHidden = Array.from(current);
    await api("/api/config", {
      method: "POST",
      body: {
        vaultRoot: state.data?.vaultRoot,
        recentProjects: state.data?.recentProjects || [],
        projects: state.data?.projects || readCachedProjects(),
        customTargets: state.data?.customTargets || [],
        hiddenTargetIds: nextHidden,
      },
    });
    await loadState();
    showToast(hidden ? "Harness hidden" : "Harness restored");
  });
}

async function addCustomTarget() {
  await runAction(async () => {
    const id = elements.customTargetId.value.trim();
    const label = elements.customTargetLabel.value.trim();
    const harness = elements.customTargetHarness.value.trim();
    const scope = elements.customTargetScope.value;
    const rawPath = elements.customTargetPath.value.trim();
    if (!id) {
      showToast("Custom target id is required");
      return;
    }
    if (!rawPath) {
      showToast(scope === "global" ? "Absolute path is required" : "Relative path is required");
      return;
    }

    const existing = state.data?.customTargets || [];
    if (existing.some((target) => target.id === id)) {
      showToast(`Custom target id already exists: ${id}`);
      return;
    }

    const entry = { id, label: label || id, scope };
    if (harness) entry.harness = harness;
    if (scope === "global") {
      entry.path = rawPath;
    } else {
      entry.relativePath = rawPath;
    }

    const nextCustomTargets = [...existing, entry];
    const result = await api("/api/config", {
      method: "POST",
      body: {
        vaultRoot: state.data?.vaultRoot,
        recentProjects: state.data?.recentProjects || [],
        projects: state.data?.projects || readCachedProjects(),
        customTargets: nextCustomTargets,
      },
    });
    // /api/config returns the persisted config, not full state. Reload state.
    void result;
    elements.customTargetId.value = "";
    elements.customTargetLabel.value = "";
    elements.customTargetHarness.value = "";
    elements.customTargetPath.value = "";
    await loadState();
    showToast("Custom target added");
  });
}

async function removeCustomTarget(id) {
  await runAction(async () => {
    const existing = state.data?.customTargets || [];
    const nextCustomTargets = existing.filter((target) => target.id !== id);
    if (nextCustomTargets.length === existing.length) {
      return;
    }
    await api("/api/config", {
      method: "POST",
      body: {
        vaultRoot: state.data?.vaultRoot,
        recentProjects: state.data?.recentProjects || [],
        projects: state.data?.projects || readCachedProjects(),
        customTargets: nextCustomTargets,
      },
    });
    await loadState();
    showToast("Custom target removed");
  });
}

function renderImports() {
  const options = state.data.suggestedImports.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`);
  elements.importSelect.innerHTML = [`<option value="">Suggested paths</option>`, ...options].join("");
}

function renderDiscovery() {
  const discovery = state.data.discovery || { summary: {}, sources: [] };
  const summary = discovery.summary || {};
  elements.discoverySummary.innerHTML = `
    <span>${summary.existingCount || 0} existing</span>
    <span>${summary.skillCount || 0} skills</span>
    <span>${summary.configFileCount || 0} config files</span>
  `;

  const sources = discovery.sources || [];
  if (!sources.length) {
    elements.discoveryList.innerHTML = `<p class="empty-copy">No discovery sources configured.</p>`;
    return;
  }

  elements.discoveryList.innerHTML = sources
    .map((source) => {
      const status = source.exists ? `${source.skillCount || source.configFileCount || 0} found` : "missing";
      const action = source.importable ? "move" : "scan";
      const samples = source.samples?.length ? `<div class="discovery-samples">${source.samples.map(escapeHtml).join(", ")}</div>` : "";
      return `
        <article class="discovery-item ${source.exists ? "" : "is-missing"}">
          <div>
            <strong class="item-title">${iconSprite(source.exists ? "search" : "clear-all", "icon item-icon")}${escapeHtml(source.label)}</strong>
            <span>${escapeHtml(source.kind)} / ${escapeHtml(source.scope)} / ${escapeHtml(action)} / ${escapeHtml(status)}</span>
          </div>
          <div class="discovery-path">${escapeHtml(source.path)}</div>
          ${samples}
        </article>
      `;
    })
    .join("");
}

function renderInstallTargets() {
  const targets = state.data.targets || [];
  if (!targets.length) {
    elements.gitTargetCheckboxes.innerHTML =
      `<legend>Extra targets</legend>` +
      `<p class="empty-copy">No targets available.</p>`;
    elements.marketplaceTargetCheckboxes.innerHTML =
      `<legend>Extra targets</legend>` +
      `<p class="empty-copy">No targets available.</p>`;
    updateGitTargetSummary();
    updateMarketplaceTargetSummary();
    return;
  }
  const previouslyChecked = new Set(
    Array.from(elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked")).map((input) => input.value),
  );
  const marketplaceChecked = new Set(
    Array.from(elements.marketplaceTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked")).map((input) => input.value),
  );
  const items = targets
    .map((target) => {
      const checked = previouslyChecked.has(target.id) ? "checked" : "";
      const locator = target.scope === "project" ? "Project target" : "Global target";
      return `
        <label class="target-checkbox">
          <input type="checkbox" value="${escapeHtml(target.id)}" ${checked} />
          <span>
            <strong>${escapeHtml(target.label)}</strong>
            <small>${escapeHtml(locator)}</small>
          </span>
        </label>
      `;
    })
    .join("");
  const marketplaceItems = targets
    .map((target) => {
      const checked = marketplaceChecked.has(target.id) ? "checked" : "";
      const locator = target.scope === "project" ? "Project target" : "Global target";
      return `
        <label class="target-checkbox">
          <input type="checkbox" value="${escapeHtml(target.id)}" ${checked} />
          <span>
            <strong>${escapeHtml(target.label)}</strong>
            <small>${escapeHtml(locator)}</small>
          </span>
        </label>
      `;
    })
    .join("");
  elements.gitTargetCheckboxes.innerHTML =
    `<legend>Extra targets</legend>${items}`;
  elements.marketplaceTargetCheckboxes.innerHTML =
    `<legend>Extra targets</legend>${marketplaceItems}`;
  updateGitTargetSummary();
  updateMarketplaceTargetSummary();
}

function updateGitTargetSummary() {
  if (!elements.gitTargetSummary || !elements.gitTargetCheckboxes) {
    return;
  }
  const checked = Array.from(
    elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked"),
  );
  if (!checked.length) {
    elements.gitTargetSummary.textContent = "Vault only";
    return;
  }
  const labelsById = new Map((state.data?.targets || []).map((target) => [target.id, target.label]));
  const names = checked.map((input) => labelsById.get(input.value) || input.value);
  elements.gitTargetSummary.textContent =
    names.length <= 2 ? `Vault + ${names.join(", ")}` : `Vault + ${names.length} targets`;
}

function updateMarketplaceTargetSummary() {
  if (!elements.marketplaceTargetSummary || !elements.marketplaceTargetCheckboxes) {
    return;
  }
  const checked = Array.from(
    elements.marketplaceTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked"),
  );
  if (!checked.length) {
    elements.marketplaceTargetSummary.textContent = "Vault only";
    return;
  }
  const labelsById = new Map((state.data?.targets || []).map((target) => [target.id, target.label]));
  const names = checked.map((input) => labelsById.get(input.value) || input.value);
  elements.marketplaceTargetSummary.textContent =
    names.length <= 2 ? `Vault + ${names.join(", ")}` : `Vault + ${names.length} targets`;
}

function renderInstallTabs() {
  elements.installTabs.forEach((button) => {
    const active = button.dataset.installTab === state.activeInstallTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  elements.installPanels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.installPanel !== state.activeInstallTab);
  });
}

async function loadMarketplacePage(delta) {
  const nextPage = Math.max(0, state.marketplace.page + delta);
  if (nextPage === state.marketplace.page) {
    return;
  }
  state.marketplace.page = nextPage;
  await loadMarketplace();
}

async function loadMarketplace() {
  state.marketplace.query = elements.marketplaceSearchInput.value.trim();
  state.marketplace.view = elements.marketplaceViewSelect.value;
  const params = new URLSearchParams({
    view: state.marketplace.view,
    page: String(state.marketplace.page),
    per_page: String(state.marketplace.perPage),
  });
  if (state.marketplace.query) {
    params.set("q", state.marketplace.query);
  }
  elements.marketplaceStatus.textContent = "Loading skills.sh...";
  try {
    const payload = await api(`/api/marketplace/skills?${params.toString()}`);
    state.marketplace.items = Array.isArray(payload.data) ? payload.data : [];
    state.marketplace.pagination = payload.pagination || null;
    state.marketplace.loaded = true;
    state.marketplace.error = "";
    renderMarketplace();
  } catch (error) {
    elements.marketplaceStatus.textContent = error.message || "Marketplace unavailable.";
    state.marketplace.items = [];
    state.marketplace.pagination = null;
    state.marketplace.loaded = true;
    state.marketplace.error = error.message || "Marketplace unavailable.";
    renderMarketplace();
    throw error;
  }
}

function renderMarketplace() {
  if (!elements.marketplaceResults) {
    return;
  }
  const items = state.marketplace.items || [];
  const pagination = state.marketplace.pagination;
  const query = state.marketplace.query.trim();
  const mode = query.length >= 2 ? `Search: ${query}` : marketplaceViewLabel(state.marketplace.view);
  const count = pagination?.total || items.length;
  const scraped = items.some((item) => item.scraped);
  elements.marketplaceStatus.textContent = state.marketplace.error
    ? state.marketplace.error
    : state.marketplace.loaded
    ? `${mode} / ${count} skill${count === 1 ? "" : "s"}${pagination ? ` / page ${pagination.page + 1}` : ""}${scraped ? " / parsed from public pages" : ""}`
    : "Load marketplace skills to begin.";
  elements.marketplacePreviousButton.disabled = !pagination || pagination.page <= 0 || query.length >= 2;
  elements.marketplaceNextButton.disabled = !pagination || !pagination.hasMore || query.length >= 2;

  if (!items.length) {
    elements.marketplaceResults.innerHTML = state.marketplace.error
      ? `<p class="empty-copy">skills.sh returned <code>401 authentication_required</code> for a public API request. Their docs say unauthenticated access should work with lower rate limits, so this looks like an upstream docs/API mismatch. Optional <code>SKILLS_SH_API_KEY</code> can work around it if you have one.</p>`
      : `<p class="empty-copy">No marketplace skills found.</p>`;
    return;
  }

  elements.marketplaceResults.innerHTML = items.map((skill) => renderMarketplaceSkill(skill)).join("");
  elements.marketplaceResults.querySelectorAll("[data-marketplace-install]").forEach((button) => {
    button.addEventListener("click", () => installMarketplaceSkill(button.dataset.marketplaceInstall));
  });
}

function renderMarketplaceSkill(skill) {
  const installed = isMarketplaceInstalled(skill);
  const installCount = Number(skill.installs);
  return `
    <article class="marketplace-card">
      <div class="marketplace-card-main">
        <header>
          <strong>${escapeHtml(skill.name || skill.slug || skill.id)}</strong>
          <span>${escapeHtml(skill.source || "")}</span>
        </header>
        <p>${escapeHtml(skill.description || skill.id || "")}</p>
        <div class="marketplace-card-meta">
          ${Number.isFinite(installCount) ? `<span>${installCount.toLocaleString()} installs</span>` : ""}
          <span>${escapeHtml(skill.sourceType || "source")}</span>
          ${skill.scraped ? "<span>public page</span>" : ""}
          ${skill.isDuplicate ? "<span>duplicate</span>" : ""}
        </div>
      </div>
      <div class="marketplace-card-actions">
        ${skill.url ? `<a class="button ghost marketplace-link" href="${escapeAttr(skill.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
        <button class="button primary" type="button" data-marketplace-install="${escapeHtml(skill.id)}">${installed ? "Use Git again" : "Use Git"}</button>
      </div>
    </article>
  `;
}

function marketplaceViewLabel(view) {
  return {
    "all-time": "All time",
    trending: "Trending",
    hot: "Hot",
    official: "Official",
  }[view] || "Marketplace";
}

function isMarketplaceInstalled(skill) {
  const source = String(skill.source || "").toLowerCase();
  const slug = String(skill.slug || "").toLowerCase();
  return (state.data?.skills || []).some((item) => {
    const haystack = `${item.id} ${item.name} ${item.path}`.toLowerCase();
    return (slug && haystack.includes(slug)) || (source && haystack.includes(source.replace("/", "-")));
  });
}

async function installMarketplaceSkill(id) {
  const skill = (state.marketplace.items || []).find((item) => item.id === id);
  if (!skill || !skill.installUrl) {
    showToast("GitHub source not available");
    return;
  }
  elements.gitRepoInput.value = skill.installUrl;
  elements.gitRefInput.value = "";
  copyMarketplaceTargetsToGitTargets();
  state.activeInstallTab = "git";
  renderInstallTabs();
  updateGitTargetSummary();
  showToast(`Ready in From Git: ${skill.source}`);
}

function copyMarketplaceTargetsToGitTargets() {
  const selected = new Set(
    Array.from(elements.marketplaceTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked")).map((input) => input.value),
  );
  elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]").forEach((input) => {
    input.checked = selected.has(input.value);
  });
}

function renderInstallPreview(plan, options = {}) {
  if (!plan || !Array.isArray(plan.candidates)) {
    elements.gitPreviewResult.hidden = true;
    elements.gitPreviewResult.innerHTML = "";
    state.preview = null;
    return;
  }

  if (options.resetSelection !== false) {
    const perSkillTargets = {};
    for (const candidate of plan.candidates) {
      if (candidate.action !== "skip") {
        perSkillTargets[candidate.sourceKey] = candidate.targetLinks.map((link) => link.targetId);
      }
    }
    state.preview = {
      repoUrl: options.repoUrl || "",
      plan,
      perSkillTargets,
    };
  } else if (state.preview) {
    state.preview.plan = plan;
  }

  const summary = plan.summary;
  const allTargets = (state.data && state.data.targets) || [];
  const rows = plan.candidates
    .map((candidate) => {
      const actionLabel = candidate.action === "move"
        ? `Move to <code>${escapeHtml(candidate.vaultDestination)}</code>`
        : candidate.action === "dedupe"
          ? `Dedupe against <code>${escapeHtml(candidate.vaultDestination)}</code>`
          : `Skip: ${escapeHtml(candidate.skipReason || "")}`;
      let targetGrid = "";
      if (candidate.action !== "skip") {
        const checked = new Set(
          (state.preview && state.preview.perSkillTargets[candidate.sourceKey]) || [],
        );
        const items = allTargets
          .map((target) => {
            const isChecked = checked.has(target.id) ? "checked" : "";
            return `
              <label class="target-checkbox">
                <input
                  type="checkbox"
                  value="${escapeHtml(target.id)}"
                  data-skill-key="${escapeHtml(candidate.sourceKey)}"
                  ${isChecked}
                />
                <span>${escapeHtml(target.label)}</span>
              </label>
            `;
          })
          .join("");
        targetGrid = `<fieldset class="target-checkboxes preview-target-grid">
            <legend>Targets for ${escapeHtml(candidate.name)}</legend>
            ${items || `<p class="empty-copy">No targets configured.</p>`}
          </fieldset>`;
      }
      return `
        <article class="preview-item" data-source-key="${escapeHtml(candidate.sourceKey)}">
          <header>
            <strong>${escapeHtml(candidate.name)}</strong>
            <span class="preview-action preview-action-${escapeHtml(candidate.action)}">${escapeHtml(candidate.action)}</span>
          </header>
          <div class="preview-detail">${actionLabel}</div>
          <div class="preview-source">From: <code>${escapeHtml(candidate.sourcePath)}</code></div>
          ${targetGrid}
        </article>
      `;
    })
    .join("");

  elements.gitPreviewResult.hidden = false;
  elements.gitPreviewResult.innerHTML = `
    <div class="preview-summary">
      <strong>Plan:</strong>
      <span>${summary.candidates} candidate${summary.candidates === 1 ? "" : "s"}</span>
      <span>${summary.toMove} move</span>
      <span>${summary.toDedupe} dedupe</span>
      <span>${summary.toSkip} skip</span>
      <button class="button ghost" type="button" id="clearPreviewButton">Clear preview</button>
    </div>
    <div class="preview-list">${rows || `<p class="empty-copy">No skills discovered.</p>`}</div>
  `;

  elements.gitPreviewResult.querySelectorAll("input[type=checkbox][data-skill-key]").forEach((input) => {
    input.addEventListener("change", () => {
      if (!state.preview) {
        return;
      }
      const key = input.dataset.skillKey;
      const current = new Set(state.preview.perSkillTargets[key] || []);
      if (input.checked) {
        current.add(input.value);
      } else {
        current.delete(input.value);
      }
      state.preview.perSkillTargets[key] = Array.from(current);
    });
  });

  const clearButton = elements.gitPreviewResult.querySelector("#clearPreviewButton");
  if (clearButton) {
    clearButton.addEventListener("click", () => {
      state.preview = null;
      elements.gitPreviewResult.hidden = true;
      elements.gitPreviewResult.innerHTML = "";
    });
  }
}

function renderBulkTargets() {
  const currentValue = elements.bulkTargetSelect.value;
  elements.bulkTargetSelect.innerHTML = state.data.targets
    .map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`)
    .join("");
  if (currentValue && state.data.targets.some((target) => target.id === currentValue)) {
    elements.bulkTargetSelect.value = currentValue;
  }
}

function renderBulkBar() {
  const skillIds = new Set(state.data.skills.map((skill) => skill.id));
  for (const id of [...state.selectedSkillIds]) {
    if (!skillIds.has(id)) {
      state.selectedSkillIds.delete(id);
    }
  }

  const count = state.selectedSkillIds.size;
  if (elements.bulkSelectedCount) {
    const prev = Number(elements.bulkSelectedCount.dataset.value || "0");
    if (prev !== count) {
      const pill = elements.bulkSelectedCount.closest(".bulk-count-pill");
      if (pill) {
        pill.classList.remove("is-bumped");
        // eslint-disable-next-line no-unused-expressions
        pill.offsetHeight;
        pill.classList.add("is-bumped");
      }
      elements.bulkSelectedCount.dataset.value = String(count);
    }
    elements.bulkSelectedCount.textContent = `${count} selected`;
  }
  const disabled = count === 0;
  [
    elements.clearSelectionButton,
    elements.bulkEnableButton,
    elements.bulkDisableButton,
    elements.bulkToggleButton,
    elements.bulkCopyButton,
    elements.bulkMoveButton,
    elements.bulkDeleteButton,
  ].forEach((button) => {
    if (button) button.disabled = disabled;
  });

  const panel = elements.bulkFloating;
  if (panel) {
    const shouldShow = count > 1;
    if (shouldShow) {
      panel.hidden = false;
      // Force reflow so the transition can run, then add the visible class.
      // eslint-disable-next-line no-unused-expressions
      panel.offsetHeight;
      panel.classList.add("is-visible");
    } else {
      panel.classList.remove("is-visible");
      panel.hidden = true;
    }
  }
}

function renderTopTabs() {
  elements.topTabs.forEach((button) => {
    const active = button.dataset.topTab === state.activeTopTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.topTabPanel !== state.activeTopTab);
  });
  if (elements.appShell) {
    elements.appShell.setAttribute("data-active-tab", state.activeTopTab);
  }
}

function initSidebarToggle() {
  if (!elements.manageGrid || !elements.sidebarToggle) return;
  const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
  const collapsed = stored === null ? true : stored !== "false";
  applySidebarState(collapsed);
  elements.sidebarToggle.addEventListener("click", () => {
    const next = elements.manageGrid.getAttribute("data-sidebar-collapsed") !== "false"
      ? false
      : true;
    applySidebarState(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next));
    } catch (_err) {
      /* ignore storage errors */
    }
  });
}

function applySidebarState(collapsed) {
  if (!elements.manageGrid) return;
  elements.manageGrid.setAttribute("data-sidebar-collapsed", collapsed ? "true" : "false");
  if (elements.sidebarToggle) {
    elements.sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }
}

function relocateManageControls() {
  // Layout is now static: header is permanent, sidebar/main/detail are wired in markup.
  // Kept as a no-op so older call sites continue to compile.
}

async function scanDuplicates() {
  await runAction(async () => {
    const result = await api("/api/duplicates");
    state.dedupe = result;
    state.dedupeChoices = new Map(
      (result.groups || []).map((group) => [group.hash, group.suggestedKeeperId]),
    );
    renderDedupe();
  });
}

async function applyDedupe() {
  if (!state.dedupe || !state.dedupe.groups || state.dedupe.groups.length === 0) {
    return;
  }
  const groups = state.dedupe.groups
    .map((group) => {
      const keeperId = state.dedupeChoices.get(group.hash) || group.suggestedKeeperId;
      return {
        keeperId,
        removeIds: group.skills.map((s) => s.id).filter((id) => id !== keeperId),
      };
    })
    .filter((group) => group.removeIds.length > 0);

  if (groups.length === 0) {
    showToast("Nothing to remove.");
    return;
  }

  await runAction(async () => {
    const result = await api("/api/dedupe", {
      method: "POST",
      body: { groups, projectPath: elements.projectInput.value || undefined },
    });
    if (result.state) {
      state.data = result.state;
    }
    const removed = result.deleted ? result.deleted.length : 0;
    const errors = result.errors ? result.errors.length : 0;
    showToast(`Merged ${removed} duplicate${removed === 1 ? "" : "s"}${errors ? ` (${errors} error${errors === 1 ? "" : "s"})` : ""}.`);
    state.dedupe = null;
    state.dedupeChoices = new Map();
    renderDedupe();
    await loadState();
  });
}

function renderDedupe() {
  const dedupe = state.dedupe;
  if (!dedupe) {
    setHtml(elements.dedupeSummary, "");
    setHtml(elements.dedupeList, '<p class="empty-copy">Press <strong>Scan vault</strong> to find duplicate skills.</p>');
    elements.dedupeApplyButton.disabled = true;
    return;
  }

  const groups = dedupe.groups || [];
  const summary = groups.length === 0
    ? `<span>No duplicates found in <strong>${escapeHtml(dedupe.vaultRoot || "")}</strong>.</span>`
    : `
        <span><strong>${dedupe.groupCount}</strong> duplicate group${dedupe.groupCount === 1 ? "" : "s"}</span>
        <span><strong>${dedupe.duplicateCount}</strong> skill${dedupe.duplicateCount === 1 ? "" : "s"} will be removed</span>
        <span>in <strong>${escapeHtml(dedupe.vaultRoot || "")}</strong></span>
      `;
  setHtml(elements.dedupeSummary, summary);

  if (groups.length === 0) {
    setHtml(elements.dedupeList, '<p class="empty-copy">Nothing to clean up. Your vault has no byte-identical duplicates.</p>');
    elements.dedupeApplyButton.disabled = true;
    return;
  }

  setHtml(elements.dedupeList, groups.map((group) => renderDedupeGroup(group)).join(""));
  elements.dedupeList.querySelectorAll("input[name^='dedupe-keeper-']").forEach((input) => {
    input.addEventListener("change", (event) => {
      const target = event.currentTarget;
      state.dedupeChoices.set(target.dataset.groupHash, target.value);
      renderDedupe();
    });
  });
  elements.dedupeApplyButton.disabled = false;
}

function renderDedupeGroup(group) {
  const keeperId = state.dedupeChoices.get(group.hash) || group.suggestedKeeperId;
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `
    <article class="dedupe-group">
      <div class="dedupe-group-head">
        <strong>${escapeHtml(group.skills[0].name)}</strong>
        <span class="hash">sha256 ${escapeHtml(group.hash.slice(0, 12))}</span>
      </div>
      <div class="dedupe-options" role="radiogroup" aria-label="Choose the copy to keep for ${escapeHtml(group.skills[0].name)}">
        ${group.skills
          .map((skill) => {
            const isKeeper = skill.id === keeperId;
            const isSuggested = skill.id === group.suggestedKeeperId;
            const inputId = `dedupe-${escapeAttr(group.hash)}-${escapeAttr(skill.id)}`;
            const modified = skill.mtimeMs ? formatter.format(new Date(skill.mtimeMs)) : "unknown";
            const badge = isKeeper
              ? `<span class="badge">Keep</span>`
              : isSuggested
                ? `<span class="badge">Newest</span>`
                : `<span class="badge">Remove</span>`;
            return `
              <label class="dedupe-option ${isKeeper ? "is-keeper" : ""}" for="${inputId}">
                <input
                  type="radio"
                  name="dedupe-keeper-${escapeAttr(group.hash)}"
                  id="${inputId}"
                  data-group-hash="${escapeAttr(group.hash)}"
                  value="${escapeAttr(skill.id)}"
                  ${isKeeper ? "checked" : ""}
                />
                <span class="dedupe-option-body">
                  <strong>${escapeHtml(skill.id)}</strong>
                  <span class="path">${escapeHtml(skill.path)}</span>
                  <span class="meta">Modified ${escapeHtml(modified)} · ${formatBytes(skill.bytes)}</span>
                </span>
                ${badge}
              </label>
            `;
          })
          .join("")}
      </div>
    </article>
  `;
}

function setHtml(node, html) {
  // Local helper that matches the rest of this file's render-via-template pattern.
  // All interpolated values pass through escapeHtml/escapeAttr above; no untrusted markup reaches the DOM.
  node.innerHTML = html;
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
}

function iconSprite(name, className = "icon") {
  return `<svg class="${escapeAttr(className)}" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-${escapeAttr(name)}"></use></svg>`;
}

function harnessIconName(harness) {
  const normalized = String(harness || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const icons = {
    agents: "harness-agents",
    antigravity: "harness-antigravity",
    claude: "harness-claude",
    codebuddy: "harness-codebuddy",
    codex: "harness-codex",
    copilot: "harness-copilot",
    cursor: "harness-cursor",
    gemini: "harness-gemini",
    kiro: "harness-kiro",
    openclaw: "harness-openclaw",
    opencode: "harness-opencode",
    qoder: "harness-qoder",
    trae: "harness-trae",
  };
  return icons[normalized] || "harness-custom";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderTargets() {
  const activeTargetId = state.filterTargetId && state.filterTargetId !== "all"
    ? state.filterTargetId
    : null;
  elements.targetStrip.innerHTML = state.data.targets
    .map((target) => {
      const unmanaged = target.unmanaged.length ? `${target.unmanaged.length} unmanaged` : "clean";
      const isActive = activeTargetId === target.id;
      return `
        <article class="target-card${isActive ? " is-active" : ""}" role="button" tabindex="0" data-target-id="${escapeAttr(target.id)}" aria-pressed="${isActive ? "true" : "false"}">
          <div class="target-card-head">
            ${iconSprite("folder", "icon target-card-icon")}
            <strong>${escapeHtml(target.label)}</strong>
          </div>
          <span>${target.enabledSkillIds.length} linked, ${escapeHtml(unmanaged)}</span>
          <small title="${escapeHtml(target.path)}">${escapeHtml(target.path)}</small>
        </article>
      `;
    })
    .join("");

  elements.targetStrip.querySelectorAll("[data-target-id]").forEach((card) => {
    const activate = () => {
      const id = card.getAttribute("data-target-id");
      const current = state.filterTargetId;
      const next = current === id ? "all" : id;
      state.filterTargetId = next;
      if (elements.agentFilterSelect) {
        const hasOption = Array.from(elements.agentFilterSelect.options).some((opt) => opt.value === next);
        elements.agentFilterSelect.value = hasOption ? next : "all";
      }
      renderMatrix();
      renderBulkBar();
      renderTargets();
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function renderUnmanaged() {
  const targets = state.data.targets.filter((target) => target.unmanaged.length);
  if (!targets.length) {
    elements.unmanagedList.innerHTML = `<p class="empty-copy">No unmanaged skills in the configured global or project targets.</p>`;
    return;
  }

  elements.unmanagedList.innerHTML = targets
    .map(
      (target) => `
        <section class="unmanaged-group">
          <div class="unmanaged-group-head">
            <div>
              <strong>${escapeHtml(target.label)}</strong>
              <span>${target.unmanaged.length} item${target.unmanaged.length === 1 ? "" : "s"}</span>
            </div>
            <button class="button ghost" type="button" data-import-path="${escapeHtml(target.path)}">Import all</button>
          </div>
          ${target.unmanaged
            .map(
              (item) => `
                <article class="unmanaged-item">
                  <span class="unmanaged-kind">${escapeHtml(item.kind)}</span>
                  <strong>${escapeHtml(item.name)}</strong>
                  <div class="unmanaged-path">${escapeHtml(item.path)}</div>
                  ${
                    item.target
                      ? `<div class="unmanaged-path">Target: ${escapeHtml(item.target)}</div>`
                      : ""
                  }
                  ${
                    item.importable
                      ? `<button class="button" type="button" data-import-path="${escapeHtml(item.path)}">Move to vault</button>`
                      : ""
                  }
                </article>
              `,
            )
            .join("")}
        </section>
      `,
    )
    .join("");

  elements.unmanagedList.querySelectorAll("[data-import-path]").forEach((button) => {
    button.addEventListener("click", () => runAction(async () => {
      applyState(await api("/api/import", {
        method: "POST",
        body: {
          sourcePath: button.dataset.importPath,
          projectPath: elements.projectInput.value,
        },
      }));
      render();
      showToast("Moved into vault");
    }));
  });
}

function renderTags() {
  const currentTarget = state.filterTargetId;
  const currentType = state.filterType;
  const types = new Set();
  for (const skill of state.data.skills) {
    types.add(skillType(skill));
  }

  elements.agentFilterSelect.innerHTML = [
    `<option value="all">Any agent</option>`,
    ...state.data.targets.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`),
  ].join("");
  elements.agentFilterSelect.value = state.data.targets.some((target) => target.id === currentTarget)
    ? currentTarget
    : "all";
  state.filterTargetId = elements.agentFilterSelect.value;

  elements.typeFilterSelect.innerHTML = [
    `<option value="all">Any type</option>`,
    ...[...types].sort((left, right) => left.localeCompare(right)).map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`),
  ].join("");
  elements.typeFilterSelect.value = types.has(currentType) ? currentType : "all";
  state.filterType = elements.typeFilterSelect.value;
  elements.statusFilterSelect.value = state.filterStatus;
  elements.sortSelect.value = state.sortBy;
}

function renderMatrix() {
  const targets = state.data.targets;
  const skills = filteredSkills();
  const visibleSkillIds = skills.map((skill) => skill.id);
  const allVisibleSelected = visibleSkillIds.length > 0 && visibleSkillIds.every((id) => state.selectedSkillIds.has(id));

  elements.matrixHead.innerHTML = `
    <label class="skill-list-select-all">
      <input type="checkbox" id="selectVisibleCheckbox" ${allVisibleSelected ? "checked" : ""} aria-label="Select visible skills" />
      <span>${skills.length} skill${skills.length === 1 ? "" : "s"}</span>
    </label>
    <span>${escapeHtml(activeFilterSummary())}</span>
  `;

  if (!skills.length) {
    elements.matrixBody.innerHTML = `<div class="empty-state">No skills match these filters. Clear search or widen the filters to bring the list back.</div>`;
    bindSelectVisible(visibleSkillIds);
    return;
  }

  elements.matrixBody.innerHTML = skills
    .map((skill) => {
      const activeTargets = targets.filter((target) => target.skillStatuses[skill.id]?.enabled);
      const assignmentText = activeTargets.length
        ? activeTargets.map((target) => target.shortLabel || target.label).join(", ")
        : "Disabled";
      return `
        <article class="skill-list-item ${skill.id === state.selectedSkillId ? "is-selected" : ""}" data-select-skill="${escapeHtml(skill.id)}">
          <label class="row-check" title="Select ${escapeHtml(skill.name)}">
            <input
              type="checkbox"
              aria-label="Select ${escapeHtml(skill.name)}"
              data-select-row="${escapeHtml(skill.id)}"
              ${state.selectedSkillIds.has(skill.id) ? "checked" : ""}
            />
          </label>
          <button class="skill-list-button" type="button">
            <span class="skill-list-title">
              <strong>${escapeHtml(skill.name)}</strong>
              <span>${escapeHtml(skillAuthor(skill))}</span>
            </span>
            <span class="skill-description">${escapeHtml(skill.description || "No description")}</span>
            <span class="tag-row">
              <span class="tag type-tag">${escapeHtml(skillType(skill))}</span>
              ${skill.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </span>
          </button>
          <span class="assignment-summary ${activeTargets.length ? "" : "is-disabled"}">${escapeHtml(assignmentText)}</span>
        </article>
      `;
    })
    .join("");

  bindSelectVisible(visibleSkillIds);

  elements.matrixBody.querySelectorAll("[data-select-row]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedSkillIds.add(checkbox.dataset.selectRow);
      } else {
        state.selectedSkillIds.delete(checkbox.dataset.selectRow);
      }
      renderMatrix();
      renderDetail();
      renderBulkBar();
    });
  });

  elements.matrixBody.querySelectorAll("[data-select-skill]").forEach((row) => {
    row.addEventListener("click", async (event) => {
      if (event.target.closest("[data-select-row]")) {
        return;
      }
      state.selectedSkillId = row.dataset.selectSkill;
      renderMatrix();
      await renderDetail();
      scrollDetailIntoViewIfStacked();
    });
  });

}

function scrollDetailIntoViewIfStacked() {
  const pane = document.querySelector("#manageTab .detail-pane");
  if (!pane) return;
  // When the layout collapses to "side main / detail detail" the detail pane
  // can sit below the fold. Bring it into view on the workspace scroll axis.
  const stacked = window.matchMedia("(max-width: 900px)").matches;
  if (!stacked) return;
  pane.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindSelectVisible(visibleSkillIds) {
  const checkbox = document.querySelector("#selectVisibleCheckbox");
  if (!checkbox) {
    return;
  }
  checkbox.addEventListener("change", () => {
    for (const id of visibleSkillIds) {
      if (checkbox.checked) {
        state.selectedSkillIds.add(id);
      } else {
        state.selectedSkillIds.delete(id);
      }
    }
    renderMatrix();
    renderDetail();
    renderBulkBar();
  });
}

async function renderDetail() {
  const skill = selectedSkill();
  if (!skill) {
    unmountAllSkillEditors();
    elements.emptyDetail.hidden = false;
    elements.skillDetail.hidden = true;
    elements.skillPreview.innerHTML = "";
    return;
  }

  unmountAllSkillEditors();
  elements.emptyDetail.hidden = true;
  elements.skillDetail.hidden = false;
  elements.skillPreview.innerHTML = renderDetailPane(skill);

  elements.skillPreview.querySelectorAll("[data-copy-selected-path]").forEach((button) => {
    button.addEventListener("click", () => copySelectedSkillPath());
  });

  elements.skillPreview.querySelectorAll("[data-detail-target-id]").forEach((button) => {
    button.addEventListener("click", () => runAction(async () => {
      const nextEnabled = button.dataset.enabled !== "true";
      const targetId = button.dataset.detailTargetId;
      applyState(await api("/api/toggle", {
        method: "POST",
        body: {
          projectPath: elements.projectInput.value,
          targetId,
          skillId: button.dataset.skillId,
          enabled: nextEnabled,
        },
      }));
      if (lastAppliedSet && lastAppliedSet.touchedTargets.includes(targetId)) {
        lastAppliedSet.modified = true;
      }
      render();
      showToast(nextEnabled ? "Skill enabled" : "Skill disabled");
    }));
  });

  const editorNode = elements.skillPreview.querySelector("[data-skill-editor-root]");

  const activeSkillId = skill.id;
  const preview = await api(`/api/skill?id=${encodeURIComponent(skill.id)}`);
  if (selectedSkill()?.id !== activeSkillId) {
    return;
  }

  mountSkillEditor(editorNode, {
    skill: preview.skill,
    initialContent: preview.content,
    onToast: showToast,
    onSave: async (content) => {
      const result = await api("/api/skill", {
        method: "POST",
        body: {
          id: activeSkillId,
          content,
          projectPath: elements.projectInput.value,
        },
      });
      applyState(result.state);
      state.selectedSkillId = activeSkillId;
      render();
    },
  });
}

function renderDetailPane(skill) {
  const harnessOrder = [];
  const harnessGroups = new Map();
  for (const target of state.data.targets) {
    const harness = (target.harness && target.harness.trim()) || "Custom";
    if (!harnessGroups.has(harness)) {
      harnessOrder.push(harness);
      harnessGroups.set(harness, { harness, global: null, project: null, extras: [] });
    }
    const group = harnessGroups.get(harness);
    if (target.scope === "global" && !group.global) {
      group.global = target;
    } else if (target.scope === "project" && !group.project) {
      group.project = target;
    } else {
      group.extras.push(target);
    }
  }

  function renderScopeCell(target, scopeLabel) {
    if (!target) {
      return `<div class="assignment-scope is-empty" aria-hidden="true"><span class="scope-name">${escapeHtml(scopeLabel)}</span></div>`;
    }
    const status = target.skillStatuses[skill.id] || {};
    const pathText = status.linkPath || target.path || "";
    const toggleLabel = status.enabled ? "Disable" : "Enable";
    const classes = ["toggle", status.enabled ? "is-on" : "", status.conflict ? "conflict" : ""].filter(Boolean).join(" ");
    const note = status.conflict
      ? "Conflict"
      : status.staleManifest
        ? "Stale link"
        : status.enabled
          ? "Enabled"
          : "Disabled";
    const tooltip = pathText ? `${target.label} — ${pathText}` : target.label;
    return `
      <div class="assignment-scope" title="${escapeHtml(tooltip)}">
        <span class="scope-name">${escapeHtml(scopeLabel)}</span>
        <button
          class="${classes}"
          type="button"
          title="${escapeHtml(toggleLabel)} ${escapeHtml(skill.name)} in ${escapeHtml(target.label)}"
          data-skill-id="${escapeHtml(skill.id)}"
          data-detail-target-id="${escapeHtml(target.id)}"
          data-enabled="${status.enabled ? "true" : "false"}"
        ><span></span></button>
        <span class="scope-status">${escapeHtml(note)}</span>
      </div>
    `;
  }

  const assignmentRows = harnessOrder
    .map((harness) => {
      const group = harnessGroups.get(harness);
      const iconName = harnessIconName(harness);
      const cells = [
        renderScopeCell(group.global, "Global"),
        renderScopeCell(group.project, "Project"),
      ];
      const extras = group.extras
        .map((target) => renderScopeCell(target, target.scope === "global" ? "Global" : "Project"))
        .join("");
      return `
        <div class="assignment-row">
          <div class="assignment-label">
            <span class="assignment-harness-icon assignment-harness-icon--${escapeAttr(iconName.replace("harness-", ""))}">
              ${iconSprite(iconName, "icon")}
            </span>
            <strong>${escapeHtml(harness)}</strong>
          </div>
          <div class="assignment-scopes">${cells.join("")}${extras}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="skill-detail">
      <div class="detail-title-row">
        <div>
          <p class="eyebrow">${escapeHtml(skillType(skill))} / ${escapeHtml(skillAuthor(skill))}</p>
          <h2 class="section-title"><svg class="icon section-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-tool"></use></svg><span>${escapeHtml(skill.name)}</span></h2>
        </div>
        <button class="button ghost" data-copy-selected-path type="button">Copy path</button>
      </div>
      <p class="description">${escapeHtml(skill.description || "No description")}</p>
      <section class="assignment-panel" aria-label="Agent assignment">
        <h3>Agent Assignment</h3>
        <div class="assignment-list">${assignmentRows}</div>
      </section>
      <dl class="path-list">
        <div>
          <dt>Vault path</dt>
          <dd>${escapeHtml(skill.path)}</dd>
        </div>
        <div>
          <dt>Relative id</dt>
          <dd>${escapeHtml(skill.id)}</dd>
        </div>
      </dl>
      <div class="skill-editor-host" data-skill-editor-root>Loading editor...</div>
    </div>
  `;
}

function copySelectedSkillPath() {
  return runAction(async () => {
    const skill = selectedSkill();
    if (!skill) {
      return;
    }
    await navigator.clipboard.writeText(skill.path);
    showToast("Path copied");
  });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function filteredSkills() {
  const query = state.search.trim().toLowerCase();
  const filtered = state.data.skills.filter((skill) => {
    const type = skillType(skill);
    const matchesType = state.filterType === "all" || type === state.filterType;
    const enabledTargets = state.data.targets.filter((target) => target.skillStatuses[skill.id]?.enabled);
    const matchesTarget = state.filterTargetId === "all" || enabledTargets.some((target) => target.id === state.filterTargetId);
    const matchesStatus = state.filterStatus === "all"
      || (state.filterStatus === "enabled" && enabledTargets.length > 0)
      || (state.filterStatus === "disabled" && enabledTargets.length === 0);
    const haystack = `${skill.name} ${skill.description} ${skill.tags.join(" ")} ${skill.id} ${skillAuthor(skill)} ${type}`.toLowerCase();
    return matchesType && matchesTarget && matchesStatus && (!query || haystack.includes(query));
  });

  return filtered.sort((left, right) => {
    if (state.sortBy === "name-desc") {
      return right.name.localeCompare(left.name);
    }
    if (state.sortBy === "author-asc") {
      return skillAuthor(left).localeCompare(skillAuthor(right)) || left.name.localeCompare(right.name);
    }
    if (state.sortBy === "author-desc") {
      return skillAuthor(right).localeCompare(skillAuthor(left)) || left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name);
  });
}

function skillType(skill) {
  return skill.type || (Array.isArray(skill.tags) && skill.tags[0]) || "General";
}

function skillAuthor(skill) {
  return skill.author || (String(skill.id || "").split("/").filter(Boolean)[0] || "Local");
}

function activeFilterSummary() {
  const parts = [];
  if (state.filterTargetId !== "all") {
    const target = state.data.targets.find((item) => item.id === state.filterTargetId);
    if (target) parts.push(target.label);
  }
  if (state.filterStatus !== "all") parts.push(state.filterStatus === "enabled" ? "enabled" : "disabled");
  if (state.filterType !== "all") parts.push(state.filterType);
  return parts.length ? parts.join(" / ") : "All skills";
}

function selectedSkill() {
  return state.data?.skills.find((skill) => skill.id === state.selectedSkillId);
}

function selectedSkillIds() {
  return [...state.selectedSkillIds];
}

async function addProject() {
  await runAction(async () => {
    const projectPath = elements.projectAddInput.value.trim() || elements.projectInput.value.trim();
    if (!projectPath) {
      showToast("Project path is required");
      return;
    }
    applyState(await api("/api/projects/add", {
      method: "POST",
      body: {
        projectPath,
      },
    }));
    elements.projectAddInput.value = "";
    render();
    showToast("Project added");
  });
}

async function forgetProject(projectPath) {
  await runAction(async () => {
    removeCachedProject(projectPath);
    applyState(await api("/api/projects/remove", {
      method: "POST",
      body: {
        projectPath,
        currentProjectPath: elements.projectInput.value,
      },
    }));
    const projects = state.data?.projects || [];
    writeCachedProjects(projects);
    render();
    showToast("Project forgotten");
  });
}

async function clearScannedProjects() {
  await runAction(async () => {
    clearCachedProjects();
    applyState(await api("/api/projects/clear-scanned", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
      },
    }));
    const projects = state.data?.projects || [];
    writeCachedProjects(projects);
    render();
    showToast("Scanned projects cleared");
  });
}

async function scanProjects({ scoped } = { scoped: true }) {
  await runAction(async () => {
    const scanRoot = elements.projectScanRootInput.value.trim();
    if (scoped && !scanRoot) {
      showToast("Choose a folder to scan");
      return;
    }
    const result = await api("/api/projects/scan", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        roots: scoped ? [scanRoot] : undefined,
      },
    });
    applyState(result.state);
    render();
    const report = result.report || { discovered: 0, skipped: 0 };
    showToast(`Discovered ${report.discovered}, skipped ${report.skipped}`);
  });
}

async function bulkToggle(mode) {
  await runAction(async () => {
    const ids = selectedSkillIds();
    if (!ids.length) {
      showToast("Select skills first");
      return;
    }
    const result = await api("/api/bulk-toggle", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        targetId: elements.bulkTargetSelect.value,
        skillIds: ids,
        mode,
      },
    });
    applyState(result.state);
    render();
    showToast(`Changed ${result.changed.length}, errors ${result.errors.length}`);
  });
}

async function bulkCopy() {
  await runAction(async () => {
    const ids = selectedSkillIds();
    if (!ids.length) {
      showToast("Select skills first");
      return;
    }
    const result = await api("/api/bulk-copy", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        skillIds: ids,
        destinationPath: elements.bulkDestinationInput.value,
      },
    });
    applyState(result.state);
    render();
    showToast(`Copied ${result.copied.length}, errors ${result.errors.length}`);
  });
}

async function bulkMove() {
  await runAction(async () => {
    const ids = selectedSkillIds();
    if (!ids.length) {
      showToast("Select skills first");
      return;
    }
    const result = await api("/api/bulk-move", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        skillIds: ids,
        destinationPath: elements.bulkDestinationInput.value,
      },
    });
    applyState(result.state);
    render();
    showToast(`Moved ${result.moved.length}, errors ${result.errors.length}`);
  });
}

async function bulkDelete() {
  await runAction(async () => {
    const ids = selectedSkillIds();
    if (!ids.length) {
      showToast("Select skills first");
      return;
    }
    if (!window.confirm(`Delete ${ids.length} selected skill${ids.length === 1 ? "" : "s"} from the vault?`)) {
      return;
    }
    const result = await api("/api/bulk-delete", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
        skillIds: ids,
      },
    });
    applyState(result.state);
    state.selectedSkillIds.clear();
    render();
    showToast(`Deleted ${result.deleted.length}, errors ${result.errors.length}`);
  });
}

async function api(url, options = {}) {
  const response = await fetch(apiUrl(url), {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) {
    showToast(payload.error || "Request failed");
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function apiUrl(url) {
  const value = String(url);
  if (/^https?:\/\//.test(value)) {
    return value;
  }
  return isTauriDesktop() && value.startsWith("/api/")
    ? `${DESKTOP_API_ORIGIN}${value}`
    : value;
}

function isTauriDesktop() {
  return Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__) ||
    window.location.protocol === "tauri:" ||
    window.location.hostname === "tauri.localhost";
}

async function pickDirectoryInto(input) {
  await runAction(async () => {
    const result = await api("/api/pick-directory", { method: "POST" });
    if (result.path) {
      input.value = result.path;
    }
  });
}

async function runAction(action) {
  setBusy(true);
  try {
    await action();
  } catch (error) {
    showToast(error.message || "Action failed");
  } finally {
    setBusy(false);
  }
}

function showToast(message) {
  const tone = toastTone(message);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
}

function setBusy(isBusy) {
  setBusy.count = Math.max(0, (setBusy.count || 0) + (isBusy ? 1 : -1));
  const busy = setBusy.count > 0;
  elements.appShell.classList.toggle("is-busy", busy);
  elements.appShell.setAttribute("aria-busy", busy ? "true" : "false");
}

function toastTone(message) {
  const normalized = String(message || "").toLowerCase();
  if (/(fail|failed|error|required|choose|select|missing|warning|nothing)/.test(normalized)) {
    return "attention";
  }
  if (/(saved|created|moved|installed|enabled|disabled|loaded|copied|applied|updated|added|removed|deleted|merged|pinned|restored|cleared|discovered)/.test(normalized)) {
    return "success";
  }
  return "neutral";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ---------- Sets panel ---------- */

function clearChildren(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

function makeEl(tag, attrs = {}, text = "") {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    } else if (k === "hidden") {
      if (v) el.hidden = true;
    } else if (k === "disabled") {
      if (v) el.disabled = true;
    } else if (k === "checked") {
      if (v) el.checked = true;
    } else if (k === "selected") {
      if (v) el.selected = true;
    } else if (k === "value") {
      el.value = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  if (text !== "" && text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function summarizeTargets(entries) {
  return [...new Set(entries.map((e) => e.targetKey))].join(", ");
}

function setsScope() {
  return state.data && state.data.project && state.data.project.path ? "project" : "global";
}

async function loadSets() {
  const project = encodeURIComponent((state.data && state.data.project && state.data.project.path) || "");
  const result = await api(`/api/sets?project=${project}`);
  setsState.global = Array.isArray(result.global) ? result.global : [];
  setsState.project = Array.isArray(result.project) ? result.project : [];
  setsState.pinned = result.pinned || { ids: [], resolved: [], missing: [] };
  setsState.loaded = true;
}

function initSetsPanel() {
  const panel = document.querySelector('[data-top-tab-panel="sets"]');
  if (!panel) return;
  panel.addEventListener("click", async (event) => {
    const t = event.target.closest("[data-action], [data-sets-filter]");
    if (!t || !panel.contains(t)) return;
    if (t.dataset.setsFilter) {
      setsState.filter = t.dataset.setsFilter;
      renderSets();
      return;
    }
    const action = t.dataset.action;
    const id = t.dataset.id;
    if (action === "set-new") {
      setsState.draft = { id: null, name: "", description: "", scope: setsScope(), entries: [] };
      setsState.selectedId = null;
      renderSets();
    } else if (action === "set-edit") {
      const s = [...setsState.global, ...setsState.project].find((x) => x.id === id);
      if (!s) return;
      setsState.draft = {
        id: s.id,
        name: s.name,
        description: s.description || "",
        scope: s.scope,
        entries: (s.entries || []).map((e) => ({ skillName: e.skillName, targetKey: e.targetKey })),
      };
      setsState.selectedId = s.id;
      renderSets();
    } else if (action === "set-delete") {
      if (!window.confirm("Delete this set?")) return;
      await runAction(async () => {
        const project = encodeURIComponent((state.data && state.data.project && state.data.project.path) || "");
        await api(`/api/sets/${encodeURIComponent(id)}?project=${project}`, { method: "DELETE" });
        if (setsState.selectedId === id) {
          setsState.selectedId = null;
          setsState.draft = null;
        }
        await loadSets();
        renderSets();
        showToast("Set deleted");
      });
    } else if (action === "set-apply") {
      openApplyModal(id);
    } else if (action === "set-snapshot") {
      openSnapshotModal();
    } else if (action === "entry-add") {
      if (!setsState.draft) return;
      setsState.draft.entries.push({ skillName: "", targetKey: "" });
      renderSets();
    } else if (action === "entry-remove") {
      if (!setsState.draft) return;
      const idx = Number(t.dataset.index);
      if (Number.isFinite(idx)) {
        setsState.draft.entries.splice(idx, 1);
        renderSets();
      }
    } else if (action === "draft-revert") {
      setsState.draft = null;
      renderSets();
    } else if (action === "draft-save") {
      await runAction(saveDraft);
    }
  });
}

function renderSets() {
  const rowsEl = document.querySelector("[data-sets-rows]");
  const editorEl = document.querySelector("[data-sets-editor]");
  if (!rowsEl || !editorEl) return;

  // Sync filter chip active state.
  const panel = document.querySelector('[data-top-tab-panel="sets"]');
  if (panel) {
    panel.querySelectorAll("[data-sets-filter]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setsFilter === setsState.filter);
    });
  }

  clearChildren(rowsEl);

  const all = [
    ...setsState.global.map((s) => ({ ...s, _scope: "global" })),
    ...setsState.project.map((s) => ({ ...s, _scope: "project" })),
  ];
  const filtered = all.filter((s) => setsState.filter === "all" || s._scope === setsState.filter);

  if (filtered.length === 0) {
    rowsEl.appendChild(makeEl("li", { class: "muted set-row-empty" }, "No sets yet. Snapshot current links or create a set."));
  } else {
    for (const s of filtered) {
      const li = makeEl("li", {
        class: "set-row" + (s.id === setsState.selectedId ? " is-selected" : ""),
        dataset: { setId: s.id },
      });
      li.appendChild(makeEl("div", { class: "set-row-name" }, s.name));
      const meta = makeEl("div", { class: "set-row-meta" });
      meta.appendChild(makeEl("span", { class: `badge badge-${s._scope}` }, s._scope));
      const entryCount = (s.entries || []).length;
      meta.appendChild(makeEl("span", { class: "muted" }, `${entryCount} entr${entryCount === 1 ? "y" : "ies"}`));
      const targetSummary = summarizeTargets(s.entries || []);
      if (targetSummary) {
        meta.appendChild(makeEl("span", { class: "muted" }, targetSummary));
      }
      li.appendChild(meta);
      if (s.description) {
        li.appendChild(makeEl("div", { class: "set-row-description" }, s.description));
      }
      const actions = makeEl("div", { class: "set-row-actions" });
      actions.appendChild(makeEl("button", {
        type: "button", class: "button ghost", dataset: { action: "set-apply", id: s.id },
      }, "Apply"));
      actions.appendChild(makeEl("button", {
        type: "button", class: "button ghost", dataset: { action: "set-edit", id: s.id },
      }, "Edit"));
      actions.appendChild(makeEl("button", {
        type: "button", class: "button ghost", dataset: { action: "set-delete", id: s.id },
      }, "Delete"));
      li.appendChild(actions);
      rowsEl.appendChild(li);
    }
  }

  clearChildren(editorEl);
  if (!setsState.draft && !setsState.selectedId) {
    editorEl.appendChild(makeEl("p", { class: "muted" }, "Select a set on the left, or create a new one."));
    return;
  }
  if (!setsState.draft && setsState.selectedId) {
    const s = [...setsState.global, ...setsState.project].find((x) => x.id === setsState.selectedId);
    if (!s) {
      editorEl.appendChild(makeEl("p", { class: "muted" }, "Select a set on the left, or create a new one."));
      return;
    }
    renderSetReadOnly(editorEl, s);
    return;
  }
  renderSetEditor(editorEl);
}

function renderSetReadOnly(editorEl, s) {
  const head = makeEl("div", { class: "sets-editor-head" });
  head.appendChild(makeEl("h3", { class: "sets-editor-title" }, s.name));
  head.appendChild(makeEl("span", { class: `badge badge-${s.scope}` }, s.scope));
  editorEl.appendChild(head);

  if (s.description) {
    editorEl.appendChild(makeEl("p", { class: "set-description" }, s.description));
  }

  if (!s.entries || s.entries.length === 0) {
    editorEl.appendChild(makeEl("p", { class: "muted" }, "No entries yet."));
  } else {
    const list = makeEl("ul", { class: "set-entry-readlist" });
    for (const e of s.entries) {
      const li = makeEl("li", { class: "set-entry-readrow" });
      li.appendChild(makeEl("strong", {}, e.skillName));
      li.appendChild(makeEl("span", { class: "muted" }, ` → ${e.targetKey}`));
      list.appendChild(li);
    }
    editorEl.appendChild(list);
  }

  const footer = makeEl("div", { class: "sets-editor-footer" });
  footer.appendChild(makeEl("button", {
    type: "button", class: "button", dataset: { action: "set-edit", id: s.id },
  }, "Edit"));
  editorEl.appendChild(footer);
}

function renderSetEditor(editorEl) {
  const draft = setsState.draft;
  if (!draft) return;
  const form = makeEl("form", { class: "set-editor-form" });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runAction(saveDraft);
  });

  const head = makeEl("div", { class: "sets-editor-head" });
  head.appendChild(makeEl("h3", { class: "sets-editor-title" }, draft.id ? "Edit set" : "New set"));
  if (draft.id) {
    head.appendChild(makeEl("span", { class: `badge badge-${draft.scope}` }, draft.scope));
  }
  form.appendChild(head);

  const nameField = makeEl("label", { class: "set-field" });
  nameField.appendChild(makeEl("span", {}, "Name"));
  const nameInput = makeEl("input", {
    type: "text",
    value: draft.name || "",
    placeholder: "e.g. Daily TDD",
    autocomplete: "off",
  });
  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
  });
  nameField.appendChild(nameInput);
  form.appendChild(nameField);

  const descriptionField = makeEl("label", { class: "set-field" });
  descriptionField.appendChild(makeEl("span", {}, "Description"));
  const descriptionInput = makeEl("textarea", {
    placeholder: "When should an agent activate this set?",
    rows: "3",
  });
  descriptionInput.value = draft.description || "";
  descriptionInput.addEventListener("input", () => {
    draft.description = descriptionInput.value;
  });
  descriptionField.appendChild(descriptionInput);
  form.appendChild(descriptionField);

  // Scope: toggle when creating, locked when editing.
  const scopeField = makeEl("div", { class: "set-field" });
  scopeField.appendChild(makeEl("span", {}, "Scope"));
  if (draft.id) {
    scopeField.appendChild(makeEl("span", { class: `badge badge-${draft.scope}` }, draft.scope));
  } else {
    const scopeWrap = makeEl("div", { class: "set-scope-toggle" });
    const globalBtn = makeEl("button", {
      type: "button",
      class: "chip" + (draft.scope === "global" ? " is-active" : ""),
    }, "Global");
    globalBtn.addEventListener("click", () => {
      draft.scope = "global";
      renderSets();
    });
    scopeWrap.appendChild(globalBtn);
    const hasProject = !!(state.data && state.data.project && state.data.project.path);
    const projectBtn = makeEl("button", {
      type: "button",
      class: "chip" + (draft.scope === "project" ? " is-active" : ""),
    }, "Project");
    if (!hasProject) {
      projectBtn.disabled = true;
      projectBtn.title = "Load a project first";
    }
    projectBtn.addEventListener("click", () => {
      if (!hasProject) return;
      draft.scope = "project";
      renderSets();
    });
    scopeWrap.appendChild(projectBtn);
    scopeField.appendChild(scopeWrap);
  }
  form.appendChild(scopeField);

  // Entries.
  const entriesWrap = makeEl("div", { class: "set-entries" });
  entriesWrap.appendChild(makeEl("div", { class: "set-entries-head" }, "Entries"));
  const skills = (state.data && state.data.skills) || [];
  const targets = (state.data && state.data.targets) || [];

  if (draft.entries.length === 0) {
    entriesWrap.appendChild(makeEl("p", { class: "muted" }, "No entries yet. Add some below."));
  } else {
    const table = makeEl("ul", { class: "set-entry-list" });
    draft.entries.forEach((entry, idx) => {
      const row = makeEl("li", { class: "set-entry-row" });

      const skillSel = makeEl("select", { class: "set-entry-skill" });
      skillSel.appendChild(makeEl("option", { value: "" }, "— skill —"));
      for (const sk of skills) {
        const opt = makeEl("option", { value: sk.name }, sk.name);
        if (entry.skillName === sk.name) opt.selected = true;
        skillSel.appendChild(opt);
      }
      skillSel.addEventListener("change", () => {
        entry.skillName = skillSel.value;
      });
      row.appendChild(skillSel);

      const targetSel = makeEl("select", { class: "set-entry-target" });
      targetSel.appendChild(makeEl("option", { value: "" }, "— target —"));
      for (const tg of targets) {
        const opt = makeEl("option", { value: tg.id }, tg.label);
        if (entry.targetKey === tg.id) opt.selected = true;
        targetSel.appendChild(opt);
      }
      targetSel.addEventListener("change", () => {
        entry.targetKey = targetSel.value;
      });
      row.appendChild(targetSel);

      row.appendChild(makeEl("button", {
        type: "button",
        class: "button ghost",
        dataset: { action: "entry-remove", index: String(idx) },
      }, "Remove"));

      table.appendChild(row);
    });
    entriesWrap.appendChild(table);
  }

  const addBtn = makeEl("button", {
    type: "button",
    class: "button",
    dataset: { action: "entry-add" },
  }, "Add entry");
  entriesWrap.appendChild(addBtn);
  form.appendChild(entriesWrap);

  const footer = makeEl("div", { class: "sets-editor-footer" });
  footer.appendChild(makeEl("button", {
    type: "submit",
    class: "button primary",
  }, "Save"));
  footer.appendChild(makeEl("button", {
    type: "button",
    class: "button ghost",
    dataset: { action: "draft-revert" },
  }, "Revert"));
  form.appendChild(footer);

  editorEl.appendChild(form);
}

async function saveDraft() {
  const draft = setsState.draft;
  if (!draft) return;
  const name = (draft.name || "").trim();
  if (!name) {
    showToast("Name is required");
    return;
  }
  const entries = draft.entries.filter((e) => e.skillName && e.targetKey);
  const projectPath = (state.data && state.data.project && state.data.project.path) || "";
  const description = (draft.description || "").trim();
  const payload = draft.id
    ? { name, description, entries }
    : {
        name,
        description,
        scope: draft.scope,
        projectPath: draft.scope === "project" ? projectPath : undefined,
        entries,
      };
  if (draft.id && draft.scope === "project") {
    payload.projectPath = projectPath;
  }
  const url = draft.id ? `/api/sets/${encodeURIComponent(draft.id)}` : "/api/sets";
  const method = draft.id ? "PATCH" : "POST";
  const result = await api(url, {
    method,
    body: payload,
  });
  setsState.draft = null;
  setsState.selectedId = result.set ? result.set.id : null;
  await loadSets();
  renderSets();
  showToast(draft.id ? "Set updated" : "Set created");
}

function openSnapshotModal() {
  // Close any existing modal first.
  const existing = document.querySelector("dialog[data-snapshot-modal]");
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const dialog = makeEl("dialog", { class: "snapshot-modal", "aria-labelledby": "sets-snapshot-title", dataset: { snapshotModal: "true" } });
  const form = makeEl("form", { class: "snapshot-form", method: "dialog" });

  form.appendChild(makeEl("h3", { id: "sets-snapshot-title", class: "snapshot-title" }, "Snapshot current state"));

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const defaultName = `Snapshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const nameField = makeEl("label", { class: "set-field" });
  nameField.appendChild(makeEl("span", {}, "Name"));
  const nameInput = makeEl("input", {
    type: "text",
    value: defaultName,
    required: "true",
    autocomplete: "off",
    autofocus: "true",
  });
  nameField.appendChild(nameInput);
  form.appendChild(nameField);

  const descriptionField = makeEl("label", { class: "set-field" });
  descriptionField.appendChild(makeEl("span", {}, "Description"));
  const descriptionInput = makeEl("textarea", {
    placeholder: "When should an agent activate this snapshot?",
    rows: "3",
  });
  descriptionField.appendChild(descriptionInput);
  form.appendChild(descriptionField);

  const hasProject = !!(state.data && state.data.project && state.data.project.path);
  const scopeField = makeEl("fieldset", { class: "set-field snapshot-scope" });
  scopeField.appendChild(makeEl("legend", {}, "Save as"));
  const scopeGlobalLabel = makeEl("label", { class: "snapshot-scope-option" });
  const scopeGlobalInput = makeEl("input", { type: "radio", name: "snapshot-scope", value: "global", checked: true });
  scopeGlobalLabel.appendChild(scopeGlobalInput);
  scopeGlobalLabel.appendChild(makeEl("span", {}, "Global"));
  scopeField.appendChild(scopeGlobalLabel);
  const scopeProjectLabel = makeEl("label", { class: "snapshot-scope-option" });
  const scopeProjectInput = makeEl("input", { type: "radio", name: "snapshot-scope", value: "project" });
  if (!hasProject) scopeProjectInput.disabled = true;
  scopeProjectLabel.appendChild(scopeProjectInput);
  scopeProjectLabel.appendChild(makeEl("span", {}, hasProject ? "Project" : "Project (load one first)"));
  scopeField.appendChild(scopeProjectLabel);
  form.appendChild(scopeField);

  const targetsField = makeEl("fieldset", { class: "set-field snapshot-targets" });
  targetsField.appendChild(makeEl("legend", {}, "Targets to snapshot"));
  const targets = (state.data && state.data.targets) || [];
  if (targets.length === 0) {
    targetsField.appendChild(makeEl("p", { class: "muted" }, "No targets available."));
  } else {
    for (const tg of targets) {
      const optLabel = makeEl("label", { class: "snapshot-target-option" });
      const cb = makeEl("input", { type: "checkbox", value: tg.id });
      optLabel.appendChild(cb);
      optLabel.appendChild(makeEl("span", {}, tg.label));
      targetsField.appendChild(optLabel);
    }
  }
  form.appendChild(targetsField);

  const footer = makeEl("div", { class: "sets-editor-footer" });
  const confirmBtn = makeEl("button", { type: "button", class: "button primary" }, "Save snapshot");
  const cancelBtn = makeEl("button", { type: "button", class: "button ghost" }, "Cancel");
  footer.appendChild(confirmBtn);
  footer.appendChild(cancelBtn);
  form.appendChild(footer);
  dialog.appendChild(form);

  document.body.appendChild(dialog);

  const close = () => {
    if (dialog.open) dialog.close();
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
  };

  cancelBtn.addEventListener("click", close);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });

  confirmBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast("Name is required");
      return;
    }
    const scope = scopeProjectInput.checked ? "project" : "global";
    const targetKeys = Array.from(targetsField.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
    if (targetKeys.length === 0) {
      showToast("Pick at least one target");
      return;
    }
    const projectPath = (state.data && state.data.project && state.data.project.path) || "";
    const payload = {
      name,
      description: descriptionInput.value.trim(),
      scope,
      targetKeys,
    };
    if (scope === "project") payload.projectPath = projectPath;

    await runAction(async () => {
      const result = await api("/api/sets/snapshot", {
        method: "POST",
        body: payload,
      });
      close();
      setsState.selectedId = result.set ? result.set.id : null;
      setsState.draft = null;
      await loadSets();
      renderSets();
      showToast("Snapshot saved");
    });
  });

  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function renderDrift() {
  const el = document.querySelector("[data-drift]");
  if (!el) return;
  if (!lastAppliedSet) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = `Applied: ${lastAppliedSet.name}${lastAppliedSet.modified ? " (modified)" : ""}`;
}

async function openApplyModal(setId) {
  pendingApplySetId = setId;
  const modal = document.querySelector('[data-modal="apply-set"]');
  if (!modal) return;
  const body = modal.querySelector("[data-apply-body]");
  const title = modal.querySelector("[data-apply-title]");
  const confirm = modal.querySelector('[data-action="apply-confirm"]');
  confirm.disabled = true;
  clearChildren(body);
  body.appendChild(makeEl("p", { class: "muted" }, "Computing plan…"));
  if (typeof modal.showModal === "function" && !modal.open) {
    modal.showModal();
  } else if (!modal.open) {
    modal.setAttribute("open", "");
  }

  const projectPath = (state.data && state.data.project && state.data.project.path) || "";
  let plan;
  try {
    plan = await api(`/api/sets/${encodeURIComponent(setId)}/plan`, {
      method: "POST",
      body: { projectPath },
    });
  } catch (error) {
    clearChildren(body);
    body.appendChild(makeEl("p", { class: "muted" }, error.message || "Failed to load plan"));
    return;
  }

  title.textContent = `Apply set: ${plan.name}`;
  clearChildren(body);

  if (!plan.targets || plan.targets.length === 0) {
    body.appendChild(makeEl("p", { class: "muted" }, "This set has no entries — nothing to apply."));
    return;
  }

  for (const t of plan.targets) {
    const section = makeEl("section", { class: "apply-target" });
    section.appendChild(makeEl("h3", {}, t.targetLabel || t.targetId));
    const list = makeEl("ul", { class: "apply-list" });
    if (t.missingTarget) {
      list.appendChild(makeEl("li", { class: "apply-warn" }, `⚠ target not available: ${t.targetId}`));
    }
    for (const n of t.toEnable || []) list.appendChild(makeEl("li", { class: "apply-add" }, `+ ${n}`));
    for (const n of t.toDisable || []) list.appendChild(makeEl("li", { class: "apply-rm" }, `− ${n}`));
    for (const n of t.missing || []) list.appendChild(makeEl("li", { class: "apply-warn" }, `⚠ missing skill: ${n}`));
    if (!t.missingTarget && (t.toEnable || []).length === 0 && (t.toDisable || []).length === 0 && (t.missing || []).length === 0) {
      list.appendChild(makeEl("li", { class: "muted" }, "Already up to date."));
    }
    section.appendChild(list);
    body.appendChild(section);
  }
  confirm.disabled = false;
}

function closeApplyModal() {
  const modal = document.querySelector('[data-modal="apply-set"]');
  if (modal && modal.open) modal.close();
  pendingApplySetId = null;
}

// Global delegated handlers for apply modal, project pinned-sets, etc.
document.addEventListener("click", async (event) => {
  const t = event.target.closest("[data-action]");
  if (!t) return;
  const action = t.dataset.action;

  if (action === "apply-cancel") {
    closeApplyModal();
    return;
  }

  if (action === "apply-confirm" && pendingApplySetId) {
    t.disabled = true;
    try {
      const setId = pendingApplySetId;
      await runAction(async () => {
        const projectPath = (state.data && state.data.project && state.data.project.path) || "";
        const result = await api(`/api/sets/${encodeURIComponent(setId)}/apply`, {
          method: "POST",
          body: { projectPath },
        });
        applyState(result.state);
        lastAppliedSet = {
          id: setId,
          name: (result.plan && result.plan.name) || "",
          touchedTargets: ((result.plan && result.plan.targets) || []).map((tt) => tt.targetId),
          modified: false,
        };
        closeApplyModal();
        render();
        const warnings = (result.warnings || []).length;
        showToast(warnings ? `Applied with ${warnings} warning${warnings === 1 ? "" : "s"}` : "Set applied");
      });
    } finally {
      t.disabled = false;
    }
    return;
  }

  if (action === "unpin-set") {
    const setId = t.dataset.id;
    if (!setId) return;
    await runAction(async () => {
      const projectPath = (state.data && state.data.project && state.data.project.path) || "";
      if (!projectPath) return;
      const nextIds = ((setsState.pinned && setsState.pinned.ids) || []).filter((x) => x !== setId);
      await api("/api/projects/pinned-sets", {
        method: "POST",
        body: { projectPath, setIds: nextIds },
      });
      await loadSets();
      renderProjectPinnedControls();
      showToast("Set unpinned");
    });
  }
});

document.addEventListener("change", async (event) => {
  const t = event.target.closest("[data-action]");
  if (!t) return;
  const action = t.dataset.action;

  if (action === "pin-set") {
    const setId = t.value;
    if (!setId) return;
    await runAction(async () => {
      const projectPath = (state.data && state.data.project && state.data.project.path) || "";
      if (!projectPath) {
        showToast("Load a project first");
        t.value = "";
        return;
      }
      const currentIds = ((setsState.pinned && setsState.pinned.ids) || []).slice();
      if (currentIds.includes(setId)) {
        t.value = "";
        return;
      }
      currentIds.push(setId);
      await api("/api/projects/pinned-sets", {
        method: "POST",
        body: { projectPath, setIds: currentIds },
      });
      await loadSets();
      renderProjectPinnedControls();
      showToast("Set pinned");
    });
    return;
  }

  if (action === "apply-pinned-set") {
    const setId = t.value;
    if (!setId) return;
    t.value = "";
    openApplyModal(setId);
  }
});

document.addEventListener("cancel", (event) => {
  const modal = event.target;
  if (modal && modal.dataset && modal.dataset.modal === "apply-set") {
    event.preventDefault();
    closeApplyModal();
  }
});
