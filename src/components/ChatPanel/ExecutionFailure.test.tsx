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
