const THEME_KEY = "markdownkit.theme";
const RELOAD_KEY = "markdownkit.liveReload";
const FRONTMATTER_KEY = "markdownkit.showFrontmatter";

const emptyEl = document.getElementById("empty");
const pageEl = document.getElementById("page");
const contentEl = document.getElementById("content");
const propsEl = document.getElementById("props");
const toastEl = document.getElementById("toast");
const openButton = document.getElementById("open-button");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const settingsEl = document.getElementById("settings");
const liveReloadEl = document.getElementById("live-reload");
const showFrontmatterEl = document.getElementById("show-frontmatter");

let currentPath = null;
let lastFrontmatter = [];
let toastTimer = 0;
const historyStack = [];
let historyIndex = -1;

function api() {
  return window.__TAURI__;
}

function currentTheme() {
  return document.documentElement.dataset.theme || "system";
}

function applyTheme(theme) {
  const next = ["system", "light", "dark"].includes(theme) ? theme : "system";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  for (const button of document.querySelectorAll(".seg [data-theme]")) {
    button.setAttribute("aria-pressed", String(button.dataset.theme === next));
  }
  renderMermaid(contentEl);
}

function liveReloadEnabled() {
  try {
    const stored = localStorage.getItem(RELOAD_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function showFrontmatterEnabled() {
  try {
    const stored = localStorage.getItem(FRONTMATTER_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function persistShowFrontmatter(enabled) {
  try {
    localStorage.setItem(FRONTMATTER_KEY, String(enabled));
  } catch {
    /* ignore */
  }
  applyFrontmatterVisibility();
}

async function persistLiveReload(enabled) {
  try {
    localStorage.setItem(RELOAD_KEY, String(enabled));
  } catch {
    /* ignore */
  }
  await api().core.invoke("set_live_reload", { enabled });
}

function updateNav() {
  backButton.disabled = historyIndex <= 0;
  forwardButton.disabled = historyIndex < 0 || historyIndex >= historyStack.length - 1;
}

function pushHistory(path, hash = "") {
  const entry = { path, hash: hash || "" };
  const current = historyStack[historyIndex];
  if (current && current.path === entry.path && current.hash === entry.hash) {
    updateNav();
    return;
  }
  historyStack.splice(historyIndex + 1);
  historyStack.push(entry);
  historyIndex = historyStack.length - 1;
  updateNav();
}

async function openPath(path, options = {}) {
  if (!path) return;
  const { fromHistory = false, hash = "", skipHistory = false } = options;
  try {
    const doc = await api().core.invoke("open_document", { path });
    currentPath = doc.path;
    renderDocument(doc);
    if (hash) {
      requestAnimationFrame(() => scrollToHash(hash));
    }
    if (!fromHistory && !skipHistory) {
      pushHistory(doc.path, hash);
    } else {
      updateNav();
    }
  } catch (error) {
    showToast(String(error));
  }
}

function scrollToHash(hash) {
  const id = decodeURIComponent(String(hash).replace(/^#/, ""));
  if (!id) return;
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function goBack() {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  const entry = historyStack[historyIndex];
  openPath(entry.path, { fromHistory: true, hash: entry.hash });
}

function goForward() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex += 1;
  const entry = historyStack[historyIndex];
  openPath(entry.path, { fromHistory: true, hash: entry.hash });
}

function renderDocument(doc) {
  emptyEl.hidden = true;
  pageEl.hidden = false;
  document.title = "MarkdownKit";
  renderFrontmatter(doc.frontmatter || []);
  contentEl.innerHTML = doc.html || "";
  document.getElementById("app").scrollTo(0, 0);
  renderMermaid(contentEl);
}

function renderFrontmatter(fields) {
  lastFrontmatter = fields;
  propsEl.replaceChildren();
  if (fields.length) {
    const fragment = document.createDocumentFragment();
    for (const field of fields) {
      const dt = document.createElement("dt");
      dt.textContent = field.key;
      const dd = document.createElement("dd");
      dd.textContent = field.value;
      fragment.append(dt, dd);
    }
    propsEl.append(fragment);
  }
  applyFrontmatterVisibility();
}

function applyFrontmatterVisibility() {
  const show = showFrontmatterEnabled();
  const hasFields = lastFrontmatter.length > 0;
  propsEl.hidden = !hasFields || !show;
  pageEl.classList.toggle("is-frontmatter-hidden", !show);
}

function showToast(message) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2400);
}

function openSettings() {
  liveReloadEl.checked = liveReloadEnabled();
  showFrontmatterEl.checked = showFrontmatterEnabled();
  applyTheme(currentTheme());
  settingsEl.hidden = false;
}

function closeSettings() {
  settingsEl.hidden = true;
}

async function pickFile() {
  const selected = await api().dialog.open({
    multiple: false,
    directory: false,
    title: "Open Markdown",
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
  });
  if (typeof selected === "string") {
    await openPath(selected);
  }
}

function markdownPath(path) {
  return /\.(md|markdown|mdown|mkd)$/i.test(path || "");
}

async function handleHref(href) {
  if (!href || href.startsWith("#")) {
    return false;
  }
  if (href.startsWith("/__mk__/open")) {
    const url = new URL(href, "https://markdownkit.local");
    const path = url.searchParams.get("path");
    if (path) await openPath(decodeURIComponent(path), { hash: url.hash });
    return true;
  }
  if (href.startsWith("/__mk__/external")) {
    const url = new URL(href, "https://markdownkit.local");
    const path = url.searchParams.get("path");
    if (path) await api().opener.openPath(decodeURIComponent(path));
    return true;
  }
  if (/^https?:/i.test(href) || href.startsWith("mailto:")) {
    await api().opener.openUrl(href);
    return true;
  }
  return false;
}

function bindDrop() {
  const on = (name, fn) => document.addEventListener(name, fn);
  on("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("drop-target");
  });
  on("dragleave", (event) => {
    if (event.target === document.documentElement || event.target === document.body) {
      document.body.classList.remove("drop-target");
    }
  });
  on("drop", async (event) => {
    event.preventDefault();
    document.body.classList.remove("drop-target");
    const files = [...(event.dataTransfer?.files || [])];
    const file = files.find((item) => markdownPath(item.name)) || files[0];
    const path = file?.path;
    if (path && markdownPath(path)) {
      await openPath(path);
    } else if (path) {
      showToast("Choose a markdown file.");
    }
  });
}

async function handleMenu(id) {
  try {
    if (id === "open") await pickFile();
    if (id === "settings") openSettings();
    if (id === "back") goBack();
    if (id === "forward") goForward();
    if (id === "reveal") await api().core.invoke("reveal_in_finder");
    if (id === "copy-path") {
      await api().core.invoke("copy_current_path");
      showToast("Copied path");
    }
  } catch (error) {
    showToast(String(error));
  }
}

async function boot() {
  applyTheme(currentTheme());
  updateNav();

  if (!api()) {
    showToast("MarkdownKit needs the Tauri runtime.");
    return;
  }

  liveReloadEl.checked = liveReloadEnabled();
  showFrontmatterEl.checked = showFrontmatterEnabled();
  applyFrontmatterVisibility();
  await persistLiveReload(liveReloadEl.checked);

  openButton.addEventListener("click", () => {
    pickFile().catch((error) => showToast(String(error)));
  });
  backButton.addEventListener("click", goBack);
  forwardButton.addEventListener("click", goForward);
  document.getElementById("settings-done").addEventListener("click", closeSettings);
  settingsEl.addEventListener("click", (event) => {
    if (event.target === settingsEl) closeSettings();
  });
  liveReloadEl.addEventListener("change", () => {
    persistLiveReload(liveReloadEl.checked).catch((error) => showToast(String(error)));
  });
  showFrontmatterEl.addEventListener("change", () => {
    persistShowFrontmatter(showFrontmatterEl.checked);
  });
  for (const button of document.querySelectorAll(".seg [data-theme]")) {
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsEl.hidden) {
      closeSettings();
    }
  });

  document.addEventListener("click", async (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    event.preventDefault();
    try {
      await handleHref(href);
    } catch (error) {
      showToast(String(error));
    }
  });

  bindDrop();

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentTheme() === "system") renderMermaid(contentEl);
  });

  const listen = api().event.listen;
  await listen("open-file", (event) => openPath(event.payload?.path || event.payload));
  await listen("menu-open", () => pickFile());
  await listen("menu", (event) => handleMenu(event.payload));
  await listen("file-changed", (event) => {
    const path = event.payload?.path || event.payload;
    if (path && path === currentPath) {
      const hash = historyStack[historyIndex]?.hash || "";
      openPath(path, { skipHistory: true, hash });
    }
  });

  try {
    const webview = api().webview.getCurrentWebview();
    await webview.onDragDropEvent((event) => {
      if (event.payload?.type === "drop") {
        const paths = event.payload.paths || [];
        const md = paths.find(markdownPath);
        if (md) openPath(md);
      }
    });
  } catch {
    // HTML drop handler is enough.
  }

  const pending = await api().core.invoke("take_pending_path");
  if (pending) {
    await openPath(pending);
  }
}

boot();
