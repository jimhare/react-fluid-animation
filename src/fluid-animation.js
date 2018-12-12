import GLProgram from './gl-program'
import getGLContext from './get-gl-context'

import shaders from './shaders'

const config = {
  TEXTURE_DOWNSAMPLE: 1,
  DENSITY_DISSIPATION: 0.98,
  VELOCITY_DISSIPATION: 0.99,
  PRESSURE_DISSIPATION: 0.8,
  PRESSURE_ITERATIONS: 25,
  CURL: 30,
  SPLAT_RADIUS: 0.005
}

class Pointer {
  constructor() {
    this.id = -1
    this.x = 0
    this.y = 0
    this.dx = 0
    this.dy = 0
    this.down = false
    this.moved = false
    this.color = [30, 0, 300]
  }
}

export default class FluidAnimation {
  constructor(opts) {
    const {
      canvas
    } = opts

    this._canvas = canvas
    this._pointers = [ new Pointer() ]
    this._splatStack = []

    const { gl, ext } = getGLContext(canvas)
    this._gl = gl
    this._ext = ext

    this._initPrograms()
    this._initBlit()
    this.resize()

    this._time = Date.now()
    this._multipleSplats(parseInt(Math.random() * 20) + 5)
  }

  _initPrograms() {
    const gl = this._gl
    const ext = this._ext

    this._programs = { }
    this._programs.clear = new GLProgram(gl, shaders.vert, shaders.clear)
    this._programs.display = new GLProgram(gl, shaders.vert, shaders.display)
    this._programs.splat = new GLProgram(gl, shaders.vert, shaders.splat)
    this._programs.advection = new GLProgram(gl, shaders.vert, ext.supportLinearFiltering
      ? shaders.advection
      : shaders.advectionManualFiltering
    )
    this._programs.divergence = new GLProgram(gl, shaders.vert, shaders.divergence)
    this._programs.curl = new GLProgram(gl, shaders.vert, shaders.curl)
    this._programs.vorticity = new GLProgram(gl, shaders.vert, shaders.vorticity)
    this._programs.pressure = new GLProgram(gl, shaders.vert, shaders.pressure)
    this._programs.gradientSubtract = new GLProgram(gl, shaders.vert, shaders.gradientSubtract)
  }

  resize() {
    const {
      width,
      height
    } = this._canvas

    if (this._width !== width || this._height !== height) {
      this._width = width
      this._height = height

      this._initFramebuffers()
    }
  }

  onMouseMove = (e) => {
    console.log(e.offsetX, e.offsetY)
    this._pointers[0].moved = this._pointers[0].down
    this._pointers[0].dx = (e.offsetX - this._pointers[0].x) * 10.0
    this._pointers[0].dy = (e.offsetY - this._pointers[0].y) * 10.0
    this._pointers[0].x = e.offsetX
    this._pointers[0].y = e.offsetY
  }

  onMouseDown = (e) => {
    this._pointers[0].down = true
    this._pointers[0].color = [
      Math.random() + 0.2,
      Math.random() + 0.2,
      Math.random() + 0.2
    ]
  }

  onMouseUp = (e) => {
    this._pointers[0].down = false
  }

  _initFramebuffers() {
    const gl = this._gl
    const ext = this._ext

    function createFBO(texId, w, h, internalFormat, format, type, param) {
      gl.activeTexture(gl.TEXTURE0 + texId)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0
      )
      gl.viewport(0, 0, w, h)
      gl.clear(gl.COLOR_BUFFER_BIT)

      return [texture, fbo, texId]
    }

    function createDoubleFBO(texId, w, h, internalFormat, format, type, param) {
      let fbo1 = createFBO(texId, w, h, internalFormat, format, type, param)
      let fbo2 = createFBO(texId + 1, w, h, internalFormat, format, type, param)

      return {
        get read() {
          return fbo1
        },
        get write() {
          return fbo2
        },
        swap() {
          const temp = fbo1
          fbo1 = fbo2
          fbo2 = temp
        }
      }
    }

    this._textureWidth = gl.drawingBufferWidth >> config.TEXTURE_DOWNSAMPLE
    this._textureHeight = gl.drawingBufferHeight >> config.TEXTURE_DOWNSAMPLE

    const texType = ext.halfFloatTexType
    const rgba = ext.formatRGBA
    const rg = ext.formatRG
    const r = ext.formatR

    this._density = createDoubleFBO(
      2,
      this._textureWidth,
      this._textureHeight,
      rgba.internalFormat,
      rgba.format,
      texType,
      ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST
    )

    this._velocity = createDoubleFBO(
      0,
      this._textureWidth,
      this._textureHeight,
      rg.internalFormat,
      rg.format,
      texType,
      ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST
    )

    this._divergence = createFBO(
      4,
      this._textureWidth,
      this._textureHeight,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    )

    this._curl = createFBO(
      5,
      this._textureWidth,
      this._textureHeight,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    )

    this._pressure = createDoubleFBO(
      6,
      this._textureWidth,
      this._textureHeight,
      r.internalFormat,
      r.format,
      texType,
      gl.NEAREST
    )
  }

  _initBlit() {
    const gl = this._gl

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
      gl.STATIC_DRAW
    )
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW
    )
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enableVertexAttribArray(0)
  }

  _blit = (destination) => {
    const gl = this._gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination)
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0)
  }

  _splat(x, y, dx, dy, color) {
    const gl = this._gl

    this._programs.splat.bind()
    gl.uniform1i(this._programs.splat.uniforms.uTarget, this._velocity.read[2])
    gl.uniform1f(this._programs.splat.uniforms.aspectRatio, this._canvas.width / this._canvas.height)
    gl.uniform2f(
      this._programs.splat.uniforms.point,
      x / this._canvas.width,
      1.0 - y / this._canvas.height
    )
    gl.uniform3f(this._programs.splat.uniforms.color, dx, -dy, 1.0)
    gl.uniform1f(this._programs.splat.uniforms.radius, config.SPLAT_RADIUS)
    this._blit(this._velocity.write[1])
    this._velocity.swap()

    gl.uniform1i(this._programs.splat.uniforms.uTarget, this._density.read[2])
    gl.uniform3f(
      this._programs.splat.uniforms.color,
      color[0] * 0.3,
      color[1] * 0.3,
      color[2] * 0.3
    )
    this._blit(this._density.write[1])
    this._density.swap()
  }

  _multipleSplats(amount) {
    for (let i = 0; i < amount; ++i) {
      const color = [ Math.random() * 10, Math.random() * 10, Math.random() * 10 ]
      const x = this._canvas.width * Math.random()
      const y = this._canvas.height * Math.random()
      const dx = 1000 * (Math.random() - 0.5)
      const dy = 1000 * (Math.random() - 0.5)
      this._splat(x, y, dx, dy, color)
    }
  }

  update() {
    const gl = this._gl

    const dt = Math.min((Date.now() - this._time) / 1000, 0.016)
    this._time = Date.now()

    gl.viewport(0, 0, this._textureWidth, this._textureHeight)

    if (this._splatStack.length > 0) this._multipleSplats(this._splatStack.pop())

    this._programs.advection.bind()
    gl.uniform2f(
      this._programs.advection.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.advection.uniforms.uVelocity, this._velocity.read[2])
    gl.uniform1i(this._programs.advection.uniforms.uSource, this._velocity.read[2])
    gl.uniform1f(this._programs.advection.uniforms.dt, dt)
    gl.uniform1f(
      this._programs.advection.uniforms.dissipation,
      config.VELOCITY_DISSIPATION
    )
    this._blit(this._velocity.write[1])
    this._velocity.swap()

    gl.uniform1i(this._programs.advection.uniforms.uVelocity, this._velocity.read[2])
    gl.uniform1i(this._programs.advection.uniforms.uSource, this._density.read[2])
    gl.uniform1f(
      this._programs.advection.uniforms.dissipation,
      config.DENSITY_DISSIPATION
    )
    this._blit(this._density.write[1])
    this._density.swap()

    for (let i = 0; i < this._pointers.length; i++) {
      const pointer = this._pointers[i]
      if (pointer.moved) {
        this._splat(pointer.x, pointer.y, pointer.dx, pointer.dy, pointer.color)
        pointer.moved = false
      }
    }

    this._programs.curl.bind()
    gl.uniform2f(
      this._programs.curl.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.curl.uniforms.uVelocity, this._velocity.read[2])
    this._blit(this._curl[1])

    this._programs.vorticity.bind()
    gl.uniform2f(
      this._programs.vorticity.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.vorticity.uniforms.uVelocity, this._velocity.read[2])
    gl.uniform1i(this._programs.vorticity.uniforms.uCurl, this._curl[2])
    gl.uniform1f(this._programs.vorticity.uniforms.curl, config.CURL)
    gl.uniform1f(this._programs.vorticity.uniforms.dt, dt)
    this._blit(this._velocity.write[1])
    this._velocity.swap()

    this._programs.divergence.bind()
    gl.uniform2f(
      this._programs.divergence.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.divergence.uniforms.uVelocity, this._velocity.read[2])
    this._blit(this._divergence[1])

    this._programs.clear.bind()
    let pressureTexId = this._pressure.read[2]
    gl.activeTexture(gl.TEXTURE0 + pressureTexId)
    gl.bindTexture(gl.TEXTURE_2D, this._pressure.read[0])
    gl.uniform1i(this._programs.clear.uniforms.uTexture, pressureTexId)
    gl.uniform1f(this._programs.clear.uniforms.value, config.PRESSURE_DISSIPATION)
    this._blit(this._pressure.write[1])
    this._pressure.swap()

    this._programs.pressure.bind()
    gl.uniform2f(
      this._programs.pressure.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.pressure.uniforms.uDivergence, this._divergence[2])
    pressureTexId = this._pressure.read[2]
    gl.uniform1i(this._programs.pressure.uniforms.uPressure, pressureTexId)
    gl.activeTexture(gl.TEXTURE0 + pressureTexId)
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this._pressure.read[0])
      this._blit(this._pressure.write[1])
      this._pressure.swap()
    }

    this._programs.gradientSubtract.bind()
    gl.uniform2f(
      this._programs.gradientSubtract.uniforms.texelSize,
      1.0 / this._textureWidth,
      1.0 / this._textureHeight
    )
    gl.uniform1i(this._programs.gradientSubtract.uniforms.uPressure, this._pressure.read[2])
    gl.uniform1i(this._programs.gradientSubtract.uniforms.uVelocity, this._velocity.read[2])
    this._blit(this._velocity.write[1])
    this._velocity.swap()

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    this._programs.display.bind()
    gl.uniform1i(this._programs.display.uniforms.uTexture, this._density.read[2])
    this._blit(null)
  }
}