import { describe, expect, test } from 'bun:test';

const read = (path: string) => Bun.file(path).text();

describe('Chat architecture vocabulary', () => {
  test('has no unused direct Extension Platform dependency or retired Host SDK path', async () => {
    const packageJson = await Bun.file('package.json').json() as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.['@forgeax/extension-platform']).toBeUndefined();
    expect(await read('vite.config.ts')).not.toContain('../host-sdk');
  });

  test('describes package roles without numeric architecture levels', async () => {
    const activeContractFiles = [
      'package.json',
      'src/index.ts',
      'src/main.tsx',
      'src/session-store/index.ts',
      'src/session-store/store.ts',
      'src/session-store/daemon-tick.ts',
      'src/session-store/session-stream.ts',
    ];
    for (const path of activeContractFiles) {
      expect(await read(path)).not.toMatch(/\bL[0-9]\b/);
    }
  });
});
