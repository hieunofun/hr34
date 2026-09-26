import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3034,
    open: false,
    watch: {
      ignored: ['**/*.xlsx', '**/*.xls', '**/*.csv', '**/.git/**']
    }
  }
})

