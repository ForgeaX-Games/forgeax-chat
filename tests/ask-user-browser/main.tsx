import { AskUserBatch } from '../../src/components/ChatPanel/message-parts/AskUserCard';
import { ExecutionFailure } from '../../src/components/ChatPanel/ExecutionFailure';
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { StepRow } from "../../src/components/ChatPanel/StepRow";
import { MarkdownView } from "../../src/components/ChatPanel/MarkdownView";
import { projectWorkTimeline } from "../../src/task-flow/project";
import "../../src/components/ChatPanel/TaskFlow.css";
import { setLocale } from "@forgeax/interface/i18n";
import "../../src/components/ChatPanel/ChatPanel.css";
setLocale("zh", { persist: false });
const questions = [
  {
    id: "gameplay",
    header: "玩法",
    question: "你希望采用哪种核心玩法？",
    options: [
      {
        label: "泡泡射击消除",
        description: "发射泡泡，消除三个或更多相同颜色的组合。",
      },
      {
        label: "吹泡泡计分",
        description: "按住蓄力，在合适时机松开获得分数。",
      },
      { label: "收集与成长", description: "收集资源，解锁新的能力。" },
    ],
  },
  {
    id: "view",
    header: "视角",
    question: "你希望采用哪种游戏视角？",
    options: [
      { label: "2D 正面视角", description: "清晰呈现棋盘和瞄准方向。" },
      { label: "3D 俯视角", description: "在立体场景中观察和操作。" },
    ],
  },
  {
    id: "scope",
    header: "制作范围",
    question: "首个版本需要包含哪些内容？",
    multiSelect: true,
    options: [
      { label: "可玩单关" },
      { label: "计分与重新开始" },
      { label: "音效与音乐" },
    ],
  },
];
function App() {
  const [sid, S] = useState("preview-a");
  const [mode, M] = useState("group");
  const [reset, R] = useState(0);
  const [fail, F] = useState(false);
  const [count, C] = useState(0);
  const [payload, P] = useState("");
  window.fetch = async (url, init) => {
    if (String(url).endsWith("/ask-reply")) {
      C((n) => n + 1);
      P(init.body);
      return new Response(
        JSON.stringify(
          fail
            ? { ok: false, reason: "提交失败，选择已保留，请重试。" }
            : { ok: true },
        ),
        { status: fail ? 503 : 200 },
      );
    }
    return new Response("{}");
  };
  const qs =
    mode === "single"
      ? [questions[0]]
      : mode === "text"
        ? [{ id: "text", question: "请描述你想要的游戏风格。" }]
        : questions;
  const projection = projectWorkTimeline([{
    toolCalls: [], id: "assistant-preview", role: "assistant", ts: 1, status: "streaming", text: "", turnId: "preview-turn",
    segments: [
      {kind: "text", text: "我先查看项目，再确认几个制作方向。", ts: 1},
      {kind: "tool", tool: {callId: "read", name: "read_file", args: {path: "src/main.ts"}, status: "done"}, ts: 2},
      {kind: "text", text: "确认以下几个方向后，我会继续制作游戏。", ts: 3},
      {kind: "tool", tool: {callId: mode + reset, name: "ask_user", args: {questions: qs}, status: mode === "expired" ? "error" : "running"}, ts: 4},
    ],
  }], {sid, ownerAgentId: "forge"});
  return (
    <main>
      <header>
        <h1>多步骤选择器</h1>
        <p>真实 Chat 组件交互预览 · 固定题目与模拟提交，不调用模型</p>
      </header>
      <nav>
        <button
          onClick={() => S(sid === "preview-a" ? "preview-b" : "preview-a")}
        >
          切换会话 {sid}
        </button>
        <select
          aria-label="题型"
          value={mode}
          onChange={(e) => M(e.target.value)}
        >
          <option value="group">三道题</option>
          <option value="concurrent">三个独立 Ask</option>
          <option value="single">单题</option>
          <option value="text">文本题</option>
          <option value="expired">已终止</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={fail}
            onChange={(e) => F(e.target.checked)}
          />
          模拟提交失败
        </label>
        <button onClick={() => R(reset + 1)}>重新体验</button>
      </nav>
      <div className="surface">
        <div className="intro">FORGEAX · 对话流</div>
        <div className="tx-process-entries" data-testid="conversation-flow">
          <span className="kc-loading-label">工作中</span>
          {mode === 'concurrent' ? <AskUserBatch key={sid + reset} sid={sid} agentId="forge" calls={questions.map((question, i) => ({
            callId: `independent-${reset}-${i}`, name: 'ask_user', status: 'running',
            args: { _askRequestId: `request-${i}`, questions: [{ ...question, id: 'question-1' }] },
          }))} /> : projection.processesById["preview-turn"].entries.map(entry => entry.kind === "tool"
            ? <StepRow key={entry.id} step={entry.step} open={false} onToggle={() => {}} sid={sid} agentId="forge" />
            : entry.kind === "assistant_intermediate" ? <MarkdownView key={entry.id} text={entry.text} /> : null)}
        </div>
      </div>
      <ExecutionFailure error="protocol: provider temporarily unavailable (HTTP 502)." />
      <details>
        <summary>
          验证记录 · 请求次数 <span data-testid="requests">{count}</span>
        </summary>
        <pre>{payload}</pre>
      </details>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);

const style = document.createElement("style");
style.textContent = `:root{color-scheme:dark;--color-text-primary:#ededed;--color-text-secondary:#b5b5b5;--color-background-base:#202020;--primary:#d4ff48}body{margin:0;background:#151515;color:#ededed;font:14px system-ui}main{max-width:660px;margin:40px auto;padding:0 20px}h1{font-size:22px;margin-bottom:8px}header p,details{color:#999;font-size:12px}main>nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:24px 0}main>nav button,select{background:#292929;color:#ddd;border:1px solid #444;border-radius:6px;padding:6px 8px}main>nav label{font-size:12px}.surface{background:#202020;padding:18px;border:1px solid #333;border-radius:14px}.intro{color:#bbb;margin-bottom:18px}details{margin-top:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}`;
document.head.appendChild(style);
