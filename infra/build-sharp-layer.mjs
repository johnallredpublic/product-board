// Build a Lambda layer containing Sharp's Linux/arm64 binary (Sharp is native and
// can't be esbuild-bundled). Cross-installs from any host via npm's --os/--cpu/--libc.
// Output: infra/layers/sharp/nodejs/node_modules/sharp  -> referenced by media-stack.

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, 'layers', 'sharp', 'nodejs')
mkdirSync(dir, { recursive: true })
writeFileSync(
  resolve(dir, 'package.json'),
  JSON.stringify({ name: 'sharp-layer', private: true, dependencies: { sharp: '0.35.3' } }, null, 2),
)

execSync('npm install --os=linux --cpu=arm64 --libc=glibc --omit=dev --no-package-lock', {
  cwd: dir,
  stdio: 'inherit',
})

console.log('built sharp layer -> infra/layers/sharp/nodejs')
