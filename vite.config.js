import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two entry points, because the demo needs two ORIGINS and the partner page is
// what stands on the second one. Same codebase, deployed twice: `main` serves
// the room, the `partner` branch preview serves the partner.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
        partner: resolve(process.cwd(), 'partner.html'),
      },
    },
  },
});
