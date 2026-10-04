// routes/ui.js — /btw 侧信道问答：侧边栏历史小窗
//
// GET  /widget              历史小窗页面（常驻展示 /btw 问答记录）
// GET  /api/history         读取历史
// GET  /api/status          读取生成状态（pending 时侧栏显示「生成中」）
// GET  /api/stream          SSE 推送：history/status 变更时通知小窗即时刷新
// DELETE /api/history       清空历史（?ts=xxx 删单条；无参数清空全部）
//
// 数据文件与 commands/btw.js 的 handler 共用同一路径
// （<HANA_HOME>/plugin-data/btw/{history,status}.json），保证读写一致。
//
// 主题：widget 页面在 <head> 引入宿主下发的 hana-css（theme.css），
// 全部样式消费 Hana 主题 CSS 变量（--bg-card/--text/--text-light/
// --text-muted/--border/--accent/--green/--danger 等），与 Hana 界面一致。
// 注意：不能用 :root 兜底变量（会覆盖 link 加载的主题变量），
// 所有 var() 必须带 fallback 值（var(--x, fallback)）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function dataDirPath() {
  const home = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  return path.join(home, "plugin-data", "btw");
}

function historyFilePath() {
  return path.join(dataDirPath(), "history.json");
}

function statusFilePath() {
  return path.join(dataDirPath(), "status.json");
}

function readHistory() {
  try {
    const fp = historyFilePath();
    if (!fs.existsSync(fp)) return [];
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeHistory(list) {
  try {
    fs.mkdirSync(dataDirPath(), { recursive: true });
    fs.writeFileSync(historyFilePath(), JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    throw err;
  }
}

function readStatus() {
  try {
    const fp = statusFilePath();
    if (!fs.existsSync(fp)) return { pending: false };
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    return data && data.pending === true ? data : { pending: false };
  } catch {
    return { pending: false };
  }
}

export default function (app, ctx) {
  const base = `/api/plugins/${ctx.pluginId}`;

  app.get("/widget", (c) => {
    const token = c.req.query("token") || "";
    // 宿主打开 iframe 时在 URL 上带的主题样式地址（含 token）
    const cssUrl = c.req.query("hana-css") || "";
    const cssLink = cssUrl ? `<link rel="stylesheet" href="${cssUrl.replace(/"/g, "&quot;")}" />` : "";
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>/btw 问答记录</title>
${cssLink}
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: transparent; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 13px; color: var(--text, #d5dae1);
  }

  .wrap { padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 10px; }

  /* ── 头部 ── */
  .head { display: flex; align-items: baseline; justify-content: space-between; }
  .title { display: flex; align-items: baseline; gap: 7px; }
  .t-slash { font-family: "JetBrains Mono", Consolas, monospace; font-size: 15px; color: var(--accent, #8fb6f5); font-weight: 700; }
  .t-name { font-family: "JetBrains Mono", Consolas, monospace; font-size: 15px; color: var(--text, #e6ecf3); font-weight: 600; letter-spacing: .02em; }
  .t-sub { font-size: 12.5px; color: var(--text-muted, #7c8691); letter-spacing: .08em; }
  .head-right { display: flex; align-items: center; gap: 9px; }

  /* 状态区：空闲绿点 / 生成中 spinner + 文字 */
  .status { display: flex; align-items: center; gap: 5px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green, #7fd39a); box-shadow: 0 0 6px rgba(127, 211, 154, .5); }
  .spinner {
    width: 11px; height: 11px; border-radius: 50%;
    border: 2px solid var(--border, rgba(140,150,165,.22));
    border-top-color: var(--accent, #8fb6f5);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-text { font-size: 10.5px; color: var(--text-muted, #7c8691); letter-spacing: .03em; white-space: nowrap; }

  .btn-clear {
    font-family: "JetBrains Mono", Consolas, monospace; font-size: 10.5px; color: var(--text-muted, #7c8691);
    background: var(--overlay-subtle, rgba(255,255,255,.04)); border: 1px solid var(--border, rgba(140,150,165,.22)); border-radius: 4px;
    padding: 2px 8px; cursor: pointer; transition: all .18s ease; letter-spacing: .04em;
  }
  .btn-clear:hover { color: var(--danger, #f0706b); border-color: var(--danger, #f0706b); }
  .btn-clear.confirm { color: var(--danger, #f0706b); border-color: var(--danger, #f0706b); background: rgba(240, 112, 107, .1); }

  /* 细分隔线 */
  .rule { height: 1px; background: linear-gradient(90deg, var(--border, rgba(140,150,165,.22)) 0%, var(--border, rgba(140,150,165,.22)) 55%, transparent 100%); }

  .list { display: flex; flex-direction: column; gap: 10px; }

  /* ── 条目卡片 ── */
  .entry {
    position: relative; border: 1px solid var(--border, rgba(140,150,165,.22)); border-radius: 8px;
    background: var(--bg-card, #23272e); overflow: hidden;
    animation: rise .32s ease both;
    transition: border-color .2s ease;
  }
  .entry::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: linear-gradient(180deg, var(--accent, #8fb6f5), transparent);
    opacity: .4;
  }
  .entry:hover { border-color: var(--overlay-strong, rgba(255,255,255,.14)); }
  .entry.fresh::before { opacity: .9; }
  .entry.fresh { border-color: rgba(127, 211, 154, .4); }
  @keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

  .q {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 9px 12px 7px 15px; font-size: 12.5px; font-weight: 600;
    color: var(--text, #e6ecf3); line-height: 1.5; word-break: break-word;
    border-bottom: 1px dashed var(--border, rgba(140,150,165,.22));
    cursor: pointer; user-select: none;
    transition: background .18s ease;
  }
  .q:hover { background: var(--overlay-subtle, rgba(255,255,255,.04)); }
  .q .qtext { flex: 1; min-width: 0; }
  .q .chev {
    flex-shrink: 0; font-size: 10px; color: var(--text-muted, #7c8691);
    transition: transform .22s ease; transform: rotate(0deg);
    line-height: 1; padding: 2px;
  }
  .entry.open .chev { transform: rotate(90deg); color: var(--accent, #8fb6f5); }
  .a-wrap { display: none; }
  .entry.open .a-wrap {
    display: block;
    animation: fadein .22s ease;
  }
  @keyframes fadein { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  .a {
    padding: 9px 12px 7px 15px; word-break: break-word;
    line-height: 1.7; font-size: 12.5px; color: var(--text-light, #aab3bd);
    border-bottom: 1px dashed var(--border, rgba(140,150,165,.22));
  }
  /* ── Markdown 渲染样式 ── */
  .a p { margin: 0 0 7px; }
  .a p:last-child { margin-bottom: 0; }
  .a .md-sp { height: 5px; }
  .a h1, .a h2, .a h3, .a h4 { margin: 10px 0 5px; color: var(--text, #e6ecf3); line-height: 1.4; }
  .a h1 { font-size: 15px; } .a h2 { font-size: 14px; } .a h3, .a h4 { font-size: 13px; }
  .a strong { color: var(--text, #e6ecf3); font-weight: 700; }
  .a a { color: var(--link, var(--accent, #8fb6f5)); text-decoration: none; }
  .a a:hover { text-decoration: underline; }
  .a ul, .a ol { margin: 4px 0 8px; padding-left: 20px; }
  .a li { margin: 2px 0; }
  .a blockquote {
    border-left: 2px solid var(--accent, #8fb6f5); margin: 4px 0 8px;
    padding: 2px 10px; color: var(--text-muted, #7c8691);
  }
  .a pre {
    background: var(--overlay-medium, rgba(255,255,255,.07));
    border: 1px solid var(--border, rgba(140,150,165,.22)); border-radius: 5px;
    padding: 7px 9px; margin: 4px 0 9px; overflow-x: auto;
    font-family: "JetBrains Mono", Consolas, monospace; font-size: 11.5px; line-height: 1.55;
    color: var(--text, #e6ecf3);
  }
  .a code {
    font-family: "JetBrains Mono", Consolas, monospace; font-size: 11.5px;
    background: var(--overlay-medium, rgba(255,255,255,.07)); border-radius: 3px; padding: 0 4px;
  }
  .a pre code { background: none; padding: 0; }

  .meta {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 3px 10px 7px 15px; flex-wrap: wrap;
  }
  .meta-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .session {
    font-size: 10.5px; color: var(--accent, #8fb6f5);
    border: 1px solid var(--border, rgba(140,150,165,.22)); border-radius: 3px;
    padding: 0 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px;
  }
  .time { font-family: "JetBrains Mono", Consolas, monospace; font-size: 10px; color: var(--text-muted, #7c8691); letter-spacing: .05em; white-space: nowrap; }
  .meta-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .btn-copy, .btn-del {
    font-family: "JetBrains Mono", Consolas, monospace; font-size: 10.5px;
    background: none; border: 1px solid var(--border, rgba(140,150,165,.22)); border-radius: 4px;
    padding: 1.5px 9px; cursor: pointer; transition: all .18s ease; letter-spacing: .04em;
  }
  .btn-copy { color: var(--accent, #8fb6f5); }
  .btn-copy:hover { border-color: var(--accent, #8fb6f5); }
  .btn-copy.copied { color: var(--green, #7fd39a); border-color: var(--green, #7fd39a); }
  .btn-del { color: var(--text-muted, #7c8691); opacity: .75; }
  .btn-del:hover { color: var(--danger, #f0706b); border-color: var(--danger, #f0706b); opacity: 1; }
  .btn-del.armed { color: var(--danger, #f0706b); border-color: var(--danger, #f0706b); background: rgba(240, 112, 107, .1); }

  /* ── 空状态 ── */
  .empty { text-align: center; padding: 34px 14px 28px; }
  .empty .mark { font-family: Georgia, "Times New Roman", serif; font-size: 26px; color: var(--text-muted, #7c8691); line-height: 1; }
  .empty .msg { margin-top: 10px; font-size: 12.5px; color: var(--text-muted, #7c8691); letter-spacing: .04em; }
  .empty .kbd { margin-top: 14px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 11px; color: var(--text-muted, #7c8691); }
  .empty .kbd b { color: var(--accent, #8fb6f5); font-weight: 600; }

  .foot {
    text-align: center; font-family: "JetBrains Mono", Consolas, monospace; font-size: 9.5px;
    color: var(--text-muted, #7c8691); letter-spacing: .14em; padding-top: 2px;
  }
  .foot b { color: var(--green, #7fd39a); font-weight: 600; }
</style>
</head>
<body>
  <div class="wrap">
    <header class="head">
      <div class="title"><span class="t-slash">/</span><span class="t-name">btw</span><span class="t-sub">问答记录</span></div>
      <div class="head-right">
        <span class="status" id="status">
          <span class="dot" id="dot"></span>
          <span class="spinner" id="spinner" hidden></span>
          <span class="status-text" id="statusText"></span>
        </span>
        <button id="clear" class="btn-clear">清空</button>
      </div>
    </header>
    <div class="rule"></div>
    <div id="list" class="list"></div>
    <footer class="foot">OFF-RECORD · <b>不</b>落盘 · 常驻于此</footer>
  </div>
  <script>window.HANA_TOKEN=${JSON.stringify(token)};window.HANA_PLUGIN_BASE=${JSON.stringify(base)};</script>
  <script src="${base}/assets/widget.js?token=${encodeURIComponent(token)}&v=8"><\/script>
  <script>
    window.parent.postMessage({ type: "ready" }, "*");
    window.parent.postMessage({ protocol: "hana.plugin.ui", version: 1, kind: "event", type: "hana.ready" }, "*");
  </script>
</body>
</html>`;
    return c.html(html);
  });

  // 读取历史
  app.get("/api/history", (c) => {
    const list = readHistory();
    return c.json({ ok: true, entries: list });
  });

  // 读取生成状态
  app.get("/api/status", (c) => {
    return c.json({ ok: true, ...readStatus() });
  });

  // 删除历史：?ts=xxx 删单条；无参数清空全部
  app.delete("/api/history", (c) => {
    try {
      const tsRaw = c.req.query("ts");
      if (tsRaw) {
        const ts = Number(tsRaw);
        if (!Number.isFinite(ts)) {
          return c.json({ ok: false, code: "bad_ts", message: "ts 参数无效" }, 400);
        }
        const before = readHistory();
        const after = before.filter((e) => e.timestamp !== ts);
        if (after.length === before.length) {
          return c.json({ ok: false, code: "not_found", message: "未找到该记录" }, 404);
        }
        writeHistory(after);
        return c.json({ ok: true, removed: before.length - after.length });
      }
      // 清空全部
      writeHistory([]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, message: err.message }, 500);
    }
  });

  // SSE 推送：history/status 变更时通知小窗即时刷新
  app.get("/api/stream", (c) => {
    const encoder = new TextEncoder();
    // 确保监听目录存在（清空后目录仍在；首次写入前需要创建）
    try { fs.mkdirSync(dataDirPath(), { recursive: true }); } catch {}

    let closed = false;
    let watcher = null;
    let heartbeat = null;
    const stream = new ReadableStream({
      start(controller) {
        // 初始握手
        try { controller.enqueue(encoder.encode("data: ready\n\n")); } catch {}

        // 监听目录：history.json / status.json 变更 → 推送 refresh
        try {
          watcher = fs.watch(dataDirPath(), { persistent: false });
          watcher.on("change", (eventType, filename) => {
            const name = String(filename || "").toLowerCase();
            if (!name.includes("history") && !name.includes("status")) return;
            if (closed) return;
            try { controller.enqueue(encoder.encode("data: refresh\n\n")); } catch {}
          });
          watcher.on("error", () => {});
        } catch {}

        // 心跳注释行，防代理/宿主空闲断连
        heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(": ping\n\n")); } catch {}
        }, 20000);
      },
      cancel() {
        closed = true;
        clearInterval(heartbeat);
        try { watcher?.close(); } catch {}
      },
    });

    return c.body(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });
}
