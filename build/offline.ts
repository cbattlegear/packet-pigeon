import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'

export function offlineShell(): Plugin {
  return {
    name: 'packet-pigeon-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const worker = readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8')
        const revision = createHash('sha256').update(worker)
        const files = Object.keys(bundle).sort().filter((name) => !name.endsWith('.map'))
        if (!files.includes('index.html')) {
          this.error('The offline shell requires the generated index.html.')
        }

        for (const name of files) {
          const output = bundle[name]
          revision.update(name).update('\0')
          revision.update(output.type === 'chunk' ? output.code : output.source).update('\0')
        }

        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `const buildId = ${JSON.stringify(revision.digest('hex'))};\n`
            + `const appFiles = ${JSON.stringify(files)};\n`
            + worker,
        })
      },
    },
  }
}
