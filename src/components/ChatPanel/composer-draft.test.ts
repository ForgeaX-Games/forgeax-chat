import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  clearComposerDraft,
  readComposerDraft,
  resetComposerDrafts,
  writeComposerDraft,
} from './composer-draft';

describe('composer drafts', () => {
  beforeEach(() => resetComposerDrafts());

  it('round-trips text for one session owner', () => {
    writeComposerDraft('sid-a', 'forge', 'hello');
    assert.equal(readComposerDraft('sid-a', 'forge'), 'hello');
  });

  it('keeps drafts isolated per sid and agent', () => {
    writeComposerDraft('sid-a', 'forge', 'one');
    writeComposerDraft('sid-b', 'forge', 'two');
    writeComposerDraft('sid-a', 'suzu', 'three');
    assert.equal(readComposerDraft('sid-a', 'forge'), 'one');
    assert.equal(readComposerDraft('sid-b', 'forge'), 'two');
    assert.equal(readComposerDraft('sid-a', 'suzu'), 'three');
  });

  it('drops a draft on clear or empty write', () => {
    writeComposerDraft('sid-a', 'forge', 'hello');
    writeComposerDraft('sid-a', 'forge', '');
    assert.equal(readComposerDraft('sid-a', 'forge'), '');
    writeComposerDraft('sid-a', 'forge', 'hello');
    clearComposerDraft('sid-a', 'forge');
    assert.equal(readComposerDraft('sid-a', 'forge'), '');
  });

  it('ignores incomplete owners', () => {
    writeComposerDraft(null, 'forge', 'nope');
    writeComposerDraft('sid-a', null, 'nope');
    assert.equal(readComposerDraft(null, 'forge'), '');
    assert.equal(readComposerDraft('sid-a', null), '');
  });
});
