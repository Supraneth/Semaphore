import { defineConfig } from 'vite';

/**
 * Two jobs from one config.
 *
 * `vite` serves `index.html`, the standalone plan editor, and `bench.html`, the
 * card running against a fake Home Assistant. `vite build` ignores both and
 * emits a single ES module, because a Lovelace resource is one
 * `<script type="module">` and HACS attaches exactly one file to a release — so
 * no chunking, no dynamic imports, no asset side-cars. Neither the editor nor
 * the bench is ever part of that file.
 */
export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/semaphore-card.ts',
      formats: ['es'],
      fileName: () => 'semaphore.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    // MapLibre is most of the bundle and it is not tiny. Raising the warning
    // threshold is honest here rather than a papering-over: externalising it to
    // a CDN is a deliberate future step, not an oversight.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    open: false,
  },
});
