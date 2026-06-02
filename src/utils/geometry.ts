export class RectVao {
  private gl: WebGL2RenderingContext
  private vao: WebGLVertexArrayObject
  private vb: WebGLBuffer

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.vao = gl.createVertexArray()!

    gl.bindVertexArray(this.vao)

    this.vb = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vb)

    const vertices = [
      -1, -1,
      1, -1,
      -1,  1,
      1,  1,
    ]
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)

    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  }

  draw() {
    this.gl.bindVertexArray(this.vao)
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4)
    this.gl.bindVertexArray(null)
  }

  dispose() {
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteBuffer(this.vb)
  }
}
