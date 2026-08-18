const emptyEl = document.getElementById("empty");
const pageEl = document.getElementById("page");
const contentEl = document.getElementById("content");
const propsEl = document.getElementById("props");
const titleEl = document.getElementById("chrome-title");
const toastEl = document.getElementById("toast");
const openButton = document.getElementById("open-button");

let currentPath = null;
let toastTimer = 0;

function api() {
  return window.__TAURI__;
}

async function openPath(path) {
  if (!path) return;
  try {
    const doc = await api().core.invoke("open_document", { path });
    currentPath = doc.path;
    renderDocument(doc);
  } catch (error) {
    showToast(String(error));
  }
}

function renderDocument(doc) {
  emptyEl.hidden = true;
  pageEl.hidden = false;
  titleEl.textContent = doc.title || "markdownkit";
  document.title = doc.title || "MarkdownKit";
  renderFrontmatter(doc.frontmatter || []);
  contentEl.innerHTML = doc.html || "";
  contentEl.scrollTop = 0;
  document.getElementById("app").scrollTo(0, 0);
}

function renderFrontmatter(fields) {
  propsEl.replaceChildren();
  if (!fields.length) {
    propsEl.hidden = true;
    return;
  }
  propsEl.hidden = false;
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

function showToast(message) {
  toastEl.hidden = false;
  toastEl.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 3200);
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
    if (path) await openPath(decodeURIComponent(path));
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

async function boot() {
  if (!api()) {
    showToast("MarkdownKit needs the Tauri runtime.");
    return;
  }

  openButton.addEventListener("click", () => {
    pickFile().catch((error) => showToast(String(error)));
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

  const listen = api().event.listen;
  await listen("open-file", (event) => openPath(event.payload?.path || event.payload));
  await listen("menu-open", () => pickFile());
  await listen("file-changed", (event) => {
    const path = event.payload?.path || event.payload;
    if (path && path === currentPath) {
      openPath(path);
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
