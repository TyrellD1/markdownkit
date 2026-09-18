const THEME_KEY = "markdownkit.theme";
const RELOAD_KEY = "markdownkit.liveReload";
const FRONTMATTER_KEY = "markdownkit.showFrontmatter";
const ONTOP_KEY = "markdownkit.alwaysOnTop";
const EDIT_KEY = "markdownkit.editing";

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
const alwaysOnTopEl = document.getElementById("always-on-top");
const allowEditingEl = document.getElementById("allow-editing");

let currentPath = null;
let lastFrontmatter = [];
let lastHtml = "";
let lastMtime = null;
let toastTimer = 0;
let toastUrl = null;
let editingArmed = false;
let saveInFlight = false;
let justSavedAt = 0;
let isDirty = false;
let editSeq = 0;
let isComposing = false;
let conflictPending = false;
let syncTimer = 0;
let reconcileTimer = 0;
// Sync waits ~150ms of quiet after the last keystroke, then fires once.
// Reconcile waits 5s of true idle and only runs when the body holds
// engine-derived structures. There is no interval and no work while idle:
// each timer only ever exists transiently.
const SYNC_MS = 150;
const RECONCILE_MS = 5000;
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

function alwaysOnTopEnabled() {
  try {
    return localStorage.getItem(ONTOP_KEY) === "true";
  } catch {
    return false;
  }
}

async function persistAlwaysOnTop(enabled) {
  try {
    localStorage.setItem(ONTOP_KEY, String(enabled));
  } catch {
    /* ignore */
  }
  await api().core.invoke("set_always_on_top", { enabled });
}

function editingEnabled() {
  try {
    return localStorage.getItem(EDIT_KEY) === "true";
  } catch {
    return false;
  }
}

function persistEditing(enabled) {
  try {
    localStorage.setItem(EDIT_KEY, String(enabled));
  } catch {
    /* ignore */
  }
  applyEditingToCurrentDocument();
}

// Arm or disarm in place: the DOM is never reset here, so toggling the
// setting keeps whatever is on screen (synced to disk within ~150ms anyway).
function applyEditingToCurrentDocument() {
  if (!currentPath || pageEl.hidden) return;
  if (editingEnabled()) armEditing();
  else {
    flushEdits();
    disarmEditing();
  }
}

// The whole rendered page is one continuous editing surface, so the caret
// moves between blocks exactly like a reader's eyes do: arrows, clicks, and
// selections cross block boundaries natively. Nothing but the root carries
// an editing host, which is what keeps movement effortless. Read-only
// islands (diagrams) opt back out individually below.
function armEditing() {
  if (!currentPath || pageEl.hidden) return;
  disarmEditing();
  contentEl.setAttribute("contenteditable", "plaintext-only");
  for (const holder of contentEl.querySelectorAll(".mk-diagram")) {
    holder.setAttribute("contenteditable", "false");
  }
  for (const box of contentEl.querySelectorAll("li.task > input[type='checkbox']")) {
    box.disabled = false;
  }
  if (!contentEl.firstElementChild) {
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    contentEl.append(p);
  }
  editingArmed = true;
}

function disarmEditing() {
  clearTimeout(syncTimer);
  syncTimer = 0;
  clearTimeout(reconcileTimer);
  reconcileTimer = 0;
  contentEl.removeAttribute("contenteditable");
  for (const el of contentEl.querySelectorAll("[contenteditable]")) {
    el.removeAttribute("contenteditable");
  }
  for (const box of contentEl.querySelectorAll("li.task > input[type='checkbox']")) {
    box.disabled = true;
  }
  editingArmed = false;
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
  if (editingArmed && isDirty && path !== currentPath) {
    // Never drop keystrokes on navigation: flush first, and stay put if the
    // flush fails so nothing is silently lost.
    const saved = await syncNow();
    if (!saved) return;
  }
  try {
    const result = await api().core.invoke("open_document", { path });
    currentPath = result.doc.path;
    lastMtime = result.mtime_ms;
    renderDocument(result.doc);
    if (hash) {
      requestAnimationFrame(() => scrollToHash(hash));
    }
    if (!fromHistory && !skipHistory) {
      pushHistory(result.doc.path, hash);
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

function renderDocument(doc, options = {}) {
  disarmEditing();
  isDirty = false;
  emptyEl.hidden = true;
  pageEl.hidden = false;
  document.title = "MarkdownKit";
  renderFrontmatter(doc.frontmatter || []);
  contentEl.innerHTML = doc.html || "";
  lastHtml = doc.html || "";
  const app = document.getElementById("app");
  if (options.keepScroll == null) app.scrollTo(0, 0);
  else app.scrollTop = options.keepScroll;
  if (!options.deferMermaid) renderMermaid(contentEl);
  if (editingEnabled()) armEditing();
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

// --- Inline editing: DOM back to markdown ---------------------------------
// The viewer stays the only renderer: nothing re-parses while typing. On
// save this serializer walks the (possibly edited) DOM back to a markdown
// body, Rust writes it atomically and returns the re-rendered document.
//
// Known normalizations (rendered output is unchanged in each case):
// - table column alignment (`:---:`) is dropped; the viewer left-aligns all
//   columns regardless
// - reference-style links become inline links with the same target
// - raw HTML the sanitizer already stripped stays stripped
// - loose lists tighten (blank lines between items are not preserved)

function currentDir() {
  if (!currentPath) return "";
  const index = currentPath.lastIndexOf("/");
  return index < 0 ? "" : currentPath.slice(0, index);
}

function relativize(dir, absolute) {
  if (!absolute.startsWith("/")) return absolute;
  if (dir && (absolute === dir || absolute.startsWith(dir + "/"))) {
    const rest = absolute.slice(dir.length + 1);
    if (!rest) return ".";
    return rest.includes("/") ? rest : "./" + rest;
  }
  return absolute;
}

function reverseLink(href) {
  if (!href) return "";
  if (href.startsWith("#")) return href;
  if (/^(https?:|mailto:|data:)/i.test(href) || href.startsWith("//")) return href;
  let match = href.match(/^\/__mk__\/open\?path=([^#]*)(#.*)?$/);
  if (match) {
    try {
      return relativize(currentDir(), decodeURIComponent(match[1])) + (match[2] || "");
    } catch {
      return href;
    }
  }
  match = href.match(/^\/__mk__\/external\?path=(.*)$/);
  if (match) {
    try {
      return relativize(currentDir(), decodeURIComponent(match[1]));
    } catch {
      return href;
    }
  }
  return href;
}

function reverseImage(src) {
  if (!src) return "";
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  const match = src.match(/^asset:\/\/localhost\/(.*)$/);
  if (match) {
    try {
      return relativize(currentDir(), decodeURIComponent(match[1]));
    } catch {
      return src;
    }
  }
  return src;
}

function serializeInlineChildren(el) {
  let out = "";
  let afterBreak = false;
  for (const child of [...el.childNodes]) {
    let part = serializeInlineNode(child);
    // The renderer pretty-prints a newline right after every <br>; without
    // stripping it, a hard break would round-trip as backslash + blank line
    // and split the paragraph on save.
    if (afterBreak && child.nodeType === Node.TEXT_NODE) {
      part = part.replace(/^[ \t]*\n/, "");
    }
    afterBreak = child.nodeType === Node.ELEMENT_NODE && child.tagName === "BR";
    out += part;
  }
  return out;
}

// A <br> at the very end of a block is the browser's caret placeholder, not
// a line break the user typed: serializing it as a hard-break marker would
// write a literal backslash into the file on the next save.
function stripTrailingBreak(text) {
  return text.replace(/(\\\n?)+$/, "");
}

function serializeInlineNode(node) {  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName;
  if (tag === "BR") return "\\\n";
  if (tag === "STRONG" || tag === "B") return `**${serializeInlineChildren(node)}**`;
  if (tag === "EM" || tag === "I") return `*${serializeInlineChildren(node)}*`;
  if (tag === "DEL" || tag === "S" || tag === "STRIKE") return `~~${serializeInlineChildren(node)}~~`;
  if (tag === "CODE") {
    const inner = node.textContent || "";
    return inner.includes("`") ? "`` " + inner + " ``" : "`" + inner + "`";
  }
  if (tag === "A") {
    const text = stripTrailingBreak(serializeInlineChildren(node)).trim();
    const url = reverseLink(node.getAttribute("href") || "");
    return url ? `[${text}](${url})` : text;
  }
  if (tag === "IMG") {
    const alt = (node.getAttribute("alt") || "").replace(/[\[\]]/g, "");
    const src = reverseImage(node.getAttribute("src") || "");
    const title = node.getAttribute("title");
    return title ? `![${alt}](${src} "${title.replace(/"/g, "")}")` : `![${alt}](${src})`;
  }
  if (tag === "INPUT") return "";
  if (tag === "SCRIPT" || tag === "STYLE") return "";
  if (tag === "SUP") {
    const link = node.querySelector("a[href^='#']");
    if (link) {
      try {
        return `[^${decodeURIComponent(link.getAttribute("href").slice(1))}]`;
      } catch {
        return "";
      }
    }
    return serializeInlineChildren(node);
  }
  return serializeInlineChildren(node);
}

function serializeList(list, pad) {
  const ordered = list.tagName === "OL";
  const lines = [];
  let number = 0;
  for (const li of [...list.children]) {
    if (li.tagName !== "LI") continue;
    number += 1;
    const box = li.querySelector(":scope > input[type='checkbox']");
    const isTask = li.classList.contains("task") || !!box;
    const marker = isTask
      ? `- [${box && box.checked ? "x" : " "}] `
      : ordered
        ? `${number}. `
        : "- ";
    const segments = [];
    const nestedLists = [];
    let head = "";
    const flushHead = () => {
      // Whitespace-only residue (e.g. the formatting newline around a nested
      // list) is not content; keeping it would emit blank lines that loosen
      // tight lists on save.
      if (head.trim()) {
        segments.push(head);
        head = "";
      } else {
        head = "";
      }
    };
    for (const child of [...li.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === "UL" || child.tagName === "OL")) {
        flushHead();
        // Nested blocks align to this item's content column, which varies
        // ("- " takes 2, "10. " takes 4): a fixed indent would un-nest them.
        const nested = serializeList(child, pad + " ".repeat(marker.length));
        if (nested) nestedLists.push(nested);
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "P") {
        flushHead();
        segments.push(serializeInlineChildren(child));
      } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "INPUT") {
        continue; // task checkbox; state is read from `box` above
      } else {
        head += serializeInlineNode(child);
      }
    }
    flushHead();
    const first = stripTrailingBreak(segments.shift() || "").trim();
    lines.push(pad + marker + first);
    const continuationPad = pad + " ".repeat(marker.length);
    for (const segment of segments) {
      const clean = stripTrailingBreak(String(segment));
      if (!clean.trim()) continue;
      for (const line of clean.split("\n")) {
        lines.push(line ? continuationPad + line : continuationPad.trimEnd());
      }
    }
    // Nested lists carry their own depth indent; they are appended raw.
    for (const nested of nestedLists) lines.push(nested);
  }
  return lines.join("\n");
}

function serializeTable(table) {
  const rows = [...table.querySelectorAll("tr")];
  if (!rows.length) return "";
  const cellsOf = (row) =>
    [...row.children]
      .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
      .map((cell) =>
        stripTrailingBreak(serializeInlineChildren(cell)).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "),
      );
  const head = cellsOf(rows[0]);
  if (!head.length) return "";
  const lines = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    while (cells.length < head.length) cells.push("");
    lines.push(`| ${cells.slice(0, head.length).join(" | ")} |`);
  }
  return lines.join("\n");
}

function serializeBlock(el) {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = stripTrailingBreak(serializeInlineChildren(el)).trim();
    const actual = el.getAttribute("id") || "";
    const expected = nextHeadingId(text);
    // An explicit `{#id}` survives only when it differs from what the
    // renderer would assign anyway; otherwise the id round-trips implicitly.
    const suffix = actual && actual !== expected ? ` {#${actual}}` : "";
    return `${"#".repeat(Number(tag[1]))} ${text}${suffix}`;
  }
  // Footnote definitions render as plain classless divs with the label as
  // id; they must be caught before the generic DIV branch below.
  if (tag === "DIV" && !el.className && el.id && el.querySelector(":scope > sup")) {
    const parts = [];
    for (const child of [...el.children]) {
      if (child.tagName === "SUP") continue;
      const text = stripTrailingBreak(serializeBlock(child));
      if (text.trim()) parts.push(text);
    }
    if (!parts.length) return `[^${el.id}]:`;
    const lines = parts.join("\n\n").split("\n");
    return [`[^${el.id}]: ${lines[0]}`, ...lines.slice(1).map((line) => (line ? `    ${line}` : ""))].join(
      "\n",
    );
  }
  if (tag === "P" || tag === "DIV") {
    if (!el.textContent && !el.querySelector("img, input")) return "";
    return stripTrailingBreak(serializeInlineChildren(el)).trim();
  }
  if (tag === "UL" || tag === "OL") return serializeList(el, "");
  if (tag === "BLOCKQUOTE") {
    const inner = [];
    for (const child of [...el.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent.trim()) inner.push(child.textContent.trim());
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        inner.push(serializeBlock(child));
      }
    }
    return inner
      .join("\n>\n")
      .split("\n")
      // Bare ">" lines are this level's own separators and stay as-is;
      // every other line gains one "> ", including nested quote markers.
      .map((line) => (line === "" || line === ">" ? ">" : `> ${line}`))
      .join("\n");
  }
  if (tag === "PRE") {
    const code = el.querySelector("code");
    const match = (code?.className || "").match(/language-([\w+-]+)/);
    const text = preTextContent(code || el).replace(/\n$/, "");
    return `\`\`\`${match ? match[1] : ""}\n${text}\n\`\`\``;
  }
  if (el.classList.contains("mk-diagram")) {
    const source = (el.dataset.mermaid || "").replace(/^\s+|\s+$/g, "");
    return `\`\`\`mermaid\n${source}\n\`\`\``;
  }
  if (tag === "TABLE") return serializeTable(el);
  if (tag === "HR") return "---";
  return serializeInlineChildren(el).trim();
}

// Text of an edited code block. textContent alone would silently drop line
// breaks the browser inserted as <br> or split divs while typing.
function preTextContent(el) {
  let out = "";
  for (const child of [...el.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.tagName === "BR") out += "\n";
      else {
        out += preTextContent(child);
        if (child.tagName === "DIV" || child.tagName === "P") out += "\n";
      }
    }
  }
  return out;
}

let headingIdSeen = new Set();

// Mirrors the engine's slugify so explicit `{#id}` attributes (and only
// those) survive a save: when the rendered id equals the assigned one, the
// heading round-trips with no suffix at all.
function slugifyHeading(text) {
  let slug = "";
  let prevDash = false;
  for (const ch of text) {
    if (/[a-zA-Z0-9]/.test(ch)) {
      slug += ch.toLowerCase();
      prevDash = false;
    } else if (/\p{Alphabetic}/u.test(ch)) {
      slug += ch;
      prevDash = false;
    } else if (slug && !prevDash) {
      slug += "-";
      prevDash = true;
    }
  }
  return slug.replace(/^-+|-+$/g, "");
}

function nextHeadingId(text) {
  const base = slugifyHeading(text) || "section";
  let id = base;
  let n = 2;
  while (headingIdSeen.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  headingIdSeen.add(id);
  return id;
}

function serializeBody() {
  headingIdSeen = new Set();
  const parts = [];
  for (const child of [...contentEl.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent.trim()) parts.push(child.textContent.trim());
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    parts.push(serializeBlock(child));
  }
  let body = parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
  return body ? body + "\n" : "";
}

// --- Inline editing: caret, keymap, save ------------------------------------

// The prose line around the caret: the nearest paragraph, heading, or list
// item. Returns null inside code, tables, and other non-prose shapes, where
// typing stays plain and no shortcut applies.
function editableLineOf(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const line = el?.closest?.("p, h1, h2, h3, h4, h5, h6, li");
  return line && contentEl.contains(line) ? line : null;
}

function topLevelBlock(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el.parentElement !== contentEl) el = el.parentElement;
  return el && el.parentElement === contentEl ? el : null;
}

function caretOffsetIn(block) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed || !block.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(block);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

function setCaretToStart(el) {
  const range = document.createRange();
  let node = el.firstChild;
  while (node && node.nodeType === Node.ELEMENT_NODE && node.tagName === "INPUT") {
    node = node.nextSibling;
  }
  if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, 0);
  else if (node) {
    range.selectNodeContents(node);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  (el.closest("[contenteditable]") || el).focus({ preventScroll: true });
}

function captureCaret() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const top = topLevelBlock(range.startContainer);
  if (!top) return null;
  const index = [...contentEl.children].indexOf(top);
  const pre = range.cloneRange();
  pre.selectNodeContents(top);
  pre.setEnd(range.startContainer, range.startOffset);
  return { index, offset: pre.toString().length };
}

function restoreCaret(caret) {
  if (!caret || !contentEl.children.length) return;
  const top = contentEl.children[Math.min(caret.index, contentEl.children.length - 1)];
  const range = document.createRange();
  let remaining = caret.offset;
  let placed = false;
  const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.length >= remaining) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= node.nodeValue.length;
  }
  if (!placed) {
    range.selectNodeContents(top);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// New blocks inherit the root editing host, so they must not carry their
// own contenteditable attribute: nested hosts would trap the caret.
function newBlock(tag) {
  return document.createElement(tag);
}

function convertParagraphToHeading(p, level) {
  const h = newBlock(`h${level}`);
  h.append(...p.childNodes);
  p.replaceWith(h);
  // New headings get a real id immediately (tracked while unrendered) so
  // anchor links work without waiting for a re-render.
  h.dataset.mkAutoId = "1";
  updateAutoHeadingId(h);
  setCaretToStart(h);
}

// Id assignment mirroring the engine's first-come slug scheme, scoped to the
// live DOM. Runs only for headings the editor created, on conversion and on
// keystrokes inside them — never on idle, never on a timer.
function updateAutoHeadingId(h) {
  const seen = new Set();
  for (const other of contentEl.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    if (other !== h && other.id) seen.add(other.id);
  }
  const base = slugifyHeading(h.textContent.trim()) || "section";
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  h.id = id;
}

function wrapParagraphInList(p, kind, task, checked) {
  const list = document.createElement(kind);
  const li = newBlock("li");
  if (task) {
    li.className = "task";
    li.append(makeTaskCheckbox(checked), document.createTextNode(" "));
  }
  li.append(...p.childNodes);
  list.append(li);
  p.replaceWith(list);
  setCaretToStart(li);
}

function wrapParagraphInBlockquote(p) {
  const quote = document.createElement("blockquote");
  const inner = newBlock("p");
  inner.append(...p.childNodes);
  quote.append(inner);
  p.replaceWith(quote);
  setCaretToStart(inner);
}

function makeTaskCheckbox(checked) {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!checked;
  return box;
}

function onSpacePrefix(event, block) {
  if ((block.tagName !== "P" && !/^H[1-6]$/.test(block.tagName)) || block.closest("li")) return;
  const offset = caretOffsetIn(block);
  if (offset == null) return;
  const before = block.textContent.slice(0, offset);
  const rest = block.textContent.slice(offset);
  const convert = (fn) => {
    event.preventDefault();
    block.textContent = rest;
    markDirty();
    fn();
  };
  const heading = before.match(/^(#{1,6})$/);
  if (heading) convert(() => convertParagraphToHeading(block, heading[1].length));
  else if (block.tagName !== "P") return;
  else if (/^(-|\*|\+)$/.test(before)) convert(() => wrapParagraphInList(block, "UL", false));
  else if (/^1\.$/.test(before)) convert(() => wrapParagraphInList(block, "OL", false));
  else if (/^(\[\]|\[x\])$/i.test(before)) {
    convert(() => wrapParagraphInList(block, "UL", true, /x/i.test(before)));
  } else if (/^>$/.test(before) && !block.closest("blockquote")) {
    convert(() => wrapParagraphInBlockquote(block));
  }
}

function outdentListItem(li) {
  const list = li.parentElement;
  const parentLi = list.parentElement?.closest?.("li");
  if (!parentLi) return false;
  const rest = [];
  let next = li.nextElementSibling;
  while (next) {
    const following = next.nextElementSibling;
    rest.push(next);
    next = following;
  }
  if (rest.length) {
    const clone = document.createElement(list.tagName);
    clone.append(...rest);
    li.append(clone);
  }
  parentLi.after(li);
  if (!list.children.length) list.remove();
  setCaretToStart(li);
  return true;
}

function indentListItem(li) {
  const prev = li.previousElementSibling;
  if (!prev || prev.tagName !== "LI") return false;
  let sub = prev.querySelector(":scope > UL, :scope > OL");
  if (!sub) {
    sub = document.createElement(li.parentElement.tagName);
    prev.append(sub);
  }
  sub.append(li);
  setCaretToStart(li);
  return true;
}

function exitListToParagraph(li) {
  const list = li.parentElement;
  if (!list || (list.tagName !== "UL" && list.tagName !== "OL")) return false;
  const tail = [];
  let next = li.nextElementSibling;
  while (next) {
    const following = next.nextElementSibling;
    tail.push(next);
    next = following;
  }
  li.remove();
  const p = newBlock("p");
  p.append(document.createElement("br"));
  list.after(p);
  if (tail.length) {
    const rest = document.createElement(list.tagName);
    rest.append(...tail);
    p.after(rest);
  }
  if (!list.children.length) list.remove();
  setCaretToStart(p);
  return true;
}

function onEnterKey(event, block) {
  if (event.shiftKey) return; // Shift+Enter stays a soft break (<br>)
  if (block.tagName === "P" && !block.closest("li") && block.textContent.trim() === "---") {
    event.preventDefault();
    const hr = document.createElement("hr");
    const p = newBlock("p");
    p.append(document.createElement("br"));
    block.replaceWith(hr, p);
    markDirty();
    setCaretToStart(p);
    return;
  }
  if (block.tagName === "LI" && !block.querySelector("ul, ol") && block.textContent.trim() === "") {
    event.preventDefault();
    if (!outdentListItem(block)) exitListToParagraph(block);
    return;
  }
  // ```lang + Enter opens a real code block; the fence never shows as text.
  if (block.tagName === "P" && !block.closest("li, blockquote, table, pre")) {
    const fence = block.textContent.match(/^```([\w+-]*)$/);
    if (fence && caretAtEnd(event, block)) {
      event.preventDefault();
      openCodeBlock(block, fence[1]);
      return;
    }
  }
  // Let the browser split the block, then normalize the Notion-unlike parts:
  // a heading split at the very end becomes a paragraph, and stray top-level
  // divs become paragraphs.
  queueMicrotask(() => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const line = editableLineOf(sel.anchorNode);
    const top = line || topLevelBlock(sel.anchorNode);
    if (!top || top === block || !contentEl.contains(top)) return;
    if (
      line &&
      /^H[1-6]$/.test(block.tagName) &&
      /^H[1-6]$/.test(line.tagName) &&
      !line.textContent.trim()
    ) {
      const p = newBlock("p");
      p.append(...line.childNodes);
      line.replaceWith(p);
      setCaretToStart(p);
    } else if (!line && top.tagName === "DIV" && top.parentElement === contentEl) {
      const p = newBlock("p");
      p.append(...top.childNodes);
      top.replaceWith(p);
      setCaretToStart(p);
    } else if (line && line.tagName === "LI" && line.classList.contains("task") && !line.textContent.trim()) {
      const box = line.querySelector(":scope > input[type='checkbox']");
      if (box) box.checked = false;
    } else if (line && /^H[1-6]$/.test(line.tagName) && line.textContent.trim()) {
      // A split clones the id; refresh it (and track it) like a fresh heading.
      line.dataset.mkAutoId = "1";
      updateAutoHeadingId(line);
    }
    markDirty();
  });
}

function caretAtEnd(event, block) {
  const offset = caretOffsetIn(block);
  return offset != null && offset === block.textContent.length;
}

function openCodeBlock(p, lang) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (lang) code.className = `language-${lang}`;
  pre.append(code);
  p.replaceWith(pre);
  markDirty();
  const range = document.createRange();
  range.selectNodeContents(code);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  contentEl.focus({ preventScroll: true });
}

function onBackspaceKey(event, block) {
  const offset = caretOffsetIn(block);
  if (offset !== 0) return;
  if (/^H[1-6]$/.test(block.tagName) && !block.textContent) {
    event.preventDefault();
    const p = newBlock("p");
    p.append(...block.childNodes);
    block.replaceWith(p);
    markDirty();
    setCaretToStart(p);
  }
  // Otherwise the browser's native merge (including across list items) is
  // already the Notion behavior.
}

function onTabKey(event, block) {
  event.preventDefault();
  const li = block.tagName === "LI" ? block : block.closest("li");
  if (!li || !contentEl.contains(li)) return;
  if (event.shiftKey) {
    if (!outdentListItem(li) && !li.querySelector("ul, ol")) {
      const p = newBlock("p");
      p.append(...[...li.childNodes].filter((node) => node.tagName !== "INPUT"));
      li.replaceWith(p);
      markDirty();
      setCaretToStart(p);
    }
  } else {
    indentListItem(li);
  }
}

// Inline shortcuts insert real elements, not markers: the selection becomes
// bold/italic/code immediately and stays that way through save, because the
// serializer reads the same elements back.
function wrapSelectionElement(tag, attributes = {}) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    showToast("Select text first");
    return false;
  }
  const range = sel.getRangeAt(0);
  const startBlock = editableLineOf(range.startContainer);
  const endBlock = editableLineOf(range.endContainer);
  if (!startBlock || startBlock !== endBlock) return false;
  const selected = range.extractContents();
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  el.append(selected);
  range.insertNode(el);
  const after = document.createRange();
  after.setStartAfter(el);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  markDirty();
  return true;
}

function wrapSelection(marker) {
  if (marker === "**") wrapSelectionElement("STRONG");
  else if (marker === "*") wrapSelectionElement("EM");
  else if (marker === "`") wrapSelectionElement("CODE");
}

function wrapSelectionAsLink() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    showToast("Select text first");
    return;
  }
  const range = sel.getRangeAt(0);
  const startBlock = editableLineOf(range.startContainer);
  const endBlock = editableLineOf(range.endContainer);
  if (!startBlock || startBlock !== endBlock) return;
  const selected = range.extractContents();
  const openBracket = document.createTextNode("[");
  range.insertNode(openBracket);
  const mid = document.createRange();
  mid.setStartAfter(openBracket);
  mid.collapse(true);
  mid.insertNode(selected);
  const tail = document.createRange();
  if (selected.lastChild) tail.setStartAfter(selected.lastChild);
  else tail.setStartAfter(openBracket);
  tail.collapse(true);
  const parens = document.createTextNode("()");
  tail.insertNode(parens);
  // Leave the caret between the parens so a pasted URL lands in it.
  const caret = document.createRange();
  caret.setStart(parens, 1);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  markDirty();
}

function handleInlineShortcut(event, block) {
  if (!editableLineOf(event.target)) return;
  const key = event.key.toLowerCase();
  if (key === "b") {
    event.preventDefault();
    wrapSelection("**");
  } else if (key === "i") {
    event.preventDefault();
    wrapSelection("*");
  } else if (key === "`") {
    event.preventDefault();
    wrapSelection("`");
  } else if (key === "k") {
    event.preventDefault();
    wrapSelectionAsLink();
  }
}

// Paste as plain text only (plaintext-only still accepts styled drops in
// some engines). In prose, multi-line pastes split into blocks like Enter
// would; inside code and table cells the lines join with newlines as text.
function onEditPaste(event) {
  if (!editingArmed) return;
  const target = event.target;
  if (!target || !contentEl.contains(target)) return;
  if (target.closest?.("[contenteditable='false']")) return;
  const text = (event.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  if (!text) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  const block = editableLineOf(target);
  if (!block) {
    insertPlainTextAtCaret(text);
    markDirty();
    return;
  }
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  const tailRange = range.cloneRange();
  tailRange.setEnd(block, block.childNodes.length);
  const tail = tailRange.extractContents();
  const lines = text.split("\n");
  const firstText = document.createTextNode(lines[0]);
  range.insertNode(firstText);
  let current = block;
  let lastText = firstText;
  for (let i = 1; i < lines.length; i++) {
    const next = nextBlockFor(current);
    current.after(next);
    const textNode = document.createTextNode(lines[i]);
    next.append(textNode);
    current = next;
    lastText = textNode;
  }
  current.append(tail);
  const caret = document.createRange();
  caret.setStart(lastText, lastText.nodeValue.length);
  caret.collapse(true);
  sel.removeAllRanges();
  sel.addRange(caret);
  markDirty();
}

function insertPlainTextAtCaret(text) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function nextBlockFor(current) {
  let tag = current.tagName;
  if (/^H[1-6]$/.test(tag) || tag === "DIV") tag = "P";
  const next = newBlock(tag);
  if (tag === "LI" && current.classList.contains("task")) {
    next.className = "task";
    next.append(makeTaskCheckbox(false), document.createTextNode(" "));
  }
  return next;
}

// --- Inline editing: autosave ---------------------------------------------
// Saves are explicit events, never a loop: typing (re)arms a single
// one-shot timer; the timer fires once after a second of quiet and is gone.
// Conflict freezes autosave until ⌘S forces or Esc reloads.

// --- Inline editing: fast sync + idle reconcile ------------------------------
// Two separate rhythms, both one-shot timers that exist only transiently:
//
// - sync: ~150ms after the last keystroke the DOM serializes to the .md via
//   a write-only command. The page itself is never touched, so there is no
//   caret jump, no flicker, no "pause then mutate".
// - reconcile: only when the body holds structures whose rendering needs
//   the engine (footnotes, fresh diagrams/tables, explicit {#ids}), a full
//   re-render follows after 5s of true idle, with caret and scroll kept.

function markDirty() {
  if (!editingArmed) return;
  isDirty = true;
  editSeq += 1;
  clearTimeout(reconcileTimer);
  reconcileTimer = 0;
  scheduleSync();
}

function scheduleSync() {
  if (!editingArmed || conflictPending) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = 0;
    syncNow().catch((error) => showToast(String(error)));
  }, SYNC_MS);
}

async function syncNow(options = {}) {
  const { force = false } = options;
  if (!editingArmed || !isDirty || saveInFlight || !currentPath || isComposing) return false;
  if (conflictPending && !force) return false;
  saveInFlight = true;
  const seq = editSeq;
  const body = serializeBody();
  try {
    lastMtime = await api().core.invoke("write_document", {
      path: currentPath,
      body,
      expected_mtime_ms: lastMtime,
      force,
    });
    justSavedAt = Date.now();
    // Keystrokes that landed mid-write belong to the next flush, not this one.
    if (editSeq === seq) isDirty = false;
    else scheduleSync();
    maybeScheduleReconcile(body);
    return true;
  } catch (error) {
    if (String(error).startsWith("CONFLICT")) {
      conflictPending = true;
      clearTimeout(syncTimer);
      syncTimer = 0;
      showToast("File changed on disk — ⌘S to overwrite, Esc to load it", { ms: 6000 });
      return false;
    }
    showToast(String(error));
    return false;
  } finally {
    saveInFlight = false;
  }
}

function flushEdits() {
  if (!editingArmed || !isDirty || saveInFlight || conflictPending || isComposing) return;
  clearTimeout(syncTimer);
  syncTimer = 0;
  syncNow().catch((error) => showToast(String(error)));
}

// Hint scan for body shapes whose rendering needs the engine. Plain prose
// never matches, so ordinary typing never pays for a re-render.
function docNeedsReconcile(body) {
  return /\[\^[^\]\s]+\]|```mermaid|^\s*\|.*\|\s*$|\{#[A-Za-z0-9_-]+\}/m.test(body);
}

function maybeScheduleReconcile(body) {
  if (!editingArmed || conflictPending || reconcileTimer) return;
  if (!docNeedsReconcile(body)) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = 0;
    reconcileNow().catch((error) => showToast(String(error)));
  }, RECONCILE_MS);
}

// Full write + re-render for engine-derived structures, after true idle.
// Caret, focus, scroll, and already-drawn diagrams survive it.
async function reconcileNow() {
  if (!editingArmed || !currentPath || conflictPending) return false;
  if (saveInFlight || isComposing) {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = 0;
      reconcileNow().catch((error) => showToast(String(error)));
    }, RECONCILE_MS);
    return false;
  }
  const body = serializeBody();
  if (!docNeedsReconcile(body)) return true;
  saveInFlight = true;
  const seq = editSeq;
  const caret = captureCaret();
  const hadFocus = contentEl.contains(document.activeElement);
  const scroll = document.getElementById("app").scrollTop;
  // Keep already-rendered diagrams across the re-render so they never
  // flicker; only new or changed fences re-render below.
  const diagrams = new Map();
  for (const holder of contentEl.querySelectorAll(".mk-diagram")) {
    const source = holder.dataset.mermaid || "";
    if (!diagrams.has(source)) diagrams.set(source, []);
    diagrams.get(source).push(holder);
  }
  try {
    const result = await api().core.invoke("save_document", {
      path: currentPath,
      body,
      expected_mtime_ms: lastMtime,
      force: false,
    });
    currentPath = result.doc.path;
    lastMtime = result.mtime_ms;
    justSavedAt = Date.now();
    if (editSeq === seq) isDirty = false;
    else scheduleSync();
    renderDocument(result.doc, { keepScroll: scroll, deferMermaid: true });
    let freshDiagrams = false;
    for (const pre of contentEl.querySelectorAll("pre")) {
      const code = pre.querySelector(":scope > code");
      if (!code || !/\blanguage-mermaid\b/.test(code.className || "")) continue;
      const stash = diagrams.get(code.textContent || "");
      if (stash && stash.length) pre.replaceWith(stash.shift());
      else freshDiagrams = true;
    }
    if (freshDiagrams) renderMermaid(contentEl);
    restoreCaret(caret);
    if (hadFocus) contentEl.focus({ preventScroll: true });
    return true;
  } catch (error) {
    if (String(error).startsWith("CONFLICT")) {
      conflictPending = true;
      showToast("File changed on disk — ⌘S to overwrite, Esc to load it", { ms: 6000 });
      return false;
    }
    showToast(String(error));
    return false;
  } finally {
    saveInFlight = false;
  }
}

// --- Inline editing: live conversion --------------------------------------
// Block prefixes convert in keydown (before the space lands); inline spans
// convert here, on the delimiter that completes them: typing `**bold** `
// turns the span bold the moment the trailing space arrives.

function onEditInput(event) {
  if (!editingArmed) return;
  markDirty();
  if (event.isComposing) return;
  const sel = window.getSelection();
  const line = sel.rangeCount ? editableLineOf(sel.anchorNode) : null;
  if (line && /^H[1-6]$/.test(line.tagName) && line.dataset.mkAutoId) updateAutoHeadingId(line);
  if (event.inputType === "insertText" && typeof event.data === "string" && /[\s.,;:!?)]/.test(event.data)) {
    tryConvertInline();
  }
}

function tryConvertInline() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return false;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const line = editableLineOf(node);
  if (!line || !contentEl.contains(line)) return false;
  const offset = sel.anchorOffset;
  const full = node.nodeValue;
  // The delimiter that triggered this check (usually the space just typed)
  // sits before the caret and stays put; patterns match up to it.
  let core = full.slice(0, offset);
  let coreEnd = offset;
  if (/[\s.,;:!?)]$/.test(core)) {
    core = core.slice(0, -1);
    coreEnd -= 1;
  }
  const before = core;
  // Text strictly after the caret; the delimiter itself stays in the node
  // and is re-split out below, so it is never duplicated.
  const after = full.slice(offset);
  const patterns = [
    { re: /\*\*([^*]+)\*\*$/, tag: "STRONG" },
    { re: /(^|[\s(])\*([^*]+)\*$/, tag: "EM", prefix: 1 },
    { re: /`([^`]+)`$/, tag: "CODE" },
    { re: /~~([^~]+)~~$/, tag: "DEL" },
  ];
  for (const { re, tag, prefix } of patterns) {
    const match = before.match(re);
    if (!match) continue;
    const inner = match[prefix ? 2 : 1];
    const start = coreEnd - match[0].length + (prefix ? match[1].length : 0);
    node.nodeValue = full.slice(0, start) + full.slice(coreEnd);
    const el = document.createElement(tag);
    el.textContent = inner;
    const remainder = document.createTextNode(after);
    const anchor = splitTextAt(node, start);
    anchor.before(el, remainder);
    const caret = document.createRange();
    caret.setStart(remainder, 0);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    return true;
  }
  const link = before.match(/\[([^\]]+)\]\(([^)\s]+)\)$/);
  if (link) {
    const bracketAt = coreEnd - link[0].length;
    // A `!` immediately before the bracket makes this an image, not a link:
    // without this check a typed image would save back as a link.
    const isImage = full[bracketAt - 1] === "!";
    const start = isImage ? bracketAt - 1 : bracketAt;
    node.nodeValue = full.slice(0, start) + full.slice(coreEnd);
    let el;
    if (isImage) {
      el = document.createElement("img");
      el.setAttribute("alt", link[1]);
      el.setAttribute("src", link[2]);
    } else {
      el = document.createElement("a");
      el.setAttribute("href", link[2]);
      el.textContent = link[1];
    }
    const remainder = document.createTextNode(after);
    splitTextAt(node, start).before(el, remainder);
    const caret = document.createRange();
    caret.setStart(remainder, 0);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    return true;
  }
  return false;
}

// Split a text node at offset, returning the node that starts at the split
// (the right half, or an empty text node when splitting at the very end).
function splitTextAt(node, offset) {
  if (offset >= node.nodeValue.length) {
    const empty = document.createTextNode("");
    node.after(empty);
    return empty;
  }
  return node.splitText(offset);
}

function onContentKeydown(event) {
  if (!editingArmed) return;
  const block = editableLineOf(event.target);
  if (!block || !contentEl.contains(block)) return;
  if (event.metaKey || event.ctrlKey) {
    handleInlineShortcut(event, block);
    return;
  }
  if (event.altKey) return;
  switch (event.key) {
    case " ":
      onSpacePrefix(event, block);
      break;
    case "Enter":
      onEnterKey(event, block);
      break;
    case "Backspace":
      onBackspaceKey(event, block);
      break;
    case "Tab":
      onTabKey(event, block);
      break;
  }
}

// Task boxes toggle explicitly instead of relying on native behavior
// inside contenteditable; autosave persists the toggle.
function onContentClick(event) {
  if (!editingArmed) return;
  const box = event.target?.closest?.("li.task > input[type='checkbox']");
  if (!box || !contentEl.contains(box)) return;
  event.preventDefault();
  box.checked = !box.checked;
  markDirty();
}

// Double-clicking a diagram swaps in its source fence for editing; on save
// it serializes back to ```mermaid like any other code block.
function onDiagramDblClick(event) {
  if (!editingArmed) return;
  const holder = event.target?.closest?.(".mk-diagram");
  if (!holder || !contentEl.contains(holder)) return;
  event.preventDefault();
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = holder.dataset.mermaid || "";
  pre.append(code);
  holder.replaceWith(pre);
  markDirty();
  const range = document.createRange();
  range.selectNodeContents(code);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function cancelEditing() {
  if (!editingArmed) return;
  if (document.activeElement) document.activeElement.blur();
  clearTimeout(syncTimer);
  syncTimer = 0;
  clearTimeout(reconcileTimer);
  reconcileTimer = 0;
  isDirty = false;
  conflictPending = false;
  try {
    // Reload from disk (not the stale baseline): Esc is also how a
    // disk-conflict is resolved toward the outside world.
    await openPath(currentPath, { skipHistory: true });
  } catch {
    contentEl.innerHTML = lastHtml;
    renderMermaid(contentEl);
    if (editingEnabled()) armEditing();
    else disarmEditing();
  }
  showToast("Edits discarded");
}

function showToast(message, options = {}) {
  const ms = options.ms ?? 2400;
  toastUrl = options.url || null;
  toastEl.hidden = false;
  toastEl.textContent = message;
  toastEl.classList.toggle("is-action", Boolean(toastUrl));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
    toastEl.classList.remove("is-action");
    toastUrl = null;
  }, ms);
}

function openSettings() {
  liveReloadEl.checked = liveReloadEnabled();
  showFrontmatterEl.checked = showFrontmatterEnabled();
  alwaysOnTopEl.checked = alwaysOnTopEnabled();
  allowEditingEl.checked = editingEnabled();
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
  alwaysOnTopEl.checked = alwaysOnTopEnabled();
  allowEditingEl.checked = editingEnabled();
  applyFrontmatterVisibility();
  await persistLiveReload(liveReloadEl.checked);
  await persistAlwaysOnTop(alwaysOnTopEl.checked);

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
  alwaysOnTopEl.addEventListener("change", () => {
    persistAlwaysOnTop(alwaysOnTopEl.checked).catch((error) => showToast(String(error)));
  });
  allowEditingEl.addEventListener("change", () => {
    persistEditing(allowEditingEl.checked);
  });
  contentEl.addEventListener("keydown", onContentKeydown);
  contentEl.addEventListener("paste", onEditPaste);
  contentEl.addEventListener("click", onContentClick);
  contentEl.addEventListener("dblclick", onDiagramDblClick);
  contentEl.addEventListener("input", onEditInput);
  // Re-rendering mid-composition would destroy the IME session, so saves
  // (auto and flush) wait until composition ends.
  contentEl.addEventListener("compositionstart", () => {
    isComposing = true;
  });
  contentEl.addEventListener("compositionend", () => {
    isComposing = false;
    if (editingArmed && isDirty) scheduleSync();
  });
  // Autosave flushes on the way out too, so a quick close never loses the
  // last second of typing. Both are plain events; nothing polls.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushEdits();
  });
  window.addEventListener("blur", () => flushEdits());
  toastEl.addEventListener("click", () => {
    if (toastUrl) api().opener.openUrl(toastUrl);
  });
  for (const button of document.querySelectorAll(".seg [data-theme]")) {
    button.addEventListener("click", () => applyTheme(button.dataset.theme));
  }

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      if (editingArmed && settingsEl.hidden) {
        event.preventDefault();
        // A pending conflict makes this the explicit overwrite.
        syncNow({ force: conflictPending }).catch((error) => showToast(String(error)));
      }
      return;
    }
    if (event.key !== "Escape") return;
    const diagramModal = document.getElementById("mk-diagram-modal");
    if (diagramModal && !diagramModal.hidden) return;
    if (!settingsEl.hidden) {
      closeSettings();
      return;
    }
    if (editingArmed) cancelEditing();
  });

  document.addEventListener("click", async (event) => {
    const link = event.target.closest("a");
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (editingArmed && !event.metaKey && !event.ctrlKey && link.closest("[contenteditable]")) {
      // Plain click lands the caret in the label; ⌘-click still follows.
      event.preventDefault();
      return;
    }
    if (href.startsWith("#")) {
      if (editingArmed && link.closest("[contenteditable]")) event.preventDefault();
      return;
    }
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
      if (Date.now() - justSavedAt < 1200) return; // echo of our own save
      if (editingArmed && isDirty) {
        // Freeze syncing until the user decides: ⌘S overwrites, Esc loads.
        conflictPending = true;
        clearTimeout(syncTimer);
        syncTimer = 0;
        clearTimeout(reconcileTimer);
        reconcileTimer = 0;
        showToast("File changed on disk — ⌘S to overwrite, Esc to load it", { ms: 6000 });
        return;
      }
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

  api()
    .core.invoke("check_for_update")
    .then((info) => {
      if (info && info.version) {
        showToast(`Version ${info.version} is available`, {
          ms: 6000,
          url: info.url,
        });
      }
    })
    .catch(() => {
      /* offline or GitHub unreachable */
    });
}

boot();
