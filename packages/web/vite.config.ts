import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const DEV_PORT = 5173

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Dev only, Vite's backend integration mode: the CLI serves the page and
  // points it at this origin (CODESEMA_DEV_VITE), Vite serves the modules.
  // `origin` makes asset URLs absolute so they resolve from the CLI's port, and
  // `strictPort` fails loudly instead of drifting to 5174 behind the CLI's back.
  server: { port: DEV_PORT, strictPort: true, origin: `http://localhost:${DEV_PORT}` },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
