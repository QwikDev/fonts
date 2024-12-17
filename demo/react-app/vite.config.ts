import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { fontless } from "../../lib/vite/plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), fontless()],
})