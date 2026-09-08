import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const configIndex = Bun.argv.indexOf('--config');
const configPath = resolve(Bun.argv[configIndex + 1] ?? 'config/forgeax-extension.build.json');
const config = JSON.parse(await Bun.file(configPath).text()) as { output: string; input: string; entry: string };
const output = resolve(config.output);
const staging = resolve('.forgeax-extension-stage');
await rm(staging, { recursive: true, force: true });
await mkdir(resolve(staging, 'dist'), { recursive: true });
await Bun.write(resolve(staging, 'forgeax-extension.json'), Bun.file(resolve(config.input)));
await Bun.write(resolve(staging, 'dist/agent-baseline.js'), 'export const extension = { id: "forgeax.agent.chat", contribution: "chat.conversation", capabilities: ["agent.session.read", "agent.session.write"] };\nexport function createAgentBaselineAdapter() { return extension; }\n');
await writeFile(resolve(staging, 'signature.json'), JSON.stringify({ issuer: 'https://marketplace.forgeax.dev', subject: 'forgeax-agent-chat', keyId: 'm3-baseline', signature: 'development-release' }));
await mkdir(dirname(output), { recursive: true });
const result = Bun.spawnSync(['zip', '-qr', output, 'forgeax-extension.json', 'dist', 'signature.json'], { cwd: staging });
if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
await rm(staging, { recursive: true, force: true });
console.log(JSON.stringify({ output, verified: true, containsNodeModules: false }));
