// A stand-in for WebXR, for the tests: run in the page before its scripts (page.addInitScript).
// navigator.xr offers immersive-vr; its session draws into a framebuffer of the page (two eyes side
// by side, W x H each) and has one controller. window.__xrMock drives it: frame(time) runs the
// frame the session asked for, controllerPosition moves the controller (rayMatrix, column-major,
// aims it), sphere() finds a red sphere in each eye's picture.
(() => {
  const W = 320, H = 360;
  const mock = { W, H, frames: [], callbacks: [], ended: false };
  window.__xrMock = mock;
  class Target {
    constructor() {
      this.listeners = {};
    }
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }
    dispatch(type, event = {}) {
      for (const listener of this.listeners[type] || []) listener({ type, ...event });
    }
  }
  const n = 0.03, f = 50;
  const projection = new Float32Array([H / W, 0, 0, 0, 0, 1, 0, 0, 0, 0, -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0]);
  const pose = (x, y, z) => ({ transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]) } });
  const gamepad = { buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
  const controller = { handedness: "right", targetRaySpace: { name: "ray" }, gripSpace: { name: "grip" }, gamepad };
  mock.controller = controller;
  mock.controllerPosition = [0.2, 1.1, -0.45];

  class Session extends Target {
    constructor(mode) {
      super();
      this.mode = mode;
      this.renderState = {};
      this.inputSources = [controller];
      mock.session = this;
    }
    updateRenderState(state) {
      Object.assign(this.renderState, state);
    }
    async requestReferenceSpace(type) {
      return { type };
    }
    requestAnimationFrame(callback) {
      mock.callbacks.push(callback);
      return mock.callbacks.length;
    }
    async end() {
      mock.ended = true;
      this.dispatch("end");
    }
  }
  /** One frame: the callback the session asked for last, with the eyes 1.2 m up, 64 mm apart. */
  mock.frame = (time) => {
    const callback = mock.callbacks.shift();
    if (!callback) return false;
    const views = [-0.032, 0.032].map((x, i) => ({ eye: i ? "right" : "left", projectionMatrix: projection, ...pose(x, 1.2, 0) }));
    callback(time, {
      session: mock.session,
      getViewerPose: () => ({ views, ...pose(0, 1.2, 0) }),
      getPose: (space) => {
        if (space === controller.gripSpace) return pose(...mock.controllerPosition);
        // Where the controller points: straight ahead from where it is, unless aimed (mock.rayMatrix)
        if (space === controller.targetRaySpace) return mock.rayMatrix ? { transform: { matrix: mock.rayMatrix } } : pose(...mock.controllerPosition);
        return null;
      },
    });
    return true;
  };
  // (the browser's own navigator.xr is a getter of Navigator.prototype)
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === "immersive-vr" || (mode === "immersive-ar" && new URLSearchParams(location.search).has("ar")),
      requestSession: async (mode, options) => {
        mock.requested = { mode, options };
        const session = new Session(mode);
        session.enabledFeatures = [...(options.requiredFeatures ?? [])];
        if (layers && options.optionalFeatures?.includes("layers")) session.enabledFeatures.push("layers");
        return session;
      },
    },
  });
  // A layer's framebuffer is an "opaque framebuffer": the browser attaches its buffers itself, and
  // Chromium's WebGL knows of no attachment of it. drawBuffers filters out every buffer it knows no
  // attachment for (WebGLFramebuffer::DrawBuffersIfNecessary), so drawBuffers([COLOR_ATTACHMENT0])
  // on a layer's framebuffer turns its draw buffer OFF, without an error: nothing drawn or copied
  // into it shows from then on. The same here. (?laxFramebuffer: an ordinary framebuffer instead.)
  mock.opaque = new WeakSet();
  mock.opaqueDrawBuffersCalls = 0;
  if (!new URLSearchParams(location.search).has("laxFramebuffer")) {
    const drawBuffers = WebGL2RenderingContext.prototype.drawBuffers;
    WebGL2RenderingContext.prototype.drawBuffers = function (buffers) {
      const bound = this.getParameter(this.DRAW_FRAMEBUFFER_BINDING);
      const list = Array.from(buffers);
      // (BACK and the like are refused with an error, as on any framebuffer object)
      if (!bound || !mock.opaque.has(bound) || list.some((b, i) => b !== this.NONE && b !== this.COLOR_ATTACHMENT0 + i)) {
        return drawBuffers.call(this, buffers);
      }
      mock.opaqueDrawBuffersCalls++;
      return drawBuffers.call(this, list.map(() => this.NONE));
    };
  }
  window.XRWebGLLayer = class {
    constructor(session, gl, options) {
      if (!mock.compatible.has(gl)) throw new DOMException("The context is not XR compatible", "InvalidStateError");
      if (gl.isContextLost()) throw new DOMException("The context is lost", "InvalidStateError");
      mock.layerOptions = options;
      mock.gl = gl;
      // An eye's size follows the resolution asked for, as a headset's does (W x H at 70%)
      const scale = (options?.framebufferScaleFactor ?? 0.7) / 0.7;
      this.eyeW = Math.round(W * scale);
      this.eyeH = Math.round(H * scale);
      this.framebufferWidth = 2 * this.eyeW;
      this.framebufferHeight = this.eyeH;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2 * this.eyeW, this.eyeH);
      this.framebuffer = gl.createFramebuffer();
      const previous = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, previous);
      mock.opaque.add(this.framebuffer);
      mock.layer = this;
    }
    getViewport(view) {
      return { x: view.eye === "right" ? this.eyeW : 0, y: 0, width: this.eyeW, height: this.eyeH };
    }
  };
  // (the browser's own refuses without a headset)
  // ?layers: WebXR layers, with quad layers whose texture is a texture of the page's (mock.quad)
  const layers = new URLSearchParams(location.search).has("layers");
  if (layers) {
    window.XRWebGLBinding = class {
      constructor(session, gl) {
        this.gl = gl;
      }
      createQuadLayer(init) {
        const quad = { init, width: 1, height: 1, transform: null, needsRedraw: true, texture: null };
        (mock.quads ??= []).push(quad);
        if (init.viewPixelWidth >= 1000) mock.quad = quad; // the panel's (the others are the rays' and dots')
        return quad;
      }
      getSubImage(quad) {
        const gl = this.gl;
        if (!quad.texture) {
          quad.texture = gl.createTexture();
          const previous = gl.getParameter(gl.TEXTURE_BINDING_2D);
          gl.bindTexture(gl.TEXTURE_2D, quad.texture);
          gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, quad.init.viewPixelWidth, quad.init.viewPixelHeight);
          gl.bindTexture(gl.TEXTURE_2D, previous);
        }
        quad.needsRedraw = false;
        quad.drawn = (quad.drawn ?? 0) + 1;
        return { colorTexture: quad.texture, textureWidth: quad.init.viewPixelWidth, textureHeight: quad.init.viewPixelHeight };
      }
    };
  }
  /** The rows of the quad layer's texture (RGBA, the first row its bottom), or null. */
  mock.quadPixels = (quad = mock.quad) => {
    const gl = mock.gl;
    if (!quad?.texture) return null;
    const { viewPixelWidth: w, viewPixelHeight: h } = quad.init;
    const framebuffer = gl.createFramebuffer();
    const previous = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, quad.texture, 0);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, previous);
    gl.deleteFramebuffer(framebuffer);
    return { w, h, pixels };
  };
  // ?noFloatLinear: a GPU that does not filter float textures; ?noFloatBlend: one that does not blend
  // into float render targets (as a mobile one may not)
  const hidden = ["noFloatLinear", "noFloatBlend"].filter((flag) => new URLSearchParams(location.search).has(flag))
    .map((flag) => (flag === "noFloatLinear" ? "OES_texture_float_linear" : "EXT_float_blend"));
  if (hidden.length) {
    const getExtension = WebGL2RenderingContext.prototype.getExtension;
    const getSupportedExtensions = WebGL2RenderingContext.prototype.getSupportedExtensions;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      return hidden.includes(name) ? null : getExtension.call(this, name);
    };
    WebGL2RenderingContext.prototype.getSupportedExtensions = function () {
      return getSupportedExtensions.call(this).filter((name) => !hidden.includes(name));
    };
  }
  // With mock.loseContextOnce (set before the page loads, as ?loseContextOnce in the address), the
  // first context made compatible is lost and restored on the way, as the WebXR specification
  // allows a browser to do (and as the Quest's browser seems to the first time)
  mock.loseContextOnce = new URLSearchParams(location.search).has("loseContextOnce");
  mock.compatible = new Set();
  WebGL2RenderingContext.prototype.makeXRCompatible = async function () {
    if (mock.compatible.has(this)) return;
    if (mock.loseContextOnce) {
      mock.loseContextOnce = false;
      mock.contextsLost = (mock.contextsLost ?? 0) + 1;
      const lose = this.getExtension("WEBGL_lose_context");
      const restored = new Promise((resolve) => this.canvas.addEventListener("webglcontextrestored", resolve, { once: true }));
      lose.loseContext();
      setTimeout(() => lose.restoreContext(), 50);
      await restored;
    }
    mock.compatible.add(this);
  };
  /** Loses the context of a canvas now, and restores it a moment later (as a browser does when it
   *  lets go of the GPU for a while). */
  mock.loseContext = (selector) => {
    const gl = document.querySelector(selector).getContext("webgl2");
    const lose = gl.getExtension("WEBGL_lose_context");
    lose.loseContext();
    setTimeout(() => lose.restoreContext(), 50);
  };
    /**
   * What the left eye sees, as the headset puts it together: the session's layers in their order -
   * the quad layers where they are in the room, the 3D view's frame over them by its alpha. A PNG
   * data URL, *zoom* times enlarged (pixel by pixel), of the part *crop* ([x0, y0, x1, y1] as
   * fractions of the eye) if given.
   */
  mock.composite = (zoom = 1, crop = [0, 0, 1, 1]) => {
    const gl = mock.gl, W = mock.layer.eyeW, H = mock.layer.eyeH;
    const frame = new Uint8Array(2 * W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mock.layer.framebuffer);
    gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const layers = mock.session.renderState.layers ?? [mock.session.renderState.baseLayer];
    const quads = layers.filter((layer) => layer !== mock.layer).map((quad) => {
      // room -> the quad's own space: the inverse of its rigid transform (rotation transposed)
      const m = quad.transform.matrix;
      const inverse = (p) => {
        const d = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
        return [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
      };
      const direction = (v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
      return { quad, inverse, direction, picture: mock.quadPixels(quad) };
    });
    const eye = [-0.032, 1.2, 0];
    const out = new Uint8ClampedArray(W * H * 4);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const ray = [(((px + 0.5) / W) * 2 - 1) * (W / H), 1 - ((py + 0.5) / H) * 2, -1];
        let color = [0, 0, 0];
        for (const { quad, inverse, direction, picture } of quads) {
          if (!picture) continue;
          const o = inverse(eye), d = direction(ray);
          const t = -o[2] / d[2];
          const x = o[0] + t * d[0], y = o[1] + t * d[1];
          if (!(t > 0) || Math.abs(x) > quad.width / 2 || Math.abs(y) > quad.height / 2) continue;
          const u = Math.min(picture.w - 1, Math.floor((x / quad.width + 0.5) * picture.w));
          const v = Math.min(picture.h - 1, Math.floor((y / quad.height + 0.5) * picture.h));
          const i = (v * picture.w + u) * 4;
          const a = picture.pixels[i + 3] / 255; // premultiplied, over what is under it
          color = [0, 1, 2].map((k) => picture.pixels[i + k] + color[k] * (1 - a));
        }
        const f = ((H - 1 - py) * 2 * W + px) * 4, alpha = frame[f + 3] / 255;
        const i = (py * W + px) * 4;
        for (let k = 0; k < 3; k++) out[i + k] = frame[f + k] + color[k] * (1 - alpha); // premultiplied, over
        out[i + 3] = 255;
      }
    }
    const whole = document.createElement("canvas");
    whole.width = W;
    whole.height = H;
    whole.getContext("2d").putImageData(new ImageData(out, W, H), 0, 0);
    const [x0, y0, x1, y1] = [crop[0] * W, crop[1] * H, crop[2] * W, crop[3] * H].map(Math.round);
    const canvas = document.createElement("canvas");
    canvas.width = (x1 - x0) * zoom;
    canvas.height = (y1 - y0) * zoom;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(whole, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };
  /** How much of each eye was drawn into (pixels not left clear and black): an image cropped by a
   *  view of the wrong size leaves part of an eye undrawn. */
  mock.coverage = () => {
    const gl = mock.gl, W = mock.layer.eyeW, H = mock.layer.eyeH;
    const pixels = new Uint8Array(2 * W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mock.layer.framebuffer);
    gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return [0, 1].map((e) => {
      let drawn = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * 2 * W + e * W + x) * 4;
        if (pixels[i] || pixels[i + 1] || pixels[i + 2] || pixels[i + 3]) drawn++;
      }
      return drawn / (W * H);
    });
  };
  /** What both eyes show, as a PNG data URL. */
  mock.image = () => {
    const W = mock.layer.eyeW, H = mock.layer.eyeH;
    const gl = mock.gl;
    const pixels = new Uint8Array(2 * W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mock.layer.framebuffer);
    gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const canvas = document.createElement("canvas");
    canvas.width = 2 * W;
    canvas.height = H;
    const context = canvas.getContext("2d");
    const image = context.createImageData(2 * W, H);
    for (let y = 0; y < H; y++) image.data.set(pixels.subarray((H - 1 - y) * 2 * W * 4, (H - y) * 2 * W * 4), y * 2 * W * 4);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  };
  /** Where the red sphere is in each eye: its centre as fractions of the eye's width and height. */
  mock.sphere = () => {
    const W = mock.layer.eyeW, H = mock.layer.eyeH;
    const gl = mock.gl;
    const pixels = new Uint8Array(2 * W * H * 4);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, mock.layer.framebuffer);
    gl.readPixels(0, 0, 2 * W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    return [0, 1].map((e) => {
      let count = 0, sx = 0, sy = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * 2 * W + e * W + x) * 4;
          if (pixels[i] > 90 && pixels[i + 1] < 60 && pixels[i + 2] < 60) {
            count++;
            sx += x;
            sy += y;
          }
        }
      }
      return count ? { pixels: count, x: sx / count / W, y: sy / count / H } : { pixels: 0 };
    });
  };
})();
