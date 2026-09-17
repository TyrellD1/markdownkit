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
let toastTimer = 0;
let toastUrl = null;
let editingArmed = false;
let saveInFlight = false;
let justSavedAt = 0;
let isDirty = false;
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

// Reset the open document to its last-saved baseline, then arm rich-text
// editing when the setting is on. Toggling the setting discards unsaved
// keystrokes by design: the viewer is the source of truth until ⌘S.
function applyEditingToCurrentDocument() {
  if (!currentPath || pageEl.hidden) return;
  contentEl.innerHTML = lastHtml;
  renderMermaid(contentEl);
  if (editingEnabled()) armEditing();
  else disarmEditing();
}

// Blocks the rich-text editor owns: prose shapes whose DOM serializes back
// to markdown exactly. Code, tables, diagrams, and footnotes stay read-only;
// they re-render unchanged on save.
function isEditableCandidate(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  if (!/^(P|H[1-6]|LI)$/.test(el.tagName)) return false;
  if (el.closest("pre, table, .mk-diagram, .footnotes")) return false;
  const top = el.parentElement;
  if (top && top.parentElement === contentEl && top.tagName === "DIV" && !top.className) {
    return false; // footnote definition container
  }
  return true;
}

function armEditing() {
  if (!currentPath || pageEl.hidden) return;
  disarmEditing();
  for (const el of contentEl.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li")) {
    if (isEditableCandidate(el)) el.setAttribute("contenteditable", "plaintext-only");
  }
  for (const box of contentEl.querySelectorAll("li.task > input[type='checkbox']")) {
    box.disabled = false;
  }
  if (!contentEl.firstElementChild) {
    const p = document.createElement("p");
    p.setAttribute("contenteditable", "plaintext-only");
    p.append(document.createElement("br"));
    contentEl.append(p);
  }
  editingArmed = true;
  pageEl.classList.add("is-editing");
}

function disarmEditing() {
  for (const el of contentEl.querySelectorAll("[contenteditable]")) {
    el.removeAttribute("contenteditable");
  }
  for (const box of contentEl.querySelectorAll("li.task > input[type='checkbox']")) {
    box.disabled = true;
  }
  editingArmed = false;
  pageEl.classList.remove("is-editing");
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
    showToast("Unsaved edits discarded");
  }
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
  renderMermaid(contentEl);
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
  for (const child of [...el.childNodes]) out += serializeInlineNode(child);
  return out;
}

function serializeInlineNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
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
    const text = serializeInlineChildren(node).trim();
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

function serializeList(list, depth) {
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
    const pad = "  ".repeat(depth);
    const segments = [];
    let head = "";
    const flushHead = () => {
      if (head) {
        segments.push(head);
        head = "";
      }
    };
    for (const child of [...li.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === "UL" || child.tagName === "OL")) {
        flushHead();
        const nested = serializeList(child, depth + 1);
        if (nested) segments.push(nested);
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
    const first = (segments.shift() || "").trim();
    lines.push(pad + marker + first);
    const continuationPad = pad + " ".repeat(marker.length);
    for (const segment of segments) {
      for (const line of String(segment).split("\n")) {
        lines.push(line ? continuationPad + line : continuationPad.trimEnd());
      }
    }
  }
  return lines.join("\n");
}

function serializeTable(table) {
  const rows = [...table.querySelectorAll("tr")];
  if (!rows.length) return "";
  const cellsOf = (row) =>
    [...row.children]
      .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
      .map((cell) => serializeInlineChildren(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "));
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
  if (/^H[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${serializeInlineChildren(el).trim()}`;
  if (tag === "P" || tag === "DIV") {
    if (!el.textContent && !el.querySelector("img, input")) return "";
    return serializeInlineChildren(el).replace(/\\\n?$/, "").trim();
  }
  if (tag === "UL" || tag === "OL") return serializeList(el, 0);
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
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (tag === "PRE") {
    const code = el.querySelector("code");
    const match = (code?.className || "").match(/language-([\w+-]+)/);
    const text = (code?.textContent ?? el.textContent).replace(/\n$/, "");
    return `\`\`\`${match ? match[1] : ""}\n${text}\n\`\`\``;
  }
  if (el.classList.contains("mk-diagram")) {
    const source = (el.dataset.mermaid || "").replace(/^\s+|\s+$/g, "");
    return `\`\`\`mermaid\n${source}\n\`\`\``;
  }
  if (tag === "TABLE") return serializeTable(el);
  if (tag === "HR") return "---";
  if (tag === "DIV" && !el.className && el.id) {
    const paragraphs = [...el.querySelectorAll(":scope > p")].map((p) =>
      serializeInlineChildren(p).trim(),
    );
    return `[^${el.id}]: ` + paragraphs.join("\n    ");
  }
  return serializeInlineChildren(el).trim();
}

function serializeBody() {
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

function editableBlockOf(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el?.closest?.("[contenteditable]") ?? null;
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

function makeEditable(tag) {
  const el = document.createElement(tag);
  el.setAttribute("contenteditable", "plaintext-only");
  return el;
}

function convertParagraphToHeading(p, level) {
  const h = makeEditable(`h${level}`);
  h.append(...p.childNodes);
  p.replaceWith(h);
  setCaretToStart(h);
}

function wrapParagraphInList(p, kind, task, checked) {
  const list = document.createElement(kind);
  const li = makeEditable("li");
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
  const inner = makeEditable("p");
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
  if (block.tagName !== "P" || block.closest("li")) return;
  const offset = caretOffsetIn(block);
  if (offset == null) return;
  const before = block.textContent.slice(0, offset);
  const rest = block.textContent.slice(offset);
  let heading = null;
  if (/^(#{1,6})$/.test(before)) heading = before.length;
  const convert = (fn) => {
    event.preventDefault();
    block.textContent = rest;
    fn();
  };
  if (heading) convert(() => convertParagraphToHeading(block, heading));
  else if (/^(-|\*)$/.test(before)) convert(() => wrapParagraphInList(block, "UL", false));
  else if (/^1\.$/.test(before)) convert(() => wrapParagraphInList(block, "OL", false));
  else if (/^(\[\]|\[x\])$/i.test(before)) {
    convert(() => wrapParagraphInList(block, "UL", true, /x/i.test(before)));
  } else if (/^>$/.test(before)) convert(() => wrapParagraphInBlockquote(block));
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
  const p = makeEditable("p");
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
    const p = makeEditable("p");
    p.append(document.createElement("br"));
    block.replaceWith(hr, p);
    setCaretToStart(p);
    return;
  }
  if (block.tagName === "LI" && !block.querySelector("ul, ol") && block.textContent.trim() === "") {
    event.preventDefault();
    if (!outdentListItem(block)) exitListToParagraph(block);
    return;
  }
  // Let the browser split the block, then normalize the Notion-unlike parts:
  // a heading split stays a heading only when text remains; a trailing split
  // becomes a paragraph, and stray divs become paragraphs.
  queueMicrotask(() => {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const now = editableBlockOf(sel.anchorNode);
    if (!now || now === block || !contentEl.contains(now)) return;
    if (!now.hasAttribute("contenteditable")) {
      now.setAttribute("contenteditable", "plaintext-only");
    }
    if (/^H[1-6]$/.test(block.tagName) && /^H[1-6]$/.test(now.tagName) && !now.textContent.trim()) {
      const p = makeEditable("p");
      p.append(...now.childNodes);
      now.replaceWith(p);
      setCaretToStart(p);
    } else if (now.tagName === "DIV" && now.parentElement === contentEl) {
      const p = makeEditable("p");
      p.append(...now.childNodes);
      now.replaceWith(p);
      setCaretToStart(p);
    } else if (now.tagName === "LI" && now.classList.contains("task") && !now.textContent.trim()) {
      const box = now.querySelector(":scope > input[type='checkbox']");
      if (box) box.checked = false;
    }
  });
}

function onBackspaceKey(event, block) {
  const offset = caretOffsetIn(block);
  if (offset !== 0) return;
  if (/^H[1-6]$/.test(block.tagName) && !block.textContent) {
    event.preventDefault();
    const p = makeEditable("p");
    p.append(...block.childNodes);
    block.replaceWith(p);
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
      const p = makeEditable("p");
      p.append(...[...li.childNodes].filter((node) => node.tagName !== "INPUT"));
      li.replaceWith(p);
      setCaretToStart(p);
    }
  } else {
    indentListItem(li);
  }
}

function wrapSelection(marker) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    showToast("Select text first");
    return;
  }
  const range = sel.getRangeAt(0);
  const startBlock = editableBlockOf(range.startContainer);
  const endBlock = editableBlockOf(range.endContainer);
  if (!startBlock || startBlock !== endBlock) return;
  const selected = range.extractContents();
  const open = document.createTextNode(marker);
  const close = document.createTextNode(marker);
  range.insertNode(open);
  const mid = range.cloneRange();
  mid.setStartAfter(open);
  mid.collapse(true);
  mid.insertNode(selected);
  const end = range.cloneRange();
  end.setStartAfter(selected.lastChild || open);
  end.collapse(true);
  end.insertNode(close);
  end.setStartAfter(close);
  end.collapse(true);
  sel.removeAllRanges();
  sel.addRange(end);
}

function wrapSelectionAsLink() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) {
    showToast("Select text first");
    return;
  }
  const range = sel.getRangeAt(0);
  const startBlock = editableBlockOf(range.startContainer);
  const endBlock = editableBlockOf(range.endContainer);
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
}

function handleInlineShortcut(event, block) {
  if (!editableBlockOf(event.target)) return;
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
// some engines). Multi-line pastes split into blocks like Enter would.
function onEditPaste(event) {
  if (!editingArmed) return;
  const block = editableBlockOf(event.target);
  if (!block || !contentEl.contains(block)) return;
  const text = (event.clipboardData?.getData("text/plain") || "").replace(/\r\n?/g, "\n");
  if (!text) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
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
}

function nextBlockFor(current) {
  let tag = current.tagName;
  if (/^H[1-6]$/.test(tag) || tag === "DIV") tag = "P";
  const next = makeEditable(tag);
  if (tag === "LI" && current.classList.contains("task")) {
    next.className = "task";
    next.append(makeTaskCheckbox(false), document.createTextNode(" "));
  }
  return next;
}

async function saveNow() {
  if (!editingArmed || !currentPath || saveInFlight) return;
  saveInFlight = true;
  justSavedAt = Date.now();
  const caret = captureCaret();
  const scroll = document.getElementById("app").scrollTop;
  try {
    const doc = await api().core.invoke("save_document", {
      path: currentPath,
      body: serializeBody(),
    });
    currentPath = doc.path;
    isDirty = false;
    renderDocument(doc, { keepScroll: scroll });
    restoreCaret(caret);
  } catch (error) {
    showToast(String(error));
  } finally {
    saveInFlight = false;
  }
}

function onContentKeydown(event) {
  if (!editingArmed) return;
  const block = editableBlockOf(event.target);
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

// Task boxes stay functional controls while armed: toggle explicitly instead
// of relying on native behavior inside contenteditable, then save at once.
function onContentClick(event) {
  if (!editingArmed) return;
  const box = event.target?.closest?.("li.task > input[type='checkbox']");
  if (!box || !contentEl.contains(box)) return;
  event.preventDefault();
  box.checked = !box.checked;
  isDirty = true;
  saveNow().catch((error) => showToast(String(error)));
}

function cancelEditing() {
  if (!editingArmed) return;
  if (document.activeElement) document.activeElement.blur();
  isDirty = false;
  contentEl.innerHTML = lastHtml;
  renderMermaid(contentEl);
  if (editingEnabled()) armEditing();
  else disarmEditing();
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
  contentEl.addEventListener("input", () => {
    if (editingArmed) isDirty = true;
  });
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
        saveNow().catch((error) => showToast(String(error)));
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
        showToast("File changed on disk — ⌘S to overwrite, Esc to reload", { ms: 5000 });
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
