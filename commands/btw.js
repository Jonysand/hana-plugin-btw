// commands/btw.js — /btw 侧信道问答
//
// 等价于 Claude Code 的 /btw：
//   - 看到当前会话的完整上下文（通过 session:history 拉取已持久化的消息）
//   - 发起一次独立的 model:sample-text 调用（不携带 sessionId → 不写回会话）
//   - 回答通过 slash_result 通道以临时 inline notice 展示（宿主 3 秒自动消失），
//     同时写入插件历史（侧边栏 /btw 小窗常驻查看、复制、回看）
//   - 历史条目记录来源会话标题，便于回溯是哪段对话里的提问
//   - 生成期间写 status.json（pending 标记），侧边栏显示持续的「生成中」标识
//
// 三个性质：
//   1. 上下文可见：问题能看到当前对话在聊什么
//   2. 无工具：sample 调用本身不带工具，回答只来自已有上下文
//   3. 临时性：问题与回答都不写入会话记录，主对话无感知

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HISTORY_LIMIT = 50;
const HISTORY_CHAR_CAP = 12000;
const DEFAULT_MAX_TOKENS = 2000;
const MAX_TOKENS_LIMIT = 8000;
const TEMPERATURE = 0.3;
const HISTORY_MAX_ENTRIES = 20;

export const name = "btw";
export const description = "Ask a quick side question without adding it to the conversation（临时问一句，不污染会话，回答存侧边栏）";
export const scope = "session";
export const permission = "owner";
export const usage = "/btw <问题>";

// 数据文件：统一使用正式插件数据目录
// dev 与正式插件共用同一路径，保证 handler 与 route 读写一致
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

function debugFilePath() {
  return path.join(dataDirPath(), "debug.log");
}

// 调试日志：记录每次 /btw 的执行步骤，便于定位问题
function dbg(step, info) {
  try {
    const line = `${new Date().toISOString()} [${step}] ${info}\n`;
    fs.appendFileSync(debugFilePath(), line, "utf-8");
  } catch {}
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

function appendHistory(entry) {
  const fp = historyFilePath();
  const list = readHistory().filter((e) => e.question !== entry.question);
  list.unshift(entry);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(list.slice(0, HISTORY_MAX_ENTRIES), null, 2), "utf-8");
}

// 生成状态：pending 标记（侧边栏显示「生成中」），完成/失败后清除
function writeStatus(obj) {
  try {
    const fp = statusFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obj), "utf-8");
  } catch (err) {
    dbg("writeStatus-error", err?.message || String(err));
  }
}

function clearStatus() {
  try {
    fs.unlinkSync(statusFilePath());
  } catch {}
}

// 从会话历史提取可读文本上下文
async function loadContextText(hub, sessionRef) {
  if (!hub?.eventBus?.request) return null;
  const payload = sessionRef?.sessionId
    ? { sessionId: sessionRef.sessionId, limit: HISTORY_LIMIT }
    : sessionRef?.sessionPath
      ? { sessionPath: sessionRef.sessionPath, limit: HISTORY_LIMIT }
      : null;
  if (!payload) return null;

  const histRes = await hub.eventBus.request("session:history", payload);
  const hist = (histRes?.messages || []).filter(
    (m) => typeof m.content === "string" && m.content.trim()
  );
  if (hist.length === 0) return null;

  const lines = hist.map(
    (m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`
  );
  let text = lines.join("\n");
  if (text.length > HISTORY_CHAR_CAP) {
    text = "…（较早内容已截断）\n" + text.slice(-HISTORY_CHAR_CAP);
  }
  return text;
}

// 获取来源会话标题（用于历史条目回溯）
async function loadSessionTitle(hub, sessionRef) {
  if (!hub?.eventBus?.request) return null;
  const payload = sessionRef?.sessionId
    ? { sessionId: sessionRef.sessionId }
    : sessionRef?.sessionPath
      ? { sessionPath: sessionRef.sessionPath }
      : null;
  if (!payload) return null;
  try {
    const res = await hub.eventBus.request("session:get", payload);
    const title = res?.session?.title || res?.session?.firstMessage || null;
    return typeof title === "string" && title.trim() ? title.trim().slice(0, 60) : null;
  } catch {
    return null;
  }
}

export async function handler(ctx) {
  const question = (ctx.args || "").trim();
  if (!question) {
    return { error: "用法：/btw <问题>" };
  }

  const sessionId = ctx.sessionRef?.sessionId || null;
  const sessionPath = ctx.sessionRef?.sessionPath || null;
  dbg("enter", JSON.stringify({ question: question.slice(0, 60), sessionId, sessionPath }));

  // 生成中标记：立即落盘，侧边栏由此显示持续标识
  writeStatus({ pending: true, question, startedAt: Date.now() });

  try {
    let contextText = null;
    try {
      contextText = await loadContextText(ctx.hub, ctx.sessionRef);
      dbg("context", contextText ? `ok ${contextText.length} chars` : "empty");
    } catch (err) {
      dbg("context-error", err?.message || String(err));
    }

    const systemLines = [
      "你是侧信道问答助手（类似 Claude Code 的 /btw）。",
      contextText
        ? "下面给出当前会话的历史（完整语境，用户与助手的往来）。请贴合这段历史来理解并回答用户的最新问题，但不要把这段历史当作你自己的对话记录。"
        : "无法读取当前会话历史，请基于问题本身回答。",
      "你只能基于已有上下文回答：不能调用工具、读写文件、执行命令或联网搜索。",
      "回答简洁、直接、准确。",
    ];
    if (contextText) {
      systemLines.push("", "<会话历史>", contextText, "</会话历史>");
    }
    const systemPrompt = systemLines.join("\n");

    dbg("model-start", "calling model:sample-text");
    const result = await ctx.hub.eventBus.request("model:sample-text", {
      systemPrompt,
      messages: [{ role: "user", content: question }],
      temperature: TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      operation: "btw-side-question",
    });
    const text = result?.text || "";
    dbg("model-done", `len=${text.length} hasUsage=${!!result?.usage} usage=${JSON.stringify(result?.usage || {})}`);
    if (!text) {
      clearStatus();
      dbg("empty", "model returned empty text");
      return { error: "模型返回为空" };
    }

    // 来源会话标题（与上下文并行取，不阻塞主流程）
    const title = await loadSessionTitle(ctx.hub, ctx.sessionRef).catch((err) => {
      dbg("title-error", err?.message || String(err));
      return null;
    });

    // 落盘到插件历史（侧边栏 /btw 小窗可回看，3 秒通知消失后仍可取）
    try {
      appendHistory({
        question,
        answer: text,
        timestamp: Date.now(),
        sessionTitle: title,
        sessionPath,
      });
      dbg("history-write", "ok");
    } catch (err) {
      dbg("history-write-error", err?.message || String(err));
      clearStatus();
      return { error: "历史写入失败: " + (err?.message || String(err)) };
    }

    clearStatus();
    dbg("done", "ok");
    return { reply: text + "\n\n—— 回答已存入侧边栏「/btw」小窗，可随时回看。" };
  } catch (err) {
    clearStatus();
    dbg("fatal", err?.message || String(err));
    return { error: "问答失败: " + (err?.message || String(err)) };
  }
}
