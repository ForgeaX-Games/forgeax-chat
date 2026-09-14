import * as ReactRuntime from '../../../node_modules/react/index.js';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('react', () => ReactRuntime);
mock.module('@forgeax/interface/i18n', () => ({ getLocale: () => 'en', useTranslation: () => ({ t: (key: string) => key }) }));
const { MarkdownView } = await import('./MarkdownView');
test('local references offer path copying instead of broken browser routes', () => {
  for (const path of ['/Users/you/game/main.ts', 'C:/games/main.ts', 'src/main.ts', 'file:///tmp/game.ts']) {
    const html = renderToStaticMarkup(<MarkdownView text={`[Source](${path})`} />);
    expect(html).toContain('Copy file path:');
    expect(html).not.toContain('href=');
  }
});
test('web links remain links and executable schemes are never navigable', () => {
  expect(renderToStaticMarkup(<MarkdownView text="[Docs](https://example.com/docs)" />)).toContain('href="https://example.com/docs"');
  expect(renderToStaticMarkup(<MarkdownView text="[bad](javascript:alert)" />)).not.toContain('href=');
});
