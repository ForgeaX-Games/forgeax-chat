import { expect, test } from 'bun:test';
import { commandPreview, permissionPresentation, safePermissionText } from './permission-presentation';

test('write preview selects the path without rendering file content or a redundant tool command', () => {
  const result = permissionPresentation({ toolName: 'write_file', command: 'write_file SECRET BODY', input: {
    file_path: 'src/components/Hello.tsx', content: 'SECRET BODY', env: { TOKEN: 'PRIVATE' },
  }, reason: 'Update the greeting' });
  expect(result.target).toBe('src/components/Hello.tsx');
  expect(result.titleKey).toBe('permission.actionWrite');
  expect(result.reason).toBe('Update the greeting');
  expect(JSON.stringify(result)).not.toContain('SECRET BODY');
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(permissionPresentation({ toolName: 'write_file', command: 'write_file', input: { content: 'SECRET' } }).target).toBeUndefined();
});

test('namespaced file tools and malformed input retain a safe preview', () => {
  expect(permissionPresentation({ toolName: 'mcp__fs__write_file', input: { path: 'C:\\My Project\\你好.txt' } }).target).toBe('C:\\My Project\\你好.txt');
  for (const input of [null, [], 'secret', { path: 42 }, { file_path: '', content: 'private' }]) {
    expect(permissionPresentation({ toolName: 'write_file', input }).target).toBeUndefined();
  }
});

test('shell preview redacts sensitive environment values, credentials, headers and payloads', () => {
  const target = permissionPresentation({ toolName: 'bash', input: { command: 'TOKEN="private value" curl https://user:pass@example.com?token=hidden -H "Authorization: Bearer bearer-secret" --password top-secret --data \'{"secret":"body"}\'' } }).target!;
  for (const secret of ['private value', 'user:pass', 'hidden', 'bearer-secret', 'top-secret', 'body']) expect(target).not.toContain(secret);
  expect(target).toContain('curl');
  expect(target).toContain('[redacted]');
  expect(permissionPresentation({ toolName: 'bash', command: 'cat <<EOF\nprivate body\nEOF' }).target).not.toContain('private body');
  expect(safePermissionText('password: confidential')).toBe('password: [redacted]');
  expect(safePermissionText('curl -H "X-Api-Key: header-secret"')).not.toContain('header-secret');
  expect(safePermissionText('{"password":"json-secret"}')).not.toContain('json-secret');
});

test('ordinary assignments remain readable in commands and reasons', () => {
  const command = 'NODE_ENV=production PORT=3000 DEBUG="app:*" bun run build --mode=release --outdir=dist';
  const reason = 'Run NODE_ENV=production with retries=3; verify x=y and output=dist.';
  const result = permissionPresentation({ toolName: 'bash', command, reason });
  expect(result.target).toBe(command);
  expect(result.reason).toBe(reason);
  expect(safePermissionText('OPENAI_API_KEY=private NODE_ENV=test AWS_SECRET_ACCESS_KEY="private key" bun test --api-key=secret'))
    .toBe('OPENAI_API_KEY=[redacted] NODE_ENV=test AWS_SECRET_ACCESS_KEY=[redacted] bun test --api-key=[redacted]');
});

test('selected file paths containing equals signs retain their exact identity', () => {
  for (const path of ['fixtures/mode=release/output.json', 'token=sample.txt', 'C:\\My Project\\x=y\\output=v2.txt']) {
    expect(permissionPresentation({ toolName: 'write_file', input: { path } }).target).toBe(path);
  }
});

test('command folding enforces both character and line budgets', () => {
  expect(commandPreview('git status')).toEqual({ foldable: false, text: 'git status' });
  for (const command of ['x'.repeat(1000), 'x\n'.repeat(50), `${'x'.repeat(900)}\n${'y\n'.repeat(10)}`]) {
    const preview = commandPreview(command);
    expect(preview.foldable).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(362);
    expect(preview.text.split('\n').length).toBeLessThanOrEqual(7);
  }
});
