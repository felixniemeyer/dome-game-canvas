import { compileShaders, makeUniformLocationAccessor } from './utils/shader-tools'

import simVs from './shaders/simulator.vs'
import simFs from './shaders/simulator.fs'

import { RectVao } from './utils/geometry'

import { mat3, vec3 } from 'gl-matrix'

const up = vec3.fromValues(0, 1, 0)
const front = vec3.fromValues(0, 0, 1)

const rUp = vec3.create()
const rFront = vec3.create()
const rRight = vec3.create()

export default class FullDomeSimulator {
  rotationMatrix = mat3.create()

  program: WebGLProgram
  uniLocs: any

  rectVao: RectVao

  mX = 0
  mY = 0
  xRot = 0
  yRot = -0.7

  constructor(
    private gl: WebGL2RenderingContext,
    private onInteraction?: () => void,
  ) {
    this.program = compileShaders(gl, simVs, simFs)
    this.uniLocs = makeUniformLocationAccessor(gl, this.program)

    this.onMouseDown = this.onMouseDown.bind(this)
    this.onMouseUp = this.onMouseUp.bind(this)
    this.onMouseMove = this.onMouseMove.bind(this)

    gl.useProgram(this.program)
    gl.uniform1i(this.uniLocs.tex, 0)

    this.rectVao = new RectVao(gl)

    this.start()
    this.updateMatrix()
  }

  res = [1, 1]
  viewAngleX = Math.PI / 2
  viewAngleY = Math.PI / 2

  setResolution(width: number, height: number) { 
    this.res = [width, height]

    let normY = Math.sqrt(height / width)
    let normX = 1 / normY

    const zoom = 1 // TBD: fix this in conjunction with viewAngle
    normX /= zoom
    normY /= zoom

    const gl = this.gl
    gl.useProgram(this.program)
    gl.uniform2fv(this.uniLocs.res, this.res)
    gl.uniform2fv(this.uniLocs.norm, [normX, normY])

    // calculate view angles, 
    this.viewAngleX = Math.asin(normX / Math.sqrt(1 + normX ** 2)) * 2
    this.viewAngleY = Math.asin(normY / Math.sqrt(1 + normY ** 2)) * 2
  }

  // input handling
  mouseDown = false
  start() {
    window.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
  }
  stop() {
    window.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
  }
  onMouseDown(e: MouseEvent) {
    this.mouseDown = true
    this.mX = e.clientX
    this.mY = e.clientY
  }
  onMouseUp(_e: MouseEvent) {
    this.mouseDown = false
  }
  onMouseMove(e: MouseEvent) {
    if(this.mouseDown) {
      const dx = e.clientX - this.mX
      const dy = - (e.clientY - this.mY)
      this.mX = e.clientX
      this.mY = e.clientY

      // rotate 
      this.xRot += dx / this.res[0] * this.viewAngleX
      while(this.xRot > Math.PI) {
        this.xRot -= Math.PI * 2
      }
      while(this.xRot < -Math.PI) {
        this.xRot += Math.PI * 2
      }

      this.yRot += dy / this.res[1] * this.viewAngleY
      if(this.yRot > Math.PI / 2) {
        this.yRot = Math.PI / 2
      }
      if(this.yRot < -Math.PI / 2) {
        this.yRot = -Math.PI / 2
      }

      this.updateMatrix()
      if (this.onInteraction) {
        this.onInteraction()
      }

    }
  }

  updateMatrix() {
    vec3.rotateX(rFront, front, [0, 0, 0], this.yRot)
    vec3.rotateY(rFront, rFront, [0, 0, 0], this.xRot)

    vec3.cross(rRight, rFront, up)
    vec3.normalize(rRight, rRight)

    vec3.cross(rUp, rRight, rFront)
    vec3.normalize(rUp, rUp)

    // update rotation matrix
    mat3.set(
      this.rotationMatrix, 
      rRight[0], rRight[1], rRight[2],
      rUp[0], rUp[1], rUp[2],
      rFront[0], rFront[1], rFront[2],
    ) 
  }

  render(domemasterTex: WebGLTexture) {
    const gl = this.gl

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    gl.useProgram(this.program)

    // bind the texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, domemasterTex)

    gl.uniformMatrix3fv(this.uniLocs.rotation, false, this.rotationMatrix)

    // draw the quad
    this.rectVao.draw()

    // unbind the texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  dispose() {
    this.stop()
    this.gl.deleteProgram(this.program)
    this.rectVao.dispose()
  }
}
