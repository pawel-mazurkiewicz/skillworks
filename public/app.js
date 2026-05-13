const PROJECT_CACHE_KEY = "asm.projects";

const state = {
  data: null,
  selectedSkillId: null,
  selectedSkillIds: new Set(),
  activeTag: "All",
  activeSideTab: "manage",
  search: "",
};

const elements = {
  sideTabs: document.querySelectorAll("[data-side-tab]"),
  managePanel: document.querySelector("#managePanel"),
  installPanel: document.querySelector("#installPanel"),
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
};

bootstrap();

async function bootstrap() {
  elements.sideTabs.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeSideTab = button.dataset.sideTab;
      renderSideTabs();
    });
  });

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
    renderInstallPreview(plan);
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
      const result = await api("/api/install-git", {
        method: "POST",
        body: {
          repoUrl,
          ref: elements.gitRefInput.value.trim(),
          targetIds,
          projectPath: elements.projectInput.value,
        },
      });
      applyState(result.state);
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
  renderSideTabs();
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

function renderInstallPreview(plan) {
  if (!plan || !Array.isArray(plan.candidates)) {
    elements.gitPreviewResult.hidden = true;
    elements.gitPreviewResult.innerHTML = "";
    return;
  }

  const summary = plan.summary;
  const rows = plan.candidates
    .map((candidate) => {
      const actionLabel = candidate.action === "move"
        ? `Move to <code>${escapeHtml(candidate.vaultDestination)}</code>`
        : candidate.action === "dedupe"
          ? `Dedupe against <code>${escapeHtml(candidate.vaultDestination)}</code>`
          : `Skip: ${escapeHtml(candidate.skipReason || "")}`;
      const links = candidate.targetLinks
        .map((link) => `<li>${escapeHtml(link.targetLabel)} &rarr; <code>${escapeHtml(link.linkPath)}</code></li>`)
        .join("");
      return `
        <article class="preview-item">
          <header>
            <strong>${escapeHtml(candidate.name)}</strong>
            <span class="preview-action preview-action-${escapeHtml(candidate.action)}">${escapeHtml(candidate.action)}</span>
          </header>
          <div class="preview-detail">${actionLabel}</div>
          <div class="preview-source">From: <code>${escapeHtml(candidate.sourcePath)}</code></div>
          ${links ? `<ul class="preview-links">${links}</ul>` : `<p class="empty-copy">No target links.</p>`}
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
    </div>
    <div class="preview-list">${rows || `<p class="empty-copy">No skills discovered.</p>`}</div>
  `;
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

function renderSideTabs() {
  elements.sideTabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.sideTab === state.activeSideTab);
  });
  elements.managePanel.classList.toggle("hidden", state.activeSideTab !== "manage");
  elements.installPanel.classList.toggle("hidden", state.activeSideTab !== "install");
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
