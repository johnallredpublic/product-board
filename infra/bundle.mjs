// Bundle each Lambda handler to dist/<name>/index.mjs with esbuild.
//
// Our source uses NodeNext-style `.js` import specifiers that resolve to `.ts`
// files; esbuild doesn't rewrite those by default, so a tiny resolver plugin maps
// relative `*.js` imports to their `.ts` sibling. aws-sdk (provided by the Lambda
// runtime) and sharp (a Lambda layer) are left external.

import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = (p) => resolve(here, '..', 'packages', p)

const resolveTsJs = {
  name: 'resolve-ts-from-js',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (args.path.endsWith('.js')) {
        const ts = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
        if (existsSync(ts)) return { path: ts }
      }
      return undefined // fall through to esbuild's default resolution
    })
  },
}

const targets = [
  { name: 'api', entry: pkg('api/src/lambda.ts') },
  { name: 'stream', entry: pkg('api/src/handlers/stream-consumer.ts') },
  { name: 'notify', entry: pkg('api/src/handlers/notify-consumer.ts') },
  { name: 'asset-processed', entry: pkg('api/src/handlers/on-asset-processed.ts') },
  { name: 'reconcile', entry: pkg('api/src/jobs/reconcile.ts') },
  { name: 'media', entry: pkg('media/src/handler.ts') },
]

await Promise.all(
  targets.map((t) =>
    build({
      entryPoints: [t.entry],
      outfile: resolve(here, 'dist', t.name, 'index.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      // aws-sdk v3 is on the Lambda runtime; sharp ships as a layer.
      external: ['@aws-sdk/*', 'sharp'],
      // ESM interop for CJS deps (fastify, powertools, etc.).
      banner: { js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);" },
      plugins: [resolveTsJs],
      logLevel: 'warning',
    }),
  ),
)

console.log(`bundled ${targets.length} handlers -> infra/dist/*/index.mjs`)
