const THEME_KEY = "markdownkit.theme";
const FRONTMATTER_KEY = "markdownkit.showFrontmatter";

function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return ["system", "light", "dark"].includes(stored) ? stored : "system";
  } catch {
    return "system";
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
  if (typeof renderMermaid === "function") {
    renderMermaid(document.querySelector(".content"));
  }
}

function applyFrontmatterVisibility() {
  const show = showFrontmatterEnabled();
  const page = document.querySelector(".page");
  const props = document.querySelector("dl.props");
  if (page) page.classList.toggle("is-frontmatter-hidden", !show);
  if (props) props.hidden = !show;
}

function persistShowFrontmatter(enabled) {
  try {
    localStorage.setItem(FRONTMATTER_KEY, String(enabled));
  } catch {
    /* ignore */
  }
  applyFrontmatterVisibility();
}

function applyServePrefs() {
  applyTheme(readTheme());
  applyFrontmatterVisibility();
  const showEl = document.getElementById("show-frontmatter");
  if (showEl) showEl.checked = showFrontmatterEnabled();
}

function bindSettingsControls() {
  const showEl = document.getElementById("show-frontmatter");
  if (showEl && !showEl.dataset.bound) {
    showEl.dataset.bound = "1";
    showEl.addEventListener("change", () => persistShowFrontmatter(showEl.checked));
  }
  for (const button of document.querySelectorAll(".seg [data-theme]")) {
    if (button.dataset.bound) continue;
    button.dataset.bound = "1";
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  }
  const done = document.getElementById("settings-done");
  if (done && !done.dataset.bound) {
    done.dataset.bound = "1";
    done.addEventListener("click", () => {
      if (window.history.length > 1) window.history.back();
      else window.location.href = "/";
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyServePrefs();
  bindSettingsControls();
});
window.addEventListener("pageshow", applyServePrefs);
