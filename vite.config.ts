import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { offlineShell } from './build/offline.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: { license: { fileName: 'third-party-licenses.md' } },
  plugins: [react(), {
    name: 'packet-pigeon-license',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE', source: readFileSync(new URL('./LICENSE', import.meta.url)) })
    },
  }, offlineShell()],
})
