import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { offlineShell } from './build/offline.ts'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), offlineShell()],
})
