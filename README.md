# dome-game-canvas

A barebones [fulldome](https://en.wikipedia.org/wiki/Fulldome) WebGL artwork
template. It renders a grid of spheres with a signed-distance field (SDF) in a
180° fisheye (domemaster) projection, and the spheres **blink to the beat** via
automatic BPM detection.

It is meant as a **quick start** for building artworks on top of the stack:

- **[`av-controls`](https://www.npmjs.com/package/av-controls)** — remote control surface (faders, switches, tabs, …) over a WebSocket broker.
- **[`time-n-controls`](https://www.npmjs.com/package/time-n-controls)** — clocks and high-level controls, including `AutoPhase` automatic beat/BPM recognition (ONNX model).
- **[`dome-control-runtime`](https://www.npmjs.com/package/dome-control-runtime)** — fulldome controller protocol + domemaster math, used by the optional dome game.

Everything is plain TypeScript + WebGL2 + Vite. No engine, no framework.

## What's in it

- **Sphere-grid SDF** rendered per-pixel through a fisheye ray (`src/shaders/sphere-grid.fs`).
- **Beat blink**: each cell hashes to one of 4 beats and flashes on it.
- **Fulldome simulator** + **domemaster output** (toggle between the raw fisheye and a previewable dome projection).
- **Resolution selector** (dome master resolution).
- **Free-flying camera**.
- **Dome game** controls + cursor overlay (driven by `dome-control` clients).
- **Auto BPM / phase** controls, plus tap and constant-tempo sources.
- **Timeline + frame/video capture** integration via `av-controls`.

## Run

```bash
npm install
npm run dev
```

Then open the dev URL. By default the artwork connects to an `av-controls`
WebSocket broker at `ws://localhost:8080` (set `?ws-broker-url=off` to disable,
or `?ws-broker-url=ws://host:port` to point elsewhere).

To run the whole stack (broker, controller UI, timeline, dome client, …) in one
go, use:

```bash
npm run dev:suite
```

## License

- **Source code** — MIT (see `LICENSE`).
- **Trained model** `public/100.onnx` — separate, non-commercial/artistic-use
  license; commercial use requires a license (see `MODEL_LICENSE.md`).
