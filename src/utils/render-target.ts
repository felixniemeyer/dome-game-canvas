export default class RenderTarget {
  private res = [1, 1]

  private outTexture: WebGLTexture
  private fbo: WebGLFramebuffer


  private internalFormat: number
  private format: number
  private type: number

  constructor(
    private gl: WebGL2RenderingContext,
    type: 'float' | 'half' | 'ubyte' = 'ubyte',
    channels = 4, 
    filter: number = gl.NEAREST,
    wrap: number = gl.CLAMP_TO_EDGE,
    private depthBuffer: WebGLRenderbuffer | null = null,
  ) {

    this.outTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.outTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)

    this.fbo = gl.createFramebuffer()

    if(type === 'float') {
      this.type = gl.FLOAT
      if(channels === 4) {
        this.internalFormat = gl.RGBA16F
        this.format = gl.RGBA
      } else if(channels === 3) {
        this.internalFormat = gl.RGB16F
        this.format = gl.RGB
      } else if(channels === 2) { 
        this.internalFormat = gl.RG16F
        this.format = gl.RG
      } else if(channels === 1) {
        this.internalFormat = gl.R32F
        this.format = gl.RED
      } else {
        throw new Error(`${channels} channels not implemented for float textures`)
      }
    } else if(type === 'half') {
      this.type = gl.HALF_FLOAT
      if(channels === 4) {
        this.internalFormat = gl.RGBA16F
        this.format = gl.RGBA
      } else if(channels === 3) {
        this.internalFormat = gl.RGB16F
        this.format = gl.RGB
      } else if(channels === 2) { 
        this.internalFormat = gl.RG16F
        this.format = gl.RG
      } else if(channels === 1) {
        this.internalFormat = gl.R16F
        this.format = gl.RED
      } else {
        throw new Error(`${channels} channels not implemented for half textures`)
      }
    } else if(type === 'ubyte') {
      this.type = gl.UNSIGNED_BYTE
      if(channels === 4) {
        this.internalFormat = gl.RGBA
        this.format = gl.RGBA
      } else if(channels === 3) {
        this.internalFormat = gl.RGB
        this.format = gl.RGB
      } else if(channels === 2) { 
        this.internalFormat = gl.RG
        this.format = gl.RG
      } else if(channels === 1) {
        this.internalFormat = gl.RED
        this.format = gl.RED
      } else {
        throw new Error(`${channels} channels not implemented for ubyte textures`)
      }
    } else {
      throw new Error(`${type} not implemented`)
    }
    
  }

  setResolution(x: number, y: number) {
    const gl = this.gl
    this.res = [x,y]

    gl.bindTexture(gl.TEXTURE_2D, this.outTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, this.internalFormat, x, y, 0, this.format, this.type, null)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outTexture, 0)
    if(this.depthBuffer) {
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer)
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0])
    // TODO check if complete 
    if(gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer is not complete')
    }
  }

  bind() {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0])
    gl.viewport(0, 0, this.res[0], this.res[1])
    // check
  }

  getTexture() {
    return this.outTexture
  }

  dispose() {
    this.gl.deleteTexture(this.outTexture)
    this.gl.deleteFramebuffer(this.fbo)
  }
}
