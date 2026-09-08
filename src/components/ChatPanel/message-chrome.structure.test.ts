import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const forgeCard = readFileSync(fileURLToPath(new URL('./ForgeCard.tsx', import.meta.url)), 'utf8');
const subAgentCard = readFileSync(fileURLToPath(new URL('./SubAgentCard.tsx', import.meta.url)), 'utf8');
const copyButton = readFileSync(fileURLToPath(new URL('./message-parts/KcCopyBtn.tsx', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./ChatPanel.css', import.meta.url)), 'utf8');

describe('message chrome layout contracts', () => {
  it('keeps the completed-message Copy action inside the header after status', () => {
    const headerStart = forgeCard.indexOf('<div className="kc-header">');
    const statusStart = forgeCard.indexOf('<span className="kc-status">', headerStart);
    const copyStart = forgeCard.indexOf('<KcCopyBtn text={text} />', headerStart);
    const headerEnd = forgeCard.indexOf('</div>', copyStart);

    assert.ok(headerStart >= 0 && statusStart > headerStart);
    assert.ok(copyStart > statusStart && headerEnd > copyStart);
    assert.match(
      forgeCard.slice(statusStart, headerEnd),
      /status === 'done' && text\.length > 0 && <KcCopyBtn text=\{text\} \/>/,
    );
  });

  it('lays Copy out in flow and lets narrow headers wrap instead of overlap', () => {
    assert.doesNotMatch(css, /--kc-header-controls/);
    assert.match(css, /\.kc-header\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(css, /\.kc-copy-btn\s*\{[^}]*position:\s*static[^}]*margin-left:\s*auto[^}]*flex:\s*none/);
    assert.match(css, /\.kc-copy-btn\.mp-sm\s*\{[^}]*align-self:\s*flex-end/);
  });

  it('bounds provider labels and removes the hidden capsule top reservation', () => {
    assert.match(css, /\.kc-provider\s*\{[^}]*max-width:\s*104px[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
    assert.match(css, /\.chat-agent-capsule-wrap\s*\{[^}]*display:\s*none\s*!important/);
    assert.match(css, /\.cp-thread\s*\{[^}]*padding:\s*0 14px 8px/);
  });

  it('keeps the shared SubAgent Copy action in its right-aligned column flow', () => {
    assert.match(
      subAgentCard,
      /!isStreaming && text\.length > 0 && <KcCopyBtn text=\{text\} size="sm" \/>/,
    );
    assert.match(css, /\.sac-body\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
    assert.match(css, /\.kc-copy-btn\.mp-sm\s*\{[^}]*align-self:\s*flex-end/);
  });

  it('uses a distinct copied glyph without changing the button width', () => {
    assert.match(copyButton, /\bClipboardCheck\b/);
    assert.doesNotMatch(copyButton, /\bCheckCircle2\b/);
    assert.match(copyButton, /copied \? <ClipboardCheck size=\{11\} \/> : <Copy size=\{11\} \/>/);
    assert.match(css, /\.kc-copy-btn\s*\{[^}]*min-width:\s*64px/);
    assert.match(css, /\.kc-provider\s*\{[^}]*margin-left:\s*0/);
  });
});
