// Regenerate assets/vendor/openrouter/openrouter.min.js, a browser bundle of
// the OpenRouter TypeScript SDK exposing globalThis.OpenRouterSDK.OpenRouter.
// A classic script (not a module) so the agent also works from file://.
// Usage: node scripts/bundle-openrouter.mjs [version]
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = process.argv[2] || '1.4.10';
const out = new URL('../assets/vendor/openrouter/', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'openrouter-'));
const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'inherit' });
writeFileSync(join(dir, 'package.json'), '{"private": true}');
run(`npm install --silent --save-exact @openrouter/sdk@${version}`);
writeFileSync(join(dir, 'entry.js'), "export { OpenRouter } from '@openrouter/sdk';\n");
run(`npx --yes esbuild@0.28.2 entry.js --bundle --minify --format=iife --global-name=OpenRouterSDK --target=es2020 --platform=browser --legal-comments=eof --outfile=${join(out.pathname, 'openrouter.min.js')}`);
copyFileSync(join(dir, 'node_modules/@openrouter/sdk/LICENSE.md'), new URL('LICENSE.md', out));
const zod = JSON.parse(readFileSync(join(dir, 'node_modules/zod/package.json'), 'utf8')).version;
writeFileSync(new URL('VERSION', out), `@openrouter/sdk ${version} (zod ${zod}), bundled with esbuild 0.28.2 as an IIFE exposing OpenRouterSDK.OpenRouter. Regenerate with: node scripts/bundle-openrouter.mjs\n`);
