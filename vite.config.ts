import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { offlineShell } from './build/offline.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  build: { license: { fileName: 'third-party-licenses.md' } },
  plugins: [react(), offlineShell()],
})
