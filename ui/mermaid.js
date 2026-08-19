let mermaidLoader = null;
let mermaidSeq = 0;

function mermaidPageIsDark() {
  if (typeof currentTheme === "function") {
    const theme = currentTheme();
    if (theme === "dark") return true;
    if (theme === "light") return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function mermaidThemeVariables() {
  if (mermaidPageIsDark()) {
    return {
      darkMode: true,
      background: "#191919",
      fontFamily:
        'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      fontSize: "14px",
      primaryColor: "#2a2a2a",
      primaryTextColor: "#e6e6e4",
      primaryBorderColor: "#3a3a3a",
      lineColor: "#9b9a97",
      secondaryColor: "#191919",
      tertiaryColor: "#2a2a2a",
      mainBkg: "#2a2a2a",
      nodeBorder: "#3a3a3a",
      clusterBkg: "#191919",
      clusterBorder: "#3a3a3a",
      titleColor: "#e6e6e4",
      edgeLabelBackground: "#191919",
      actorBkg: "#2a2a2a",
      actorBorder: "#3a3a3a",
      actorTextColor: "#e6e6e4",
      signalColor: "#9b9a97",
      labelBoxBkgColor: "#2a2a2a",
      labelTextColor: "#e6e6e4",
      noteBkgColor: "#2a2a2a",
      noteTextColor: "#e6e6e4",
    };
  }
  return {
    darkMode: false,
    background: "#f7f6f3",
    fontFamily:
      'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    fontSize: "14px",
    primaryColor: "#f1efe8",
    primaryTextColor: "#37352f",
    primaryBorderColor: "#e3e2de",
    lineColor: "#787774",
    secondaryColor: "#f7f6f3",
    tertiaryColor: "#ffffff",
    mainBkg: "#f1efe8",
    nodeBorder: "#e3e2de",
    clusterBkg: "#f7f6f3",
    clusterBorder: "#e3e2de",
    titleColor: "#37352f",
    edgeLabelBackground: "#f7f6f3",
    actorBkg: "#f1efe8",
    actorBorder: "#e3e2de",
    actorTextColor: "#37352f",
    signalColor: "#787774",
    labelBoxBkgColor: "#f1efe8",
    labelTextColor: "#37352f",
    noteBkgColor: "#f1efe8",
    noteTextColor: "#37352f",
  };
}

function isMermaidFence(code) {
  return /\blanguage-mermaid\b/i.test(code.className || "");
}

function mermaidNotify(message) {
  if (typeof showToast === "function") {
    showToast(message);
  }
}

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./vendor/mermaid.min.js";
      script.onload = () => {
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error("Mermaid failed to start."));
      };
      script.onerror = () => reject(new Error("Mermaid failed to load."));
      document.head.appendChild(script);
    }).catch((error) => {
      mermaidLoader = null;
      throw error;
    });
  }
  return mermaidLoader;
}

async function renderMermaid(root) {
  if (!root) return;
  const pending = [...root.querySelectorAll("pre > code")].filter(isMermaidFence);
  const holders = [...root.querySelectorAll(".mk-diagram")];
  if (!pending.length && !holders.length) return;

  const seq = ++mermaidSeq;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (error) {
    mermaidNotify(String(error));
    return;
  }
  if (seq !== mermaidSeq) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: mermaidThemeVariables(),
    flowchart: { htmlLabels: false, curve: "linear", useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });

  for (const code of pending) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE") continue;
    const holder = document.createElement("div");
    holder.className = "mk-diagram";
    holder.dataset.mermaid = code.textContent || "";
    pre.replaceWith(holder);
  }
  if (seq !== mermaidSeq) return;

  const targets = [...root.querySelectorAll(".mk-diagram")];
  for (let i = 0; i < targets.length; i += 1) {
    if (seq !== mermaidSeq) return;
    const holder = targets[i];
    const source = holder.dataset.mermaid || "";
    const id = `mk-mmd-${seq}-${i}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (seq !== mermaidSeq) return;
      holder.replaceChildren();
      holder.insertAdjacentHTML("afterbegin", svg);
    } catch {
      if (seq !== mermaidSeq) return;
      holder.replaceChildren();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = source;
      pre.append(code);
      holder.append(pre);
    }
  }
}
