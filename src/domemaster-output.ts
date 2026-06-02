// renders the final image to the null framebuffer

import { compileShaders, makeUniformLocationAccessor } from './utils/shader-tools'
import { RectVao } from './utils/geometry'

import vs from './shaders/uvQuad.vs'
import fs from './shaders/domemaster.fs'

export default class FinalRenderer {
  private program: WebGLProgram
  private uniLocs: any

  private rectVao: RectVao

  constructor(private gl: WebGL2RenderingContext) {
    this.program = compileShaders(gl, vs, fs)
    this.uniLocs = makeUniformLocationAccessor(gl, this.program)
    gl.useProgram(this.program)
    gl.uniform1i(this.uniLocs.tex, 0)
    this.rectVao = new RectVao(gl)
  }

  setResolution(res: number) {
    void res
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

    // draw the quad
    this.rectVao.draw()

    // unbind the texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  dispose() {
    this.gl.deleteProgram(this.program)
    this.rectVao.dispose()
  }
}
