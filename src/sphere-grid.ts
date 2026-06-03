import { Controls } from '@av-controls/protocol'
import type { ReadonlyMat3, ReadonlyVec3 } from 'gl-matrix'

import Camera from './camera'
import { RectVao } from './utils/geometry'
import { compileShaders, makeUniformLocationAccessor } from './utils/shader-tools'

import xyQuadVs from './shaders/xyQuad.vs'
import sphereGridFs from './shaders/sphere-grid.fs'

// fixed saturation/lightness; only hue is exposed as a control
function hueToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = ((hue % 1) + 1) % 1
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1))
  const m = lightness - c / 2
  let r = 0, g = 0, b = 0
  if (h < 1 / 6) [r, g, b] = [c, x, 0]
  else if (h < 2 / 6) [r, g, b] = [x, c, 0]
  else if (h < 3 / 6) [r, g, b] = [0, c, x]
  else if (h < 4 / 6) [r, g, b] = [0, x, c]
  else if (h < 5 / 6) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [r + m, g + m, b + m]
}

export default class SphereGrid {
  private program: WebGLProgram
  private uniLocs: ReturnType<typeof makeUniformLocationAccessor>
  private quadVao: RectVao

  private cellSizeFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('cell size', 0, 0, 10, 50, '#4a8'),
    new Controls.Fader.State(2.5), 0.5, 8, 2,
  ))
  private radiusFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('radius', 10, 0, 10, 50, '#4a8'),
    new Controls.Fader.State(0.45), 0.05, 2, 2,
  ))
  private stepsFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('march steps', 20, 0, 10, 50, '#48a'),
    new Controls.Fader.State(64), 16, 192, 0,
  ))
  private baseHueFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('base hue', 30, 0, 10, 50, '#a6a'),
    new Controls.Fader.State(0.58), 0, 1, 2,
  ))
  private blinkHueFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('blink hue', 40, 0, 10, 50, '#a86'),
    new Controls.Fader.State(0.08), 0, 1, 2,
  ))
  private blinkIntensityFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('blink', 50, 0, 10, 50, '#c84'),
    new Controls.Fader.State(0.6), 0, 3, 2,
  ))
  private blinkEpsilonFader = new Controls.Fader.Receiver(new Controls.Fader.Spec(
    new Controls.Base.Args('blink decay', 60, 0, 10, 50, '#c84'),
    new Controls.Fader.State(0.12), 0.01, 1, 2,
  ))

  // raymarching / shading faders, shown in their own 'scene' tab
  private raymarchingGroup = new Controls.Group.Receiver(new Controls.Group.SpecWithoutControls(
    new Controls.Base.Args('raymarching', 0, 0, 100, 100, '#888'),
  ), {
    cellSize: this.cellSizeFader,
    radius: this.radiusFader,
    steps: this.stepsFader,
    baseHue: this.baseHueFader,
    blinkHue: this.blinkHueFader,
    blink: this.blinkIntensityFader,
    blinkDecay: this.blinkEpsilonFader,
  })

  constructor(
    private gl: WebGL2RenderingContext,
    private camera: Camera,
    private maxDistance = 80,
  ) {
    this.program = compileShaders(gl, xyQuadVs, sphereGridFs)
    this.uniLocs = makeUniformLocationAccessor(gl, this.program)
    this.quadVao = new RectVao(gl)
  }

  getRaymarchingGroup() {
    return this.raymarchingGroup
  }

  /**
   * Renders the sphere grid into the currently bound framebuffer.
   * @param barPhase normalized [0,1) position within the current bar
   * @param beatsPerBar how many beats a cell can hash into
   * @param secondsPerBar bar duration in seconds (drives the blink decay)
   */
  render(barPhase: number, beatsPerBar: number, secondsPerBar: number) {
    const gl = this.gl
    const eyePos = this.camera.getPosition() as ReadonlyVec3
    const rotation = this.camera.getRotation() as ReadonlyMat3

    const base = hueToRgb(this.baseHueFader.value, 0.5, 0.55)
    const blinkIntensity = this.blinkIntensityFader.value
    const blink = hueToRgb(this.blinkHueFader.value, 0.95, 0.6).map(c => c * blinkIntensity)

    gl.useProgram(this.program)
    gl.uniform3fv(this.uniLocs.eyePos, eyePos as Float32Array | number[])
    gl.uniformMatrix3fv(this.uniLocs.rotation, false, rotation as Float32Array | number[])
    gl.uniform1f(this.uniLocs.cellSize, this.cellSizeFader.value)
    gl.uniform1f(this.uniLocs.sphereRadius, this.radiusFader.value)
    gl.uniform1i(this.uniLocs.marchSteps, Math.round(this.stepsFader.value))
    gl.uniform1f(this.uniLocs.maxDistance, this.maxDistance)
    gl.uniform3fv(this.uniLocs.baseColor, base)
    gl.uniform3fv(this.uniLocs.blinkColor, blink)
    gl.uniform1f(this.uniLocs.blinkEpsilon, this.blinkEpsilonFader.value)
    gl.uniform1f(this.uniLocs.barPhase, barPhase)
    gl.uniform1i(this.uniLocs.beatsPerBar, Math.max(1, Math.round(beatsPerBar)))
    gl.uniform1f(this.uniLocs.secondsPerBar, secondsPerBar)

    this.quadVao.draw()
  }

  dispose() {
    this.gl.deleteProgram(this.program)
    this.quadVao.dispose()
  }
}
