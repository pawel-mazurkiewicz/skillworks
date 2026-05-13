const PROJECT_CACHE_KEY = "asm.projects";

const state = {
  data: null,
  selectedSkillId: null,
  selectedSkillIds: new Set(),
  activeTag: "All",
  activeTopTab: "manage",
  search: "",
  preview: null,
  dedupe: null,
  dedupeChoices: new Map(),
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

const elements = {
  topTabs: document.querySelectorAll("[data-top-tab]"),
  tabPanels: document.querySelectorAll("[data-top-tab-panel]"),
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
  createSkillForm: document.querySelector("#createSkillForm"),
  newSkillName: document.querySelector("#newSkillName"),
  newSkillDescription: document.querySelector("#newSkillDescription"),
  gitInstallForm: document.querySelector("#gitInstallForm"),
  gitRepoInput: document.querySelector("#gitRepoInput"),
  gitRefInput: document.querySelector("#gitRefInput"),
  gitTargetCheckboxes: document.querySelector("#gitTargetCheckboxes"),
  gitPreviewButton: document.querySelector("#gitPreviewButton"),
  gitPreviewResult: document.querySelector("#gitPreviewResult"),
  searchInput: document.querySelector("#searchInput"),
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
  addProjectButton: document.querySelector("#addProjectButton"),
  scanProjectsButton: document.querySelector("#scanProjectsButton"),
  projectList: document.querySelector("#projectList"),
  customTargetForm: document.querySelector("#customTargetForm"),
  customTargetId: document.querySelector("#customTargetId"),
  customTargetLabel: document.querySelector("#customTargetLabel"),
  customTargetHarness: document.querySelector("#customTargetHarness"),
  customTargetScope: document.querySelector("#customTargetScope"),
  customTargetPath: document.querySelector("#customTargetPath"),
  customTargetList: document.querySelector("#customTargetList"),
  tagFilters: document.querySelector("#tagFilters"),
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
      }
    });
  });
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

  elements.createSkillForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      const name = elements.newSkillName.value.trim();
      if (!name) {
        showToast("Skill name is required");
        return;
      }
      applyState(await api("/api/create-skill", {
        method: "POST",
        body: {
          name,
          description: elements.newSkillDescription.value.trim(),
          projectPath: elements.projectInput.value,
        },
      }));
      elements.newSkillName.value = "";
      elements.newSkillDescription.value = "";
      render();
      showToast("Skill created");
    });
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
  elements.scanProjectsButton.addEventListener("click", () => scanProjects());
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

  elements.copyPathButton.addEventListener("click", () => runAction(async () => {
    const skill = selectedSkill();
    if (!skill) {
      return;
    }
    await navigator.clipboard.writeText(skill.path);
    showToast("Path copied");
  }));

  elements.projectInput.value = localStorage.getItem("asm.projectPath") || "";
  await runAction(() => loadState());
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
  render();
}

function applyState(nextData) {
  const cachedProjects = readCachedProjects();
  const serverProjects = normalizeProjectCache(nextData?.projects || []);
  const projects = mergeProjects(serverProjects, cachedProjects);

  state.data = {
    ...nextData,
    projects,
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
  renderDiscovery();
  renderInstallTargets();
  renderBulkTargets();
  renderBulkBar();
  renderTopTabs();
  renderUnmanaged();
  renderTargets();
  renderTags();
  renderMatrix();
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
              <strong>${escapeHtml(project.name)}</strong>
              <span>${escapeHtml(project.source)} / ${project.skillSourceCount || 0} skill source${project.skillSourceCount === 1 ? "" : "s"}</span>
            </div>
            <button class="button ghost" type="button" data-load-project="${escapeHtml(project.path)}">Load</button>
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
              <strong>${escapeHtml(target.label)}</strong>
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
            <strong>${escapeHtml(source.label)}</strong>
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
      `<legend>Install to (vault by default; pick any extra targets)</legend>` +
      `<p class="empty-copy">No targets available.</p>`;
    return;
  }
  const previouslyChecked = new Set(
    Array.from(elements.gitTargetCheckboxes.querySelectorAll("input[type=checkbox]:checked")).map((input) => input.value),
  );
  const items = targets
    .map((target) => {
      const checked = previouslyChecked.has(target.id) ? "checked" : "";
      return `
        <label class="target-checkbox">
          <input type="checkbox" value="${escapeHtml(target.id)}" ${checked} />
          <span>${escapeHtml(target.label)}</span>
        </label>
      `;
    })
    .join("");
  elements.gitTargetCheckboxes.innerHTML =
    `<legend>Install to (vault by default; pick any extra targets)</legend>${items}`;
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
  elements.bulkSelectedCount.textContent = `${count} selected`;
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
    button.disabled = disabled;
  });
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

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function renderTargets() {
  elements.targetStrip.innerHTML = state.data.targets
    .map((target) => {
      const unmanaged = target.unmanaged.length ? `${target.unmanaged.length} unmanaged` : "clean";
      return `
        <article class="target-card">
          <strong>${escapeHtml(target.label)}</strong>
          <span>${target.enabledSkillIds.length} linked, ${escapeHtml(unmanaged)}</span>
          <small title="${escapeHtml(target.path)}">${escapeHtml(target.path)}</small>
        </article>
      `;
    })
    .join("");
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
  const tags = new Set(["All"]);
  for (const skill of state.data.skills) {
    for (const tag of skill.tags) {
      tags.add(tag);
    }
  }

  elements.tagFilters.innerHTML = [...tags]
    .map(
      (tag) => `
        <button class="segment ${tag === state.activeTag ? "active" : ""}" type="button" data-tag="${escapeHtml(tag)}">
          ${escapeHtml(tag)}
        </button>
      `,
    )
    .join("");

  elements.tagFilters.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTag = button.dataset.tag;
      renderTags();
      renderMatrix();
    });
  });
}

function renderMatrix() {
  const targets = state.data.targets;
  const skills = filteredSkills();
  const visibleSkillIds = skills.map((skill) => skill.id);
  const allVisibleSelected = visibleSkillIds.length > 0 && visibleSkillIds.every((id) => state.selectedSkillIds.has(id));

  elements.matrixHead.innerHTML = `
    <tr>
      <th class="checkbox-cell">
        <input type="checkbox" id="selectVisibleCheckbox" ${allVisibleSelected ? "checked" : ""} aria-label="Select visible skills" />
      </th>
      <th>Skill</th>
      ${targets.map((target) => `<th title="${escapeHtml(target.label)}">${escapeHtml(target.shortLabel)}</th>`).join("")}
    </tr>
  `;

  if (!skills.length) {
    elements.matrixBody.innerHTML = `<tr><td class="empty-state" colspan="${targets.length + 2}">No skills match the current filter.</td></tr>`;
    bindSelectVisible(visibleSkillIds);
    return;
  }

  elements.matrixBody.innerHTML = skills
    .map((skill) => {
      const cells = targets
        .map((target) => {
          const status = target.skillStatuses[skill.id];
          const label = status.enabled ? "Disable" : "Enable";
          const classes = ["toggle", status.enabled ? "is-on" : "", status.conflict ? "conflict" : ""].filter(Boolean).join(" ");
          return `
            <td>
              <button
                class="${classes}"
                type="button"
                title="${escapeHtml(label)} ${escapeHtml(skill.name)} in ${escapeHtml(target.label)}"
                data-skill-id="${escapeHtml(skill.id)}"
                data-target-id="${escapeHtml(target.id)}"
                data-enabled="${status.enabled ? "true" : "false"}"
              ><span></span></button>
            </td>
          `;
        })
        .join("");

      return `
        <tr class="${skill.id === state.selectedSkillId ? "selected-row" : ""}">
          <td class="checkbox-cell">
            <input
              type="checkbox"
              aria-label="Select ${escapeHtml(skill.name)}"
              data-select-row="${escapeHtml(skill.id)}"
              ${state.selectedSkillIds.has(skill.id) ? "checked" : ""}
            />
          </td>
          <td class="skill-cell">
            <div class="skill-name">
              <button type="button" data-select-skill="${escapeHtml(skill.id)}">${escapeHtml(skill.name)}</button>
            </div>
            <div class="skill-description">${escapeHtml(skill.description || "No description")}</div>
            <div class="tag-row">
              ${skill.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
            </div>
          </td>
          ${cells}
        </tr>
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
      renderBulkBar();
    });
  });

  elements.matrixBody.querySelectorAll("[data-select-skill]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedSkillId = button.dataset.selectSkill;
      await renderDetail();
      renderMatrix();
    });
  });

  elements.matrixBody.querySelectorAll("[data-target-id]").forEach((button) => {
    button.addEventListener("click", () => runAction(async () => {
      const nextEnabled = button.dataset.enabled !== "true";
      applyState(await api("/api/toggle", {
        method: "POST",
        body: {
          projectPath: elements.projectInput.value,
          targetId: button.dataset.targetId,
          skillId: button.dataset.skillId,
          enabled: nextEnabled,
        },
      }));
      render();
      showToast(nextEnabled ? "Skill enabled" : "Skill disabled");
    }));
  });
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
    renderBulkBar();
  });
}

async function renderDetail() {
  const skill = selectedSkill();
  if (!skill) {
    elements.emptyDetail.classList.remove("hidden");
    elements.skillDetail.classList.add("hidden");
    return;
  }

  elements.emptyDetail.classList.add("hidden");
  elements.skillDetail.classList.remove("hidden");
  elements.detailTags.textContent = skill.tags.join(" / ");
  elements.detailName.textContent = skill.name;
  elements.detailDescription.textContent = skill.description || "No description";
  elements.detailPath.textContent = skill.path;
  elements.detailId.textContent = skill.id;

  const links = state.data.targets
    .map((target) => ({ target, status: target.skillStatuses[skill.id] }))
    .filter((item) => item.status.enabled || item.status.conflict || item.status.staleManifest);

  elements.detailLinks.innerHTML = links.length
    ? links
        .map(
          ({ target, status }) => `
            <div class="link-pill">
              <strong>${escapeHtml(target.label)}${status.conflict ? " conflict" : ""}${status.staleManifest ? " stale" : ""}</strong>
              <span>${escapeHtml(status.linkPath)}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="link-pill"><strong>Not linked</strong><span>No active target links for this skill.</span></div>`;

  const preview = await api(`/api/skill?id=${encodeURIComponent(skill.id)}`);
  elements.skillPreview.textContent = preview.content.slice(0, 2200);
}

function filteredSkills() {
  const query = state.search.trim().toLowerCase();
  return state.data.skills.filter((skill) => {
    const matchesTag = state.activeTag === "All" || skill.tags.includes(state.activeTag);
    const haystack = `${skill.name} ${skill.description} ${skill.tags.join(" ")} ${skill.id}`.toLowerCase();
    return matchesTag && (!query || haystack.includes(query));
  });
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

async function scanProjects() {
  await runAction(async () => {
    const result = await api("/api/projects/scan", {
      method: "POST",
      body: {
        projectPath: elements.projectInput.value,
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
  const response = await fetch(url, {
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

async function pickDirectoryInto(input) {
  await runAction(async () => {
    const result = await api("/api/pick-directory", { method: "POST" });
    if (result.path) {
      input.value = result.path;
    }
  });
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    showToast(error.message || "Action failed");
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2600);
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
  const response = await fetch(`/api/sets?project=${project}`);
  const result = await response.json();
  if (!response.ok) {
    showToast(result.error || "Failed to load sets");
    return;
  }
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
      setsState.draft = { id: null, name: "", scope: setsScope(), entries: [] };
      setsState.selectedId = null;
      renderSets();
    } else if (action === "set-edit") {
      const s = [...setsState.global, ...setsState.project].find((x) => x.id === id);
      if (!s) return;
      setsState.draft = {
        id: s.id,
        name: s.name,
        scope: s.scope,
        entries: (s.entries || []).map((e) => ({ skillName: e.skillName, targetKey: e.targetKey })),
      };
      setsState.selectedId = s.id;
      renderSets();
    } else if (action === "set-delete") {
      if (!window.confirm("Delete this set?")) return;
      await runAction(async () => {
        const project = encodeURIComponent((state.data && state.data.project && state.data.project.path) || "");
        const response = await fetch(`/api/sets/${encodeURIComponent(id)}?project=${project}`, { method: "DELETE" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          showToast(payload.error || "Delete failed");
          return;
        }
        if (setsState.selectedId === id) {
          setsState.selectedId = null;
          setsState.draft = null;
        }
        await loadSets();
        renderSets();
        showToast("Set deleted");
      });
    } else if (action === "set-apply") {
      // Task 11 will wire this; leave a stub for now.
      console.log("apply pending", id);
      showToast("Apply coming in next task");
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
    rowsEl.appendChild(makeEl("li", { class: "muted set-row-empty" }, "No sets yet."));
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
  const payload = draft.id
    ? { name, entries }
    : {
        name,
        scope: draft.scope,
        projectPath: draft.scope === "project" ? projectPath : undefined,
        entries,
      };
  if (draft.id && draft.scope === "project") {
    payload.projectPath = projectPath;
  }
  const url = draft.id ? `/api/sets/${encodeURIComponent(draft.id)}` : "/api/sets";
  const method = draft.id ? "PATCH" : "POST";
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    showToast(result.error || "Save failed");
    return;
  }
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
      scope,
      targetKeys,
    };
    if (scope === "project") payload.projectPath = projectPath;

    await runAction(async () => {
      const response = await fetch("/api/sets/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast(result.error || "Snapshot failed");
        return;
      }
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
