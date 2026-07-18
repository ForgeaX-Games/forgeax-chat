// Streaming-friendly markdown renderer for assistant text.
//
// 历史：曾经流式时是 plain-text 逐字 reveal，等 status='done' 才切到
// MarkdownView，理由是 "**bo" 这种半截 markdown 会闪。实测 react-markdown
// 对未闭合标记按字面量渲染（参考 ChatGPT / Claude Web），不会闪，反而
// 流式期间没有 markdown 渲染体验差。
//
// 现在策略：任何状态下都走 MarkdownView 渲染当前 text。`animated=true` 时额外
// 加一个光标 + 类名让 caller 可以做 CSS 高亮 / cursor 指示。
//
// LLM token 速度本身就有打字机感（~30-60 tok/s），不需要额外 RAF reveal 节流。

import { MarkdownView } from './MarkdownView';

interface Props {
  text: string;
  animated: boolean;
}

export function TypewriterText({ text, animated }: Props) {
  if (!animated) return <MarkdownView text={text} />;
  return (
    <div className="md md-typewriter">
      <MarkdownView text={text} />
      <span className="md-cursor" aria-hidden="true">▍</span>
    </div>
  );
}
