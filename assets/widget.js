// assets/widget.js — /btw 问答记录小窗前端
(() => {
  "use strict";

  // 主题跟随：宿主发 set-theme 时，把 hana-css link 的 theme 参数换掉，
  // CSS 变量由宿主主题文件提供，界面颜色与 Hana 完全一致。
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    const theme = m.type === "set-theme" ? (m.theme || (m.data && m.data.theme)) : null;
    if (!theme) return;
    const link = document.querySelector('link[href*="theme.css"]');
    if (!link) return;
    try {
      const u = new URL(link.href);
      u.searchParams.set("theme", theme);
      link.href = u.toString();
    } catch {}
  });

  const list = document.getElementById("list");
  const clearBtn = document.getElementById("clear");
  const dot = document.getElementById("dot");
  const spinner = document.getElementById("spinner");
  const statusText = document.getElementById("statusText");
  if (!list) return;

  function authQuery() {
    const t = new URLSearchParams(window.location.search).get("token");
    return t ? "?token=" + encodeURIComponent(t) : "";
  }

  async function loadHistory() {
    const res = await fetch(window.HANA_PLUGIN_BASE + "/api/history" + authQuery());
    const data = await res.json().catch(() => ({}));
    return data.ok ? data.entries : [];
  }

  async function loadStatus() {
    const res = await fetch(window.HANA_PLUGIN_BASE + "/api/status" + authQuery());
    const data = await res.json().catch(() => ({}));
    return data.ok ? data : { pending: false };
  }

  async function deleteEntry(ts) {
    await fetch(window.HANA_PLUGIN_BASE + "/api/history" + authQuery() + "&ts=" + encodeURIComponent(ts), {
      method: "DELETE",
    });
  }

  async function clearHistory() {
    await fetch(window.HANA_PLUGIN_BASE + "/api/history" + authQuery(), { method: "DELETE" });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  /* ── 生成状态：空闲绿点 / 生成中 spinner + 文字 ── */
  function setPending(pending, question) {
    if (!dot || !spinner || !statusText) return;
    dot.hidden = pending;
    spinner.hidden = !pending;
    statusText.textContent = pending
      ? "生成中" + (question ? " · " + question.slice(0, 14) + (question.length > 14 ? "…" : "") : "")
      : "";
  }

  /* ── 轻量 Markdown 渲染（先转义再渲染，防注入） ── */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(text).split("\n");
    const out = [];
    let inCode = false;
    let codeBuf = [];
    let listType = null;

    const closeList = () => {
      if (listType) { out.push("</" + listType + ">"); listType = null; }
    };

    for (const line of lines) {
      const trimmed = line.trimStart();

      if (trimmed.startsWith("```")) {
        if (inCode) {
          out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
          codeBuf = [];
          inCode = false;
        } else {
          closeList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push("<li>" + renderInline(ul[1]) + "</li>");
        continue;
      }
      const ol = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push("<li>" + renderInline(ol[1]) + "</li>");
        continue;
      }
      closeList();

      const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
      if (h) {
        const n = h[1].length;
        out.push("<h" + n + ">" + renderInline(h[2]) + "</h" + n + ">");
        continue;
      }
      if (trimmed.startsWith("&gt; ")) {
        out.push("<blockquote>" + renderInline(trimmed.slice(5)) + "</blockquote>");
        continue;
      }
      if (!line.trim()) { out.push('<div class="md-sp"></div>'); continue; }
      out.push("<p>" + renderInline(line) + "</p>");
    }
    if (inCode) out.push("<pre><code>" + codeBuf.join("\n") + "</code></pre>");
    closeList();
    return out.join("\n");
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = Date.now();
    const diffMin = Math.round((now - ts) / 60000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const md = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前 · ${hhmm}`;
    if (diffMin < 1440 && d.getDate() === new Date().getDate()) return `今天 ${hhmm}`;
    return `${md} ${hhmm}`;
  }

  // diff 渲染：数据签名不变就不重绘，消除轮询/SSE 双事件导致的闪烁
  let lastSig = null;
  let firstRender = true;

  function render(entries) {
    const sig = JSON.stringify(entries.map((e) => [e.question, e.answer, e.timestamp, e.sessionTitle]));
    if (sig === lastSig) return;
    const hadData = !firstRender && lastSig !== null && lastSig !== "[]";
    lastSig = sig;
    firstRender = false;

    list.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML =
        '<div class="mark">“</div>' +
        '<div class="msg">在对话里临时问一句，<br/>这里会长出答案。</div>' +
        '<div class="kbd">输入 <b>/btw</b> 问题</div>';
      list.appendChild(empty);
      return;
    }
    entries.forEach((e, i) => {
      const entry = document.createElement("div");
      // 已有数据时的首条（新来的）自动展开；其余默认折叠成一行
      const isNew = hadData && i === 0;
      entry.className = "entry" + (isNew ? " fresh open" : "");
      entry.style.animationDelay = (i * 0.03) + "s";

      const q = document.createElement("div");
      q.className = "q";
      const qtext = document.createElement("span");
      qtext.className = "qtext";
      qtext.textContent = e.question;
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▸";
      q.append(qtext, chev);
      q.title = e.question;
      q.addEventListener("click", () => entry.classList.toggle("open"));

      const aWrap = document.createElement("div");
      aWrap.className = "a-wrap";
      const a = document.createElement("div");
      a.className = "a md";
      a.innerHTML = renderMarkdown(e.answer || "");
      aWrap.appendChild(a);

      const meta = document.createElement("div");
      meta.className = "meta";

      const metaLeft = document.createElement("div");
      metaLeft.className = "meta-left";
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = e.timestamp ? fmtTime(e.timestamp) : "";
      if (e.sessionTitle) {
        const session = document.createElement("span");
        session.className = "session";
        session.textContent = e.sessionTitle;
        session.title = "来源会话：" + e.sessionTitle;
        metaLeft.append(session, time);
      } else {
        metaLeft.appendChild(time);
      }

      const metaRight = document.createElement("div");
      metaRight.className = "meta-right";

      const copy = document.createElement("button");
      copy.className = "btn-copy";
      copy.textContent = "复制";
      copy.addEventListener("click", async () => {
        const ok = await copyText("Q: " + e.question + "\n\nA: " + e.answer);
        if (ok) {
          copy.classList.add("copied");
          copy.textContent = "已复制";
          setTimeout(() => {
            copy.classList.remove("copied");
            copy.textContent = "复制";
          }, 1400);
        } else {
          copy.textContent = "失败";
          setTimeout(() => (copy.textContent = "复制"), 1400);
        }
      });

      // 单条删除：两段确认防误触
      const del = document.createElement("button");
      del.className = "btn-del";
      del.textContent = "删除";
      let delArmed = false;
      let delTimer = null;
      del.addEventListener("click", async () => {
        if (!delArmed) {
          delArmed = true;
          del.classList.add("armed");
          del.textContent = "确认？";
          delTimer = setTimeout(() => {
            delArmed = false;
            del.classList.remove("armed");
            del.textContent = "删除";
          }, 2500);
          return;
        }
        clearTimeout(delTimer);
        delArmed = false;
        del.classList.remove("armed");
        del.textContent = "删除";
        await deleteEntry(e.timestamp);
        lastSig = null;
        loadHistory().then(render).catch(() => {});
      });

      metaRight.append(copy, del);
      meta.append(metaLeft, metaRight);
      entry.append(q, aWrap, meta);
      list.appendChild(entry);
    });
  }

  // 清空：两段确认，防误触
  let clearArmed = false;
  let clearTimer = null;
  clearBtn.addEventListener("click", async () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.classList.add("confirm");
      clearBtn.textContent = "确认清空？";
      clearTimer = setTimeout(() => {
        clearArmed = false;
        clearBtn.classList.remove("confirm");
        clearBtn.textContent = "清空";
      }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    clearBtn.classList.remove("confirm");
    clearBtn.textContent = "清空";
    await clearHistory();
    lastSig = null;
    render([]);
  });

  // 统一刷新：历史 + 状态
  async function refreshAll() {
    const [entries, status] = await Promise.all([loadHistory().catch(() => []), loadStatus().catch(() => ({ pending: false }))]);
    render(entries);
    setPending(status.pending === true, status.question);
  }

  // SSE 即时刷新：refresh 事件防抖合并（Windows 写文件可能触发双事件）
  function connectStream() {
    try {
      const es = new EventSource(window.HANA_PLUGIN_BASE + "/api/stream" + authQuery());
      let refreshTimer = null;
      es.onmessage = (ev) => {
        if (ev.data !== "refresh") return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshAll, 250);
      };
      es.onerror = () => {};
    } catch {}
  }

  refreshAll();
  connectStream();
  // 兜底轮询（SSE 失效时仍能刷新）；diff 渲染保证无变化不重绘
  setInterval(refreshAll, 15000);
})();
