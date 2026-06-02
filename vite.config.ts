import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import glsl from 'vite-plugin-glsl'
import wasm from 'vite-plugin-wasm'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const here = path.dirname(fileURLToPath(import.meta.url))

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

// Optional local-source linking: when the av-controls / dome-control monorepo is
// checked out next to this repo, dev against its TypeScript source so edits show
// up immediately (no republish). If those paths don't exist (i.e. someone just
// cloned this repo), this is empty and Vite resolves the published npm packages.
const localSourceCandidates: Record<string, string> = {
  '@av-controls/protocol': '../av-controls/protocol/src/index.ts',
  '@av-controls/time-n-controls': '../av-controls/time-n-controls/src/lib.ts',
  '@dome-control/runtime': '../dome-control/runtime/src/index.ts',
}
const localLinks: Record<string, string> = {}
for (const [pkg, rel] of Object.entries(localSourceCandidates)) {
  const abs = path.resolve(here, rel)
  if (fs.existsSync(abs)) localLinks[pkg] = abs
}
const hasLocalLinks = Object.keys(localLinks).length > 0
if (hasLocalLinks) {
  console.info('[canvas] dev-linking local monorepo source:', Object.keys(localLinks).join(', '))
}

// onnxruntime-web ships its wasm backends separately; copy them next to the app
// so the auto-BPM model (time-n-controls AutoPhase) can load them at runtime.
const require = createRequire(import.meta.url)
const onnxRuntimeDist = path.join(path.dirname(require.resolve('onnxruntime-web')), '..', 'dist')

export default defineConfig({
  base: './',
  resolve: {
    alias: localLinks,
  },
  optimizeDeps: {
    // local source is TS that imports each other; let Vite handle it unbundled
    exclude: ['onnxruntime-web', ...Object.keys(localLinks)],
  },
  server: {
    // allow serving the linked monorepo source from outside the project root
    fs: hasLocalLinks ? { allow: [path.resolve(here, '..')] } : undefined,
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
