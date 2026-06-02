import { defineConfig } from 'vite'
import path from 'node:path'
import { createRequire } from 'node:module'

import glsl from 'vite-plugin-glsl'
import wasm from 'vite-plugin-wasm'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// Force a full page reload on any change. WebGL artworks keep a lot of GPU
// state, so HMR module-swapping tends to leak contexts; a clean reload is safer.
function fullReloadOnChange() {
  return {
    name: 'artwork-full-reload-on-change',
    handleHotUpdate({ server }: { server: { ws: { send: (payload: unknown) => void } } }) {
      server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}

// onnxruntime-web ships its wasm backends separately; copy them next to the app
// so the auto-BPM model (time-n-controls AutoPhase) can load them at runtime.
const require = createRequire(import.meta.url)
const onnxRuntimeDist = path.join(path.dirname(require.resolve('onnxruntime-web')), '..', 'dist')

export default defineConfig({
  base: './',
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  server: {
    headers: {
      // Prevent Firefox BFCache from keeping old (multi-GB) WebGL pages alive across reloads.
      'Cache-Control': 'no-store',
    },
  },
  build: {
    target: ['es2022'],
    outDir: 'dist',
  },
  plugins: [
    fullReloadOnChange(),
    glsl(),
    wasm(),
    viteStaticCopy({
      targets: [{ src: path.join(onnxRuntimeDist, '*.wasm'), dest: '.' }],
    }),
  ],
})
