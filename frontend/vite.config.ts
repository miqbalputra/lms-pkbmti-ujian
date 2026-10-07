import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { fs: { allow: ['..'] }, proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true }, '/realtime': {target:'ws://localhost:1234',ws:true} } },
})
