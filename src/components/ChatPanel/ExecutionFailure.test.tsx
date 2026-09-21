import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('@forgeax/interface/i18n', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }) }));
const { ExecutionFailure } = await import('./ExecutionFailure');
test('shows a friendly summary and preserves escaped raw details behind a closed disclosure', () => {
  const raw = 'protocol: tool "example" failed: Invalid arguments {"value":"<script>"}…';
  const html = renderToStaticMarkup(<ExecutionFailure error={raw} />);
  expect(html).toContain('工具请求未通过参数校验');
  expect(html).toContain('<details>');
  expect(html).not.toContain('<details open');
  expect(html).toContain('技术详情');
  expect(html).toContain('&lt;script&gt;');
  const summary = html.slice(0, html.indexOf('<details>'));
  expect(summary).not.toContain('protocol:');
  expect(summary).not.toContain('example');
});

test('keeps the original failure visible while teammates work and after continuation', () => {
  const html = renderToStaticMarkup(<ExecutionFailure error="capture failed" continuation="teammates" />);
  expect(html).toContain('其他 Agent 仍在工作');
  expect(html).not.toContain('本回合已停止');
  expect(html).toContain('capture failed');
  expect(html).toContain('继续工作不代表验收通过');
  const resumed = renderToStaticMarkup(<ExecutionFailure error="capture failed" continuation="working" />);
  expect(resumed).toContain('已在后续回合继续工作');
});

test('user cancellation has a pause marker rather than an error alert', () => {
  const html = renderToStaticMarkup(<ExecutionFailure error="aborted by API" />);
  expect(html).toContain('lucide-circle-pause');
  expect(html).not.toContain('lucide-alert-circle');
  expect(html).toContain('data-failure-kind="interrupted"');
});

test('steered execution is neutral and does not invent an active continuation', () => {
 const html = renderToStaticMarkup(<ExecutionFailure error="steered by inbound event" />);
 expect(html).toContain('收到新反馈，本次执行已让出');
 expect(html).not.toContain('lucide-alert-circle');
 expect(html).not.toContain('正在后续执行');
 expect(html).toContain('steered by inbound event');
 const active = renderToStaticMarkup(<ExecutionFailure error="steered by inbound event" continuation="working" />);
 expect(active).toContain('正在后续执行');
});
