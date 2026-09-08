import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const composer = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
const chatPanel = readFileSync(fileURLToPath(new URL('./ChatPanel.tsx', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./ChatPanel.css', import.meta.url)), 'utf8');

describe('Composer summon chip source contracts', () => {
  it('publishes the resolved expert only from a committed layout and clears it on unmount', () => {
    const resolveStart = composer.indexOf('const resolvedSummonAgentId = resolveSummonAgentId');
    const layoutStart = composer.indexOf('useLayoutEffect(() => {', resolveStart);
    assert.ok(resolveStart >= 0 && layoutStart > resolveStart);
    assert.doesNotMatch(composer.slice(resolveStart, layoutStart), /resolvedSummonAgentIdRef\.current\s*=/);
    assert.match(composer, /useLayoutEffect\(\(\) => \{[\s\S]*resolvedSummonAgentIdRef\.current = resolvedSummonAgentId;[\s\S]*return \(\) => \{ resolvedSummonAgentIdRef\.current = null; \};[\s\S]*\}, \[resolvedSummonAgentId, resolvedSummonAgentIdRef\]\);/);
  });

  it('receives an explicit sub-agent delegation gate instead of relying on an unmount', () => {
    assert.match(composer, /specialistSummonEnabled = true/);
    assert.match(composer, /resolveSummonAgentId\([\s\S]*specialistSummonEnabled,[\s\S]*\)/);
    assert.match(composer, /const atHasMentions = specialistSummonEnabled &&/);
    assert.match(chatPanel, /useAgentThreadNav\(\)/);
    assert.match(chatPanel, /specialistSummonEnabled=\{canSummonSpecialistFromActiveThread\(activeAgentId, rootAgentId\)\}/);
  });

  it('keeps clear as a sibling button and reveals it for keyboard focus', () => {
    const chipStart = composer.indexOf('className={`cb-btn ${atHasMentions');
    const clearStart = composer.indexOf('className="cb-at-chip-clear"');
    assert.ok(chipStart >= 0 && clearStart > chipStart);
    assert.ok(composer.slice(chipStart, clearStart).includes('</button>'), 'clear button must not nest inside chip button');
    assert.match(css, /\.cb-at-chip-clear\s*\{[\s\S]*display:\s*inline-flex/);
    assert.match(css, /\.cb-at:focus-within \.cb-at-chip-clear\s*\{[^}]*opacity:\s*1/);
  });

  it('lets the chip grow to its label while clear only overlays the avatar slot', () => {
    assert.match(css, /\.cb-at\s*\{[^}]*display:\s*inline-flex[^}]*flex:\s*0 0 auto/);
    assert.match(css, /\.cb-at-chip\s*\{[^}]*width:\s*fit-content[^}]*min-width:\s*0/);
    assert.match(css, /\.cb-at-chip-clear\s*\{[^}]*left:\s*4px[^}]*top:\s*3px/);
    assert.match(composer, /className=\{`cb-at\$\{summonedAgent \? ' has-summon-chip' : ''\}`\}/);
    assert.match(composer, /className=\{`cb-left-group\$\{summonedAgent \? ' has-summon-chip' : ''\}`\}/);
  });

  it('anchors the agent menu beside, not around, ordinary toolbar popovers and treats it as inside for outside-click dismissal', () => {
    const controls = composer.indexOf('<div className="composer-toolbar-controls">');
    const anchor = composer.indexOf('<div className="cb-at-menu-anchor">');
    const menu = composer.indexOf('<div className="cb-at-menu" role="menu" aria-label="Agent mentions">');
    const rightGroup = composer.indexOf('<div className="cb-right-group">');
    assert.ok(controls >= 0 && rightGroup > controls && anchor > rightGroup && menu > anchor);
    assert.match(composer, /closest\('\.cb-at, \.cb-at-menu'\)/);
    assert.match(css, /\.composer-bar\.cb-at-menu-layout\s*\{[^}]*display:\s*grid/);
    assert.doesNotMatch(css, /\.composer-bar\s*\{[^}]*position:\s*relative/);
    assert.match(css, /\.cb-at-menu-anchor\s*\{[\s\S]*grid-area:\s*1 \/ 1[\s\S]*position:\s*relative[\s\S]*pointer-events:\s*none/);
    assert.match(css, /\.cb-at-menu-anchor > \.cb-at-menu\s*\{[\s\S]*bottom:\s*calc\(100% \+ 8px\)[\s\S]*left:\s*8px[\s\S]*width:\s*360px/);
    assert.match(css, /\.cb-at-menu-anchor > \.cb-at-menu\s*\{[\s\S]*height:\s*420px[\s\S]*overflow-x:\s*hidden[\s\S]*overflow-y:\s*auto[\s\S]*pointer-events:\s*auto/);
  });

  it('lays expert rows out like slash items: id and name stay, role ellipsizes', () => {
    assert.match(css, /\.cb-at-item\s*\{[^}]*flex-shrink:\s*0/);
    assert.doesNotMatch(css, /\.cb-at-item\s*\{[^}]*overflow:\s*hidden/);
    assert.match(css, /\.cb-at-id\s*\{[^}]*flex-shrink:\s*0[^}]*white-space:\s*nowrap/);
    assert.match(css, /\.cb-at-name\s*\{[^}]*flex-shrink:\s*0[^}]*white-space:\s*nowrap/);
    assert.match(css, /\.cb-at-role\s*\{[^}]*text-overflow:\s*ellipsis[^}]*flex:\s*1/);
  });

  it('renders catalog avatars as circles and matches slash-menu spacing', () => {
    assert.match(composer, /function MentionAvatar\(/);
    assert.match(composer, /mode="idle"/);
    assert.match(composer, /shape="circle"/);
    assert.match(composer, /size=\{15\}/);
    assert.match(css, /\.cb-at-menu\s*\{[\s\S]*gap:\s*1px/);
    assert.match(css, /\.cb-slash-item\s*\{[^}]*height:\s*25px/);
    assert.match(css, /\.cb-at-item\s*\{[^}]*height:\s*25px/);
    assert.match(css, /\.cb-at-avatar\s*\{[\s\S]*border-radius:\s*50%/);
    assert.match(css, /\.cb-at-item \.cb-at-avatar,\s*\.cb-at-avatar\.cb-at-chip-avatar\s*\{[\s\S]*background:\s*transparent[\s\S]*border:\s*none/);
    assert.match(css, /\.cb-at-item \.cb-at-avatar\s*\{[\s\S]*width:\s*15px[\s\S]*height:\s*15px/);
  });

  it('keeps composer text per session across tab remounts instead of discarding on owner switch', () => {
    assert.match(composer, /from '\.\/composer-draft'/);
    assert.match(composer, /readComposerDraft\(sid, agentId\)/);
    assert.match(composer, /writeComposerDraft\(owner\?\.sid \?\? activeSid, owner\?\.agentId \?\? activeAgent, value\)/);
    assert.match(composer, /setBoundComposerOwnerKey\(composerOwnerKey\)/);
    assert.doesNotMatch(composer, /owner switches discard its/);
  });
});
