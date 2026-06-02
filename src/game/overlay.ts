import { vec2, type ReadonlyMat3, type ReadonlyVec3 } from 'gl-matrix'
import { camDirToDomemaster } from "@dome-control/runtime";
import cursorFs from './cursor.fs'
import cursorVs from './cursor.vs'
import { compileShaders, makeUniformLocationAccessor } from '../utils/shader-tools'
import type { CoopGameSnapshot } from './types'

const maxCursors = 64
const maxOverlayInstances = maxCursors + 1
const floatsPerInstance = 9
const scratchDomemaster = vec2.create()
const alignmentDirections = {
  front: [0, 0, 1],
  right: [1, 0, 0],
} as const

function isInsideDome(xy: vec2) {
  return Math.hypot(xy[0], xy[1]) <= 1.05
}

export default class DomeGameOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly vao: WebGLVertexArrayObject
  private readonly cornerBuffer: WebGLBuffer
  private readonly instanceBuffer: WebGLBuffer
  private readonly instanceData = new Float32Array(maxOverlayInstances * floatsPerInstance)
  private readonly uniLocs: ReturnType<typeof makeUniformLocationAccessor>

  constructor(private readonly targetCanvas: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.id = 'game-overlay'
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '50%'
    this.canvas.style.top = '50%'
    this.canvas.style.transform = 'translate(-50%, -50%)'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '900'

    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    })
    if (!gl) throw new Error('WebGL2 is required for game overlay cursors')

    this.gl = gl
    this.program = compileShaders(gl, cursorVs, cursorFs)
    this.vao = gl.createVertexArray()!
    this.cornerBuffer = gl.createBuffer()!
    this.instanceBuffer = gl.createBuffer()!
    this.uniLocs = makeUniformLocationAccessor(gl, this.program)

    this.initializeBuffers()
    document.body.appendChild(this.canvas)
  }

  dispose() {
    const gl = this.gl
    gl.deleteBuffer(this.cornerBuffer)
    gl.deleteBuffer(this.instanceBuffer)
    gl.deleteVertexArray(this.vao)
    gl.deleteProgram(this.program)
    this.canvas.remove()
  }

  render(
    snapshot: CoopGameSnapshot | null,
    eyePos: ReadonlyVec3,
    inverseRotation: ReadonlyMat3,
    simulated: boolean,
  ) {
    void eyePos
    void inverseRotation
    this.syncSize(simulated)
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!snapshot || !snapshot.enabled) return

    let instanceCount = 0
    const width = Math.max(1, this.canvas.width)
    const height = Math.max(1, this.canvas.height)
    const size = Math.min(width, height)
    const cursorRadius = Math.max(10, size * 0.02 * snapshot.cursorSize) * 2 / size
    const crossRadius = Math.max(54, size * 0.11) * 2 / size

    if (snapshot.alignmentCross) {
      camDirToDomemaster(scratchDomemaster, alignmentDirections[snapshot.alignmentCross])
      if (isInsideDome(scratchDomemaster)) {
        const offset = instanceCount * floatsPerInstance
        this.instanceData[offset] = scratchDomemaster[0]
        this.instanceData[offset + 1] = scratchDomemaster[1]
        this.instanceData[offset + 2] = 1
        this.instanceData[offset + 3] = 1
        this.instanceData[offset + 4] = 1
        this.instanceData[offset + 5] = 1
        this.instanceData[offset + 6] = 1
        this.instanceData[offset + 7] = crossRadius
        this.instanceData[offset + 8] = 1
        instanceCount += 1
      }
    }

    for (const player of snapshot.players) {
      if (instanceCount >= maxOverlayInstances) break
      camDirToDomemaster(scratchDomemaster, player.direction)
      if (!isInsideDome(scratchDomemaster)) continue

      const offset = instanceCount * floatsPerInstance
      this.instanceData[offset] = scratchDomemaster[0]
      this.instanceData[offset + 1] = scratchDomemaster[1]
      this.instanceData[offset + 2] = player.cursorAlpha
      this.instanceData[offset + 3] = player.colorRgb[0]
      this.instanceData[offset + 4] = player.colorRgb[1]
      this.instanceData[offset + 5] = player.colorRgb[2]
      this.instanceData[offset + 6] = 0
      this.instanceData[offset + 7] = cursorRadius
      this.instanceData[offset + 8] = player.pressAlpha
      instanceCount += 1
    }

    if (instanceCount === 0) return

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData.subarray(0, instanceCount * floatsPerInstance))
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.uniform2f(this.uniLocs.uDomeScale, size / width, size / height)
    gl.uniform1f(this.uniLocs.uTime, performance.now() * 0.001)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount)
    gl.bindVertexArray(null)
  }

  private initializeBuffers() {
    const gl = this.gl
    gl.bindVertexArray(this.vao)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        1, 1,
      ]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, maxOverlayInstances * floatsPerInstance * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW)
    const stride = floatsPerInstance * Float32Array.BYTES_PER_ELEMENT

    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0)
    gl.vertexAttribDivisor(1, 1)

    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT)
    gl.vertexAttribDivisor(2, 1)

    gl.enableVertexAttribArray(3)
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT)
    gl.vertexAttribDivisor(3, 1)

    gl.enableVertexAttribArray(4)
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT)
    gl.vertexAttribDivisor(4, 1)

    gl.enableVertexAttribArray(5)
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 7 * Float32Array.BYTES_PER_ELEMENT)
    gl.vertexAttribDivisor(5, 1)

    gl.enableVertexAttribArray(6)
    gl.vertexAttribPointer(6, 1, gl.FLOAT, false, stride, 8 * Float32Array.BYTES_PER_ELEMENT)
    gl.vertexAttribDivisor(6, 1)

    gl.bindVertexArray(null)
  }

  private syncSize(simulated: boolean) {
    const width = this.targetCanvas.clientWidth
    const height = this.targetCanvas.clientHeight
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.canvas.className = simulated ? 'simulate' : ''

    const pixelRatio = window.devicePixelRatio || 1
    const nextWidth = Math.max(1, Math.round(width * pixelRatio))
    const nextHeight = Math.max(1, Math.round(height * pixelRatio))
    if (this.canvas.width !== nextWidth || this.canvas.height !== nextHeight) {
      this.canvas.width = nextWidth
      this.canvas.height = nextHeight
    }
  }
}
