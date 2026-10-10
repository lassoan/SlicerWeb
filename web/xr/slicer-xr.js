/* Slicer in immersive XR: the first 3D view of SlicerWeb, rendered for a headset (Meta Quest 3).
 *
 * Loaded by SlicerWeb's page for an application with the feature webxr (its application.json;
 * web/src/main.ts), it adds an "Enter VR" button - and "Enter AR" where the headset can show the room behind the
 * scene - and draws Slicer's own 3D view in the session: the same renderers, displayable managers
 * and volume rendering as on the page. Nothing of SlicerWeb is changed for it.
 *
 * How a frame is drawn. VTK renders the view into framebuffers of its own and then copies the
 * result to framebuffer 0, which in a page is the canvas. While an XR frame is drawn, binding
 * framebuffer 0 binds the headset's framebuffer instead (the WebGL context's bindFramebuffer is
 * wrapped), and a copy into it is moved to the rectangle of the eye being drawn. The view's window
 * is made an eye's size, its renderers look through a camera placed at the eye with the eye's
 * projection, and the view is rendered once per eye (xr/slicer_xr.py).
 *
 * The scene is placed in the room by a transform from the room's coordinates (metres) to Slicer's
 * (RAS, millimetres): at real size, a little below the eyes and in front of them, the patient
 * facing the viewer. Grab it with a controller's trigger or grip (or a pinch) to move and turn it;
 * grab it with both hands to scale it; a thumbstick turns (left-right) and scales (up-down) it
 * around its centre; A or X puts it back where it started.
 *
 * A panel floats in the room, off to the right of the viewer: point a controller at it and pull the
 * trigger to place markups - points, lines, angles, curves, planes - with the tip of a controller,
 * to show or hide their handles, or to set the rendering. Data is loaded on the
 * page before entering. B or Y hides the panel, or shows it again in front of the viewer.
 */

// Where this script is, and slicer_xr.py beside it. (Not new URL("./", import.meta.url): Vite's
// development server takes that for an asset of its own and rewrites it.)
const SCRIPT_URL = import.meta.url;
const BASE = new URL("./", SCRIPT_URL);

// --------------------------------------------------------------------------------- the log
// What goes wrong in a headset is seen in no console one can read there: errors, warnings and this
// script's own messages are sent to the server (xr/log: web/vite.xr.ts prints them), a second at a time.
const remoteLog = (() => {
  const pending = [];
  let timer = null;
  const send = () => {
    timer = null;
    const lines = pending.splice(0);
    if (lines.length) fetch(new URL("log", BASE), { method: "POST", body: JSON.stringify(lines), keepalive: true }).catch(() => {});
  };
  const text = (value) => {
    if (value instanceof Error) return `${value.message}\n${value.stack ?? ""}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  const log = (level, args) => {
    pending.push({ level, text: args.map(text).join(" ").slice(0, 4000) });
    if (pending.length > 200) pending.splice(0, pending.length - 200);
    timer ??= setTimeout(send, 1000);
  };
  for (const level of ["error", "warn", "info"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      if (level !== "info" || /Slicer XR/.test(String(args[0]))) log(level, args);
    };
  }
  window.addEventListener("error", (e) => log("error", [e.error ?? e.message]));
  window.addEventListener("unhandledrejection", (e) => log("error", ["Unhandled rejection:", e.reason]));
  return log;
})();
// How the page came to be loaded (a "reload" that nobody asked for is the browser starting a tab
// again that crashed - out of memory, say), and when it is gone: a page that ends without saying
// so did not end on its own
{
  const navigation = performance.getEntriesByType?.("navigation")?.[0]?.type ?? "unknown";
  const memory = navigator.deviceMemory ? `, device memory ${navigator.deviceMemory} GB` : "";
  remoteLog("info", [`Slicer XR: page opened (${navigation})${memory}, ${navigator.userAgent}`]);
  const opened = performance.now();
  const seconds = () => `${((performance.now() - opened) / 1000).toFixed(1)} s`;
  const heap = () => (performance.memory ? `, JavaScript heap ${Math.round(performance.memory.usedJSHeapSize / 2 ** 20)} MB` : "");
  const ready = setInterval(() => {
    if (window.slicerWeb?.store?.status !== "ready") return;
    clearInterval(ready);
    remoteLog("info", [`Slicer XR: Slicer is ready after ${seconds()}${heap()}`]);
  }, 500);
  window.addEventListener("pagehide", (event) => {
    // (not remoteLog, which sends a second later: the page is gone by then)
    const text = `Slicer XR: page closing after ${seconds()}${event.persisted ? " (kept for going back)" : ""}${heap()}`;
    try {
      navigator.sendBeacon(new URL("log", BASE), JSON.stringify([{ level: "info", text }]));
    } catch {
      // nobody to tell
    }
  });
}

// --------------------------------------------------------------------------------- float textures
// Volume rendering samples float textures with linear filtering: the volume (a 16 bit one, MRHead
// or a CT, goes to the card as normalized 16 bit where EXT_texture_norm16 is, else as 32 bit float)
// and the transfer functions' lookup tables (32 bit float). A GPU that does not filter 32 bit float
// textures (no OES_texture_float_linear, as a mobile one may be) reads such a texture as 0
// everywhere: no opacity anywhere, and the volume rendering shows nothing - as MRHead did on the
// Quest. So, on such a GPU, a single-channel volume is given to the card as half float (R16F,
// filtered by any WebGL 2), holding the values the shader would read from the other formats, and
// every other 32 bit float texture is sampled at its nearest texel instead of being filtered (all
// a lookup table needs). 16 bit volumes go as half float everywhere: the same, without relying on
// EXT_texture_norm16. (?xrHalfFloat=0 leaves all as it is, for the tests.)
const GL_R16F = 0x822d, GL_R32F = 0x822e, GL_RG32F = 0x8230, GL_RGB32F = 0x8815, GL_RGBA32F = 0x8814;
const GL_R16 = 0x822a, GL_R16_SNORM = 0x8f98;
const FLOAT32_FORMATS = new Set([GL_R32F, GL_RG32F, GL_RGB32F, GL_RGBA32F]);

function adaptFloatTextures(gl) {
  const floatLinear = !!gl.getExtension("OES_texture_float_linear");
  const norm16 = !!gl.getExtension("EXT_texture_norm16");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const has = (name) => (gl.getSupportedExtensions() ?? []).includes(name) ? "yes" : "no";
  console.info(`Slicer XR: WebGL 2 context: ${renderer}; 16 bit textures: ${norm16 ? "yes" : "no"}; float textures filtered: ${floatLinear ? "yes" : "no"}; ` +
    `float render targets: ${has("EXT_color_buffer_float")}, half float: ${has("EXT_color_buffer_half_float")}, float blending: ${has("EXT_float_blend")}`);

  // The texture bound to each unit and target, and what each texture holds
  const bound = new Map();
  let unit = gl.TEXTURE0;
  const textureAt = (target) => bound.get(`${unit}:${target}`);
  const halfFloat = new WeakSet(); // volumes made half float: their data arrives converted
  const unfilterable = new WeakSet(); // 32 bit float textures, on a GPU that does not filter them
  const activeTexture = gl.activeTexture.bind(gl);
  const bindTexture = gl.bindTexture.bind(gl);
  const texParameteri = gl.texParameteri.bind(gl);
  gl.activeTexture = (u) => {
    unit = u;
    activeTexture(u);
  };
  gl.bindTexture = (target, texture) => {
    bound.set(`${unit}:${target}`, texture);
    bindTexture(target, texture);
  };

  /** The nearest-texel equivalent of a filter, for a texture that cannot be filtered. */
  const nearest = (filter) =>
    filter === gl.LINEAR ? gl.NEAREST
      : filter === gl.LINEAR_MIPMAP_LINEAR || filter === gl.NEAREST_MIPMAP_LINEAR || filter === gl.LINEAR_MIPMAP_NEAREST ? gl.NEAREST_MIPMAP_NEAREST
        : filter;
  /** A 32 bit float texture was made on a GPU that does not filter it: sampled at nearest texels. */
  const madeFloat = (target, internalformat) => {
    if (floatLinear || !FLOAT32_FORMATS.has(internalformat)) return;
    const texture = textureAt(target);
    if (!texture) return;
    unfilterable.add(texture);
    texParameteri(target, gl.TEXTURE_MIN_FILTER, nearest(gl.getTexParameter(target, gl.TEXTURE_MIN_FILTER)));
    texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  };
  gl.texParameteri = (target, pname, param) => {
    if ((pname === gl.TEXTURE_MIN_FILTER || pname === gl.TEXTURE_MAG_FILTER) && unfilterable.has(textureAt(target))) param = nearest(param);
    texParameteri(target, pname, param);
  };
  const texParameterf = gl.texParameterf.bind(gl);
  gl.texParameterf = (target, pname, param) => {
    if ((pname === gl.TEXTURE_MIN_FILTER || pname === gl.TEXTURE_MAG_FILTER) && unfilterable.has(textureAt(target))) param = nearest(param);
    texParameterf(target, pname, param);
  };

  const toHalfFloat = (internalformat, type) =>
    (internalformat === GL_R16_SNORM && type === gl.SHORT) || (internalformat === GL_R16 && type === gl.UNSIGNED_SHORT) ||
    (internalformat === GL_R32F && type === gl.FLOAT && !floatLinear);
  /** The values a normalized 16 bit texture holds for this data, as floats. */
  const normalized = (type, data, offset, count) => {
    const source = data.subarray(offset ?? 0, (offset ?? 0) + count);
    if (type === gl.FLOAT) return source;
    const out = new Float32Array(count);
    if (type === gl.SHORT) for (let i = 0; i < count; i++) out[i] = Math.max(-1, source[i] / 32767);
    else for (let i = 0; i < count; i++) out[i] = source[i] / 65535;
    return out;
  };
  const report = (what) => {
    const error = gl.getError();
    console.info(`Slicer XR: volume texture ${what}${error ? `: GL error 0x${error.toString(16)}` : ""}`);
  };

  const texImage2D = gl.texImage2D.bind(gl);
  gl.texImage2D = (...args) => {
    texImage2D(...args);
    madeFloat(args[0], args[2]);
  };
  const texStorage2D = gl.texStorage2D.bind(gl);
  gl.texStorage2D = (target, levels, internalformat, width, height) => {
    texStorage2D(target, levels, internalformat, width, height);
    madeFloat(target, internalformat);
  };
  const texImage3D = gl.texImage3D.bind(gl);
  gl.texImage3D = (...args) => {
    const [target, level, internalformat, width, height, depth, border, format, type, data, offset] = args;
    const describe = `${width}x${height}x${depth}, format 0x${internalformat.toString(16)}, type 0x${type.toString(16)}`;
    if (target === gl.TEXTURE_3D && format === gl.RED && toHalfFloat(internalformat, type) && (data == null || ArrayBuffer.isView(data))) {
      const values = data == null ? null : normalized(type, data, offset, width * height * depth);
      texImage3D(target, level, GL_R16F, width, height, depth, border, gl.RED, gl.FLOAT, values);
      halfFloat.add(textureAt(target));
      return report(`${describe} -> half float`);
    }
    texImage3D(...args);
    madeFloat(target, internalformat);
    if (target === gl.TEXTURE_3D) report(describe);
  };
  const texStorage3D = gl.texStorage3D.bind(gl);
  gl.texStorage3D = (target, levels, internalformat, width, height, depth) => {
    if (target === gl.TEXTURE_3D && (internalformat === GL_R16_SNORM || internalformat === GL_R16 || (internalformat === GL_R32F && !floatLinear))) {
      texStorage3D(target, levels, GL_R16F, width, height, depth);
      halfFloat.add(textureAt(target));
      return report(`storage ${width}x${height}x${depth}, format 0x${internalformat.toString(16)} -> half float`);
    }
    texStorage3D(target, levels, internalformat, width, height, depth);
    madeFloat(target, internalformat);
  };
  const texSubImage3D = gl.texSubImage3D.bind(gl);
  gl.texSubImage3D = (...args) => {
    const [target, level, x, y, z, width, height, depth, format, type, data, offset] = args;
    if (target === gl.TEXTURE_3D && halfFloat.has(textureAt(target)) && format === gl.RED && ArrayBuffer.isView(data) &&
        (type === gl.SHORT || type === gl.UNSIGNED_SHORT || type === gl.FLOAT)) {
      return texSubImage3D(target, level, x, y, z, width, height, depth, gl.RED, gl.FLOAT, normalized(type, data, offset, width * height * depth));
    }
    texSubImage3D(...args);
  };
}

// Every WebGL 2 context the page makes (the views' contexts are made by SlicerWeb's WebAssembly,
// after this script has run)
{
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (type === "webgl2" && context && !context.__slicerXRVolumes) {
      context.__slicerXRVolumes = true;
      try {
        if (new URLSearchParams(location.search).get("xrHalfFloat") !== "0") adaptFloatTextures(context);
      } catch (error) {
        console.warn("Slicer XR: float textures are left as they are", error);
      }
    }
    return context;
  };
}
const NEAR_M = 0.03; // the near and far planes of the eyes, in metres of the room
const FAR_M = 50;

// The thumbstick: nothing happens until it is pushed this far (of 1); then it turns or zooms slowly,
// a little faster the further it goes, and at full speed once it is pushed nearly all the way
const STICK_DEAD_ZONE = 0.5;
const STICK_FAST = 0.92; // pushed this far: full speed
const STICK_SLOW = [0.2, 0.45]; // the speed (of full) from the edge of the dead zone to STICK_FAST
const STICK_TURN_RATE = 1.4; // radians per second, at full speed
const STICK_ZOOM_RATE = 1.1; // e-fold of the size per second, at full speed

/** How much a thumbstick axis counts, with its sign: 0 in the dead zone, slow in the middle of the
 *  way, 1 at the end. */
function stickResponse(value) {
  const amount = Math.abs(value);
  if (amount < STICK_DEAD_ZONE) return 0;
  if (amount >= STICK_FAST) return Math.sign(value);
  const t = (amount - STICK_DEAD_ZONE) / (STICK_FAST - STICK_DEAD_ZONE);
  return Math.sign(value) * (STICK_SLOW[0] + t * (STICK_SLOW[1] - STICK_SLOW[0]));
}

// --------------------------------------------------------------------------------- 4x4 matrices
// Column-major, as WebXR gives them (element of row r, column c at [c * 4 + r]).
const M = {
  identity() {
    return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  multiply(a, b) {
    const out = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = sum;
      }
    }
    return out;
  },
  invert(m) {
    const inv = new Float64Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
  translation(x, y, z) {
    const m = M.identity();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
  },
  scaling(s) {
    const m = M.identity();
    m[0] = m[5] = m[10] = s;
    return m;
  },
  /** Rotation about the vertical (y) axis of the room. */
  yaw(angle) {
    const m = M.identity();
    const c = Math.cos(angle), s = Math.sin(angle);
    m[0] = c;
    m[2] = -s;
    m[8] = s;
    m[10] = c;
    return m;
  },
  /** The rotation that turns unit vector a onto unit vector b. */
  rotationBetween(a, b) {
    const axis = cross(a, b);
    const sin = Math.hypot(...axis);
    const cos = dot(a, b);
    if (sin < 1e-9) return M.identity();
    const [x, y, z] = axis.map((v) => v / sin);
    const t = 1 - cos;
    return new Float64Array([
      t * x * x + cos, t * x * y + sin * z, t * x * z - sin * y, 0,
      t * x * y - sin * z, t * y * y + cos, t * y * z + sin * x, 0,
      t * x * z + sin * y, t * y * z - sin * x, t * z * z + cos, 0,
      0, 0, 0, 1,
    ]);
  },
  point(m, p) {
    return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
  },
  vector(m, v) {
    return [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]);
  },
  /** Row-major, as vtkMatrix4x4::DeepCopy takes it. */
  rowMajor(m) {
    const out = new Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r];
    return out;
  },
  scaleOf(m) {
    return Math.hypot(m[0], m[1], m[2]);
  },
};
// The volume rendering's levels of detail: a ray for every n-th pixel across and down, and the step
// along it as a multiple of the step it had (Slicer's, for its quality setting)
const VOLUME_LEVELS = [[1, 1], [1.5, 1], [2, 1.5], [3, 2], [4, 2.5], [6, 3]];
const xyz = (p) => ({ x: p[0], y: p[1], z: p[2] });
const SKY_RADIUS_M = 20;
const RAY_WIDTH_M = 0.0025; // the white middle of a controller's ray
const RAY_FEATHER_PX = 1.25; // its soft edges, in pixels of an eye
// What a quad layer's width and height are taken to be: its whole width and height in metres, as the
// WebXR layers specification says - but the Quest's compositor takes them for half of it (and shows
// the quad twice as large), so they are halved there (as three.js and A-Frame do)
const QUAD_SIZE_FACTOR = /OculusBrowser|Quest/.test(navigator.userAgent) ? 0.5 : 1;
const scale3 = (x, y, z) => new Float64Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// --------------------------------------------------------------------------------- the page

function slicerWebApp() {
  const app = window.slicerWeb;
  return app && app.store && app.store.status === "ready" && app.pyodide ? app : null;
}

let pythonReady = null;
/** The Python half (xr/slicer_xr.py), loaded once. */
function slicerXRPython(app) {
  if (!pythonReady) {
    pythonReady = fetch(new URL("slicer_xr.py", BASE)).then(async (response) => {
      if (!response.ok) throw new Error(`slicer_xr.py: ${response.status}`);
      return app.pyodide.runPython(await response.text(), { filename: "slicer_xr.py" });
    });
    pythonReady.catch(() => (pythonReady = null));
  }
  return pythonReady;
}

// --------------------------------------------------------------------------------- framebuffer 0

/** Points framebuffer 0 of the WebGL context at the XR layer's framebuffer while a frame is drawn,
 *  and moves copies into it to the eye's rectangle. Installed once per context. */
function redirectDefaultFramebuffer(gl) {
  if (gl.__slicerXR) return gl.__slicerXR;
  const state = { framebuffer: null, offset: [0, 0] };
  const bindFramebuffer = gl.bindFramebuffer.bind(gl);
  const blitFramebuffer = gl.blitFramebuffer.bind(gl);
  const drawBuffers = gl.drawBuffers.bind(gl);
  const readBuffer = gl.readBuffer.bind(gl);
  const getParameter = gl.getParameter.bind(gl);
  const drawingToXR = () => state.framebuffer && getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === state.framebuffer;
  const readingFromXR = () => state.framebuffer && getParameter(gl.READ_FRAMEBUFFER_BINDING) === state.framebuffer;

  gl.bindFramebuffer = (target, framebuffer) => bindFramebuffer(target, framebuffer || state.framebuffer || null);
  gl.blitFramebuffer = (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) => {
    if (!drawingToXR()) return blitFramebuffer(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
    // The eye's rectangle: the scissor box VTK left for its own viewport would clip it away
    const [ox, oy] = state.offset;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    blitFramebuffer(sx0, sy0, sx1, sy1, dx0 + ox, dy0 + oy, dx1 + ox, dy1 + oy, gl.COLOR_BUFFER_BIT, filter);
    state.blits = (state.blits ?? 0) + 1;
    if (scissor) gl.enable(gl.SCISSOR_TEST);
  };
  // The draw buffers of the XR framebuffer are never set. It is drawn into as it comes (its draw
  // buffer is its colour attachment), and setting it breaks it: the framebuffer of an XRWebGLLayer
  // is an "opaque framebuffer" whose attachments the browser makes itself, Chromium's drawBuffers
  // turns every buffer it knows no attachment for into NONE, and so drawBuffers([COLOR_ATTACHMENT0])
  // there turns drawing OFF, with no error - nothing copied into the framebuffer shows from then on.
  // (That was done once per page, with the first frame of the first session: the scene did not
  // appear in the first session on the Quest, and did in the ones after it.) VTK, to which this is
  // framebuffer 0, asks for its back buffer: taken as done, and what VTK reads of it says so.
  gl.drawBuffers = (buffers) => {
    if (!drawingToXR()) return drawBuffers(buffers);
    if (!state.askedDrawBuffers) {
      state.askedDrawBuffers = true;
      console.info(`Slicer XR: draw buffers [${Array.from(buffers, (b) => "0x" + b.toString(16))}] asked of the headset's framebuffer (left as it is)`);
    }
  };
  gl.readBuffer = (buffer) => {
    // (reading the back buffer of what is the XR framebuffer: its colour attachment, as it comes)
    if (readingFromXR() && buffer === gl.BACK) return;
    readBuffer(buffer);
  };
  gl.getParameter = (name) => {
    if (name === gl.DRAW_BUFFER0 && drawingToXR()) return gl.BACK;
    if (name === gl.READ_BUFFER && readingFromXR()) return gl.BACK;
    return getParameter(name);
  };

  state.begin = (framebuffer) => {
    state.framebuffer = framebuffer;
    // Bound now, whatever was before: the page may have left a framebuffer of VTK's bound, and
    // VTK copies its frame to the one bound when it starts (slicer_xr.py beginFrame tells VTK that
    // this one, framebuffer 0 to it, is bound)
    bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer);
    bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  };
  state.end = () => {
    const framebuffer = state.framebuffer;
    state.framebuffer = null;
    // The XR framebuffer is only valid within the frame: what was bound to it is framebuffer 0 again
    if (getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === framebuffer) bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    if (getParameter(gl.READ_FRAMEBUFFER_BINDING) === framebuffer) bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  };
  gl.__slicerXR = state;
  return state;
}

// --------------------------------------------------------------------------------- the context

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now0 = () => performance.now();

/** The 3D view's canvas and its WebGL context, once there is a view whose context is not lost
 *  (SlicerWeb makes a view anew, on a new canvas, when its context was lost); null on timeout.
 *  *notCanvas*: a canvas that is on its way out, not to be taken. */
async function currentView(python, timeoutMs, notCanvas = null) {
  const until = performance.now() + timeoutMs;
  for (;;) {
    const selector = python.viewCanvasSelector();
    const canvas = selector && document.querySelector(selector);
    // Asked only of a canvas whose view is made: it has its context then (this does not make one)
    const gl = canvas && canvas !== notCanvas ? canvas.getContext("webgl2") : null;
    if (gl && !gl.isContextLost()) return { selector, canvas, gl };
    if (performance.now() > until) return null;
    await sleep(100);
  }
}

/**
 * The 3D view, with its WebGL context made XR compatible.
 *
 * A browser may lose a context and restore it on the way to making it XR compatible (the WebXR
 * specification allows it, and the Quest's browser does it the first time). SlicerWeb then makes
 * the view anew, on a new canvas with a new context - which is not XR compatible yet - so that view
 * is waited for and made compatible in turn, until one stays.
 */
async function makeViewXRCompatible(python, timeoutMs = 20000) {
  let lostCanvas = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const view = await currentView(python, timeoutMs, lostCanvas);
    if (!view) break;
    let lost = false;
    const onLost = () => (lost = true);
    view.canvas.addEventListener("webglcontextlost", onLost);
    try {
      await view.gl.makeXRCompatible();
    } finally {
      view.canvas.removeEventListener("webglcontextlost", onLost);
    }
    if (!lost && !view.gl.isContextLost() && view.canvas.isConnected && python.viewCanvasSelector() === view.selector) {
      return view;
    }
    console.info("Slicer XR: the 3D view's WebGL context was lost on the way to XR; waiting for the view to be made anew");
    lostCanvas = view.canvas;
  }
  throw new Error("The 3D view's WebGL context could not be made ready for XR");
}

// --------------------------------------------------------------------------------- the panel

/** The markups the panel places (slicer_xr.py MARKUPS). */
const COMPONENT_CONTROL_POINT = 1; // vtkMRMLMarkupsDisplayNode::ComponentControlPoint
const MARKUP_TOOLS = [
  ["vtkMRMLMarkupsFiducialNode", "Point"],
  ["vtkMRMLMarkupsLineNode", "Line"],
  ["vtkMRMLMarkupsAngleNode", "Angle"],
  ["vtkMRMLMarkupsCurveNode", "Curve"],
  ["vtkMRMLMarkupsClosedCurveNode", "Closed curve"],
  ["vtkMRMLMarkupsPlaneNode", "Plane"],
];
const PANEL_PX_PER_M = 3200; // the panel's layout: 3.2 pixels per millimetre (31 cm across)
// Where the panel is put, from the eyes, in the direction the viewer looks (metres: right, up, back):
// about 30 degrees to the right, a little below the eyes, out of the way of the scene in front
const PANEL_OFFSET = [0.43, -0.15, -0.74];
const PANEL_WIDTH_PX = 1000;
// A quad layer's pixels per pixel of the panel's layout: 1000 across the panel's 31 cm, about twice
// what the headset's display shows of it at its distance (more would be 6 MB more to send for each
// change of the panel, and shimmer: a layer's texture has no smaller copies to be shown from)
const PANEL_QUAD_PIXELS = 1;
const HOVER_PAD_PX = 4; // around a button, in the picture of it shown while it is pointed at
const EDGE_FEATHER_PX = 2.5; // the soft edge of the panel in the 3D view, in pixels of an eye
const BUTTON_RADIUS_PX = 16; // the panel's buttons' rounded corners
// The panel's categories: their buttons at its top, the chosen one's buttons under them
const CATEGORIES = [["data", "Data"], ["markups", "Markups"], ["clipping", "Clipping"], ["view", "View"]];
const DATA_ROWS_PER_PAGE = 7;
// The panel's last line: what the controllers do (the left one: as the category says)
const LEFT_HAND_HELP = {
  data: "Left stick: choose, page · trigger: show/hide · X: transparency · Y: clipping",
  markups: "Left X: undo point · Left Y: handles · Right stick: turn, zoom · A: reset · B: panel",
  clipping: "Left trigger: hold the plane · X: clipping on/off · Y: plane square to view · stick: shift",
  view: "Grip: move the scene (both hands: scale) · Thumbstick: turn, zoom · A/X: reset · B/Y: panel",
};
const DATA_ROW_PX = 52;
const PANEL_BACKGROUND = "#0f172a";

// The headset's resolution (of what it recommends) and the volume rendering's frame rate target
// (0: no target, every volume in full detail), as the panel's Rendering section sets them
const RESOLUTIONS = [[0.5, "Speed 50%"], [0.7, "Balanced 70%"], [1, "Quality 100%"]];
const FPS_TARGETS = [0, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 72, 80, 90];
const setting = (name, fallback) => {
  try {
    const value = Number(localStorage.getItem(`slicerxr.${name}`));
    return Number.isFinite(value) && localStorage.getItem(`slicerxr.${name}`) !== null ? value : fallback;
  } catch {
    return fallback;
  }
};
const keepSetting = (name, value) => {
  try {
    localStorage.setItem(`slicerxr.${name}`, String(value));
  } catch {}
};

/** The panel floating in the room: its picture (a 2D canvas, drawn here and shown by Slicer's
 *  renderer as a texture), its buttons, and where a ray from a controller meets it. */
class XRPanel {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d");
    this.exitLabel = "Exit VR";
    this.category = CATEGORIES[setting("panelCategory", 1)]?.[0] ?? "markups";
    this.dataItems = [];
    this.dataPage = 0;
    this.selectedItem = null; // the data tree's item chosen (its subject hierarchy ID): what clipping clips
    // The Clipping category (slicer_xr.py clippingState), and whether the plane follows the viewer
    this.clip = { enabled: false, planeShown: false, handlesShown: false, offset: 0, range: 1 };
    this.clipFollow = false;
    this.resolution = 0.7;
    this.fpsTarget = 0;
    this.renderStats = "";
    this.buttons = [];
    this.hover = null;
    this.status = "";
    this.activeTool = null;
    this.busy = false;
    this.visible = true;
    this.roomFromPanel = null; // placed in front of the viewer with the first frame
    this.dirty = true;
    this.layout();
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.dirty = true;
  }

  setHover(id) {
    if (id === this.hover) return;
    this.hover = id;
    // Where the panel is a layer, the button pointed at is a small layer of its own over it (the
    // panel's picture is large to send again); else it is drawn in the panel's picture
    if (!this.hoverAsLayer) this.dirty = true;
  }

  /** Where the picture of a button (with HOVER_PAD_PX around it) is in the panel's space (metres,
   *  facing +z): its centre, and its width and height. */
  rectInPanel(button) {
    const x = ((button.x + button.width / 2) / PANEL_WIDTH_PX - 0.5) * this.widthM;
    const y = (0.5 - (button.y + button.height / 2) / this.height) * this.heightM;
    return {
      center: M.translation(x, y, 0),
      size: [(button.width + 2 * HOVER_PAD_PX) / PANEL_PX_PER_M, (button.height + 2 * HOVER_PAD_PX) / PANEL_PX_PER_M],
    };
  }

  /** The size in pixels of the picture of a button pointed at. */
  static hoverPixels(button) {
    return [Math.round((button.width + 2 * HOVER_PAD_PX) * PANEL_QUAD_PIXELS), Math.round((button.height + 2 * HOVER_PAD_PX) * PANEL_QUAD_PIXELS)];
  }

  /**
   * What the small layer over a button pointed at shows: the button's shape, lighter - a clear
   * white over its fill, a bright edge - and nothing of the button itself. The button's label is
   * the panel's own, seen through it. (It was a picture of the button, label and all, and the
   * layer's picture and its place are not changed in the same instant by the headset: moving from
   * a button to its neighbour, one's label showed on the other for a moment.) One picture does for
   * every button of a size.
   */
  drawHoverCanvas(button) {
    const [width, height] = XRPanel.hoverPixels(button);
    const hoverCanvas = document.createElement("canvas");
    hoverCanvas.width = width;
    hoverCanvas.height = height;
    const canvas = this.canvas, context = this.context;
    this.canvas = hoverCanvas;
    this.context = hoverCanvas.getContext("2d");
    try {
      const c = this.context;
      c.setTransform(PANEL_QUAD_PIXELS, 0, 0, PANEL_QUAD_PIXELS, 0, 0);
      this.roundRect(HOVER_PAD_PX, HOVER_PAD_PX, button.width, button.height, BUTTON_RADIUS_PX);
      c.fillStyle = "rgba(255, 255, 255, 0.2)";
      c.fill();
      c.strokeStyle = "rgba(255, 255, 255, 0.95)";
      c.lineWidth = 4;
      c.stroke();
    } finally {
      this.canvas = canvas;
      this.context = context;
    }
    return hoverCanvas;
  }

  setBusy(busy) {
    this.busy = busy;
    this.dirty = true;
  }

  setActiveTool(className) {
    this.activeTool = className;
    this.dirty = true;
  }

  /** The buttons in rows of three, under headings, and the panel's height to fit them. */
  /**
   * The buttons: at the top, always, the Exit and close buttons and the categories (Data, Markups,
   * View); under them the buttons of the category chosen. The panel is as tall as its tallest
   * category, so that it keeps its size as the category changes.
   */
  layout() {
    let height = 0;
    for (const category of CATEGORIES.map(([id]) => id)) height = Math.max(height, this.layoutOf(category).height);
    const { buttons } = this.layoutOf(this.category);
    this.buttons = buttons;
    this.height = height;
    this.dirty = true;
  }

  layoutOf(category) {
    const margin = 30, gap = 16, columns = 3;
    const width = (PANEL_WIDTH_PX - 2 * margin - (columns - 1) * gap) / columns;
    const categoryWidth = (PANEL_WIDTH_PX - 2 * margin - (CATEGORIES.length - 1) * gap) / CATEGORIES.length;
    const buttons = [
      // In the title's row, at the right: Exit, and close (an icon)
      { id: "hide", icon: "close", x: PANEL_WIDTH_PX - margin - 64, y: 22, width: 64, height: 64 },
      { id: "exit", label: this.exitLabel, exit: true, x: PANEL_WIDTH_PX - margin - 64 - gap - 170, y: 22, width: 170, height: 64 },
      // The categories
      ...CATEGORIES.map(([id, label], i) => ({ id: `category:${id}`, label, category: id, x: margin + i * (categoryWidth + gap), y: 136, width: categoryWidth, height: 72 })),
    ];
    let y = 136 + 72 + 34;
    const section = (title, items, rowHeight) => {
      if (title) {
        buttons.push({ heading: title, y });
        y += 44;
      }
      let column = 0;
      items.forEach((item, i) => {
        // An item may take the whole row (a slider)
        const span = item.span ?? 1;
        if (i && (column + span > columns || column === 0)) {
          y += rowHeight + gap;
          column = 0;
        }
        buttons.push({ ...item, x: margin + column * (width + gap), y, width: span * width + (span - 1) * gap, height: rowHeight });
        column = (column + span) % columns;
      });
      y += rowHeight + 30;
    };
    if (category === "data") {
      // The data tree, a row an item: its name (indented by its depth; pressed, the item is chosen:
      // what clipping clips), and the icons to show or hide it, to make it half transparent and,
      // while clipping is on, to clip it or not
      // (a page that starts within a branch has the items it is in above, as the first rows)
      const rows = this.pageRows(this.dataPage).map((index) => this.dataItems[index]);
      const icon = 64, full = PANEL_WIDTH_PX - 2 * margin;
      const icons = this.clip.enabled ? 3 : 2;
      const column = (k) => margin + full - (icons - k) * icon - (icons - 1 - k) * gap; // k-th icon from the left
      if (!rows.length) buttons.push({ id: "nodata", treeRow: { name: "No data: it is loaded on the page", depth: 0, kind: "" }, x: margin, y, width: full, height: DATA_ROW_PX, disabled: true });
      rows.forEach((item, i) => {
        const rowY = y + i * (DATA_ROW_PX + 8);
        buttons.push({ id: `row:${item.id}`, treeRow: item, selected: item.id === this.selectedItem, x: margin, y: rowY, width: full - icons * (icon + gap), height: DATA_ROW_PX });
        buttons.push({ id: `eye:${item.id}`, icon: item.visible ? "eye" : "eye-off", treeItem: item, x: column(0), y: rowY, width: icon, height: DATA_ROW_PX });
        if (item.opacity) {
          buttons.push({ id: `opacity:${item.id}`, icon: "opacity", treeItem: item, on: item.transparent, x: column(1), y: rowY, width: icon, height: DATA_ROW_PX });
        }
        if (this.clip.enabled && item.clippable) {
          buttons.push({ id: `clip:${item.id}`, icon: "clip", treeItem: item, on: item.clipped, x: column(2), y: rowY, width: icon, height: DATA_ROW_PX });
        }
      });
      y += DATA_ROWS_PER_PAGE * (DATA_ROW_PX + 8) + 22;
      // (the pages' buttons only where there is more than one; the space is kept either way)
      if (this.dataPages > 1) section("", [
        { id: "data-previous", label: "◀  Previous", disabled: this.dataPage === 0 },
        { id: "data-page", label: `Page ${this.dataPage + 1} of ${this.dataPages}`, disabled: true, plain: true },
        { id: "data-next", label: "Next  ▶", disabled: this.dataPage >= this.dataPages - 1 },
      ], 64);
      else y += 64 + 30;
    } else if (category === "markups") {
      section("", [
        ...MARKUP_TOOLS.map(([className, label]) => ({ id: `tool:${className}`, label, tool: className })),
        { id: "done", label: "Done" },
        { id: "undo", label: "Undo point" },
        { id: "delete", label: "Delete markups" },
        { id: "handles", label: "Handles", toggle: true },
      ], 72);
    } else if (category === "clipping") {
      // A plane that clips the item chosen in the Data category (else the first one)
      section("", [
        { id: "clip-enable", label: "Clipping", on: this.clip.enabled },
        { id: "clip-follow", label: "Follow view", on: this.clipFollow, disabled: !this.clip.enabled },
        { id: "clip-plane", label: "Show plane", on: this.clip.planeShown, disabled: !this.clip.enabled },
        { id: "clip-handles", label: "Handles", on: this.clip.handlesShown, disabled: !this.clip.enabled },
      ], 72);
      section("Plane position", [{ id: "clip-offset", slider: true, span: 3, disabled: !this.clip.enabled }], 72);
    } else {
      section("Position", [{ id: "reset", label: "Reset position" }], 72);
      section("Resolution", RESOLUTIONS.map(([scale, label]) => ({ id: `resolution:${scale}`, label, resolution: scale })), 72);
      section("Volume rendering", [{ id: "fps", slider: true, span: 3 }], 72);
    }
    return { buttons, height: y + 44 };
  }

  get dataPages() {
    return this.dataPageTable().length;
  }

  /**
   * The pages of the data tree: of each, the items it lists (indices into dataItems), and before
   * them the items its first one is in - its parent, theirs, up to the top - so that a page that
   * starts within a branch says what branch that is. Those take rows too: a page has
   * DATA_ROWS_PER_PAGE rows in all, and at least one item of its own.
   */
  dataPageTable() {
    if (this.pagesKey === this.dataKey && this.pages) return this.pages;
    const items = this.dataItems;
    const pages = [];
    for (let index = 0; index < items.length;) {
      const parents = [];
      for (let i = index - 1, depth = items[index].depth; i >= 0 && depth > 0; i--) {
        if (items[i].depth < depth) {
          parents.unshift(i);
          depth = items[i].depth;
        }
      }
      const above = parents.slice(Math.max(0, parents.length - (DATA_ROWS_PER_PAGE - 1)));
      const own = [];
      while (index < items.length && above.length + own.length < DATA_ROWS_PER_PAGE) own.push(index++);
      pages.push({ above, own });
    }
    if (!pages.length) pages.push({ above: [], own: [] });
    this.pages = pages;
    this.pagesKey = this.dataKey;
    return pages;
  }

  /** The rows of a page: the items its first one is in, then its own. */
  pageRows(page) {
    const { above, own } = this.dataPageTable()[page] ?? { above: [], own: [] };
    return [...above, ...own];
  }

  /** The data tree the Data category shows (slicer_xr.py dataItems); drawn again when it changed. */
  setDataItems(items) {
    const key = JSON.stringify(items);
    if (key === this.dataKey) return;
    this.dataKey = key;
    this.dataItems = items;
    this.dataPage = Math.min(this.dataPage, this.dataPages - 1);
    if (this.category === "data") this.layout();
  }

  /** What the Clipping category shows; laid out again when it changed. */
  setClipState(clip) {
    const key = JSON.stringify(clip);
    if (key === this.clipKey) return;
    const relayout = clip.enabled !== this.clip.enabled || this.category === "clipping";
    this.clipKey = key;
    this.clip = clip;
    if (relayout) this.layout();
  }

  selectItem(id) {
    this.selectedItem = id === this.selectedItem ? null : id;
    if (this.category === "data") this.layout();
  }

  setCategory(category) {
    if (category === this.category) return;
    this.category = category;
    keepSetting("panelCategory", CATEGORIES.findIndex(([id]) => id === category));
    this.layout();
  }

  /** The width of the panel's layout, in its pixels (buttons are placed in them). */
  get layoutWidth() {
    return PANEL_WIDTH_PX;
  }

  get widthM() {
    return PANEL_WIDTH_PX / PANEL_PX_PER_M;
  }

  get heightM() {
    return this.height / PANEL_PX_PER_M;
  }

  enabled(button) {
    if (button.disabled || button.blank) return false;
    if (this.busy && button.treeItem) return false;
    return true;
  }

  /** The picture, as RGBA rows from the bottom up (as a VTK image is). */
  draw({ scale = 1, readBack = true } = {}) {
    const canvas = this.canvas, c = this.context;
    canvas.width = Math.round(PANEL_WIDTH_PX * scale);
    canvas.height = Math.round(this.height * scale);
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.fillStyle = PANEL_BACKGROUND;
    c.fillRect(0, 0, PANEL_WIDTH_PX, this.height);
    c.strokeStyle = "#334155";
    c.lineWidth = 6;
    c.strokeRect(3, 3, PANEL_WIDTH_PX - 6, this.height - 6);
    c.textBaseline = "middle";
    c.fillStyle = "#f8fafc";
    c.font = "700 46px system-ui, sans-serif";
    c.fillText("3D Slicer XR", 30, 52);
    c.fillStyle = this.busy ? "#fbbf24" : "#93c5fd";
    c.font = "500 27px system-ui, sans-serif";
    this.fitText(this.status || "Point with a controller, pull the trigger to press", 30, 108, PANEL_WIDTH_PX - 60);
    for (const button of this.buttons) {
      if (button.heading) {
        c.fillStyle = "#94a3b8";
        c.font = "600 26px system-ui, sans-serif";
        c.fillText(button.heading.toUpperCase(), 30, button.y + 18);
        continue;
      }
      if (button.blank) continue;
      if (button.plain) {
        c.fillStyle = "#94a3b8";
        c.font = "500 26px system-ui, sans-serif";
        c.textAlign = "center";
        c.fillText(button.label, button.x + button.width / 2, button.y + button.height / 2);
        c.textAlign = "start";
        continue;
      }
      const hovered = button.id === this.hover && !this.hoverAsLayer;
      if (button.treeRow) {
        this.drawTreeRow(button);
        continue;
      }
      if (button.slider) this.drawSlider(button, hovered);
      else this.drawButton(button, hovered);
    }
    c.fillStyle = "#64748b";
    c.font = "400 22px system-ui, sans-serif";
    this.fitText(LEFT_HAND_HELP[this.category] ?? LEFT_HAND_HELP.view, 30, this.height - 30, PANEL_WIDTH_PX - 60);

    if (!readBack) return null;
    const rows = c.getImageData(0, 0, canvas.width, canvas.height).data;
    const flipped = new Uint8Array(rows.length);
    const stride = canvas.width * 4;
    for (let y = 0; y < canvas.height; y++) flipped.set(rows.subarray(y * stride, (y + 1) * stride), (canvas.height - 1 - y) * stride);
    this.dirty = false;
    return { pixels: flipped, width: canvas.width, height: canvas.height };
  }

  /** A row of the data tree: the item's name, indented by its depth, and what it is. */
  drawTreeRow(button) {
    const c = this.context, item = button.treeRow;
    const x = button.x + 12 + item.depth * 30;
    if (button.selected) {
      c.fillStyle = "#1e3a8a";
      this.roundRect(button.x, button.y, button.width, button.height, BUTTON_RADIUS_PX);
      c.fill();
      c.strokeStyle = "#93c5fd";
      c.lineWidth = 2;
      c.stroke();
    }
    if (item.depth) {
      // A corner from the parent's row
      c.strokeStyle = "#475569";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x - 18, button.y + 4);
      c.lineTo(x - 18, button.y + button.height / 2);
      c.lineTo(x - 6, button.y + button.height / 2);
      c.stroke();
    }
    c.fillStyle = item.visible === false ? "#94a3b8" : "#f1f5f9";
    c.font = "600 27px system-ui, sans-serif";
    const kindWidth = item.kind ? 150 : 0;
    this.fitText(item.name, x, button.y + button.height / 2, button.x + button.width - x - kindWidth - 12);
    if (item.kind) {
      c.fillStyle = "#64748b";
      c.font = "400 21px system-ui, sans-serif";
      c.textAlign = "right";
      c.fillText(item.kind, button.x + button.width - 8, button.y + button.height / 2);
      c.textAlign = "start";
    }
  }

  /** The icons of the panel's buttons, white, in the middle of the button. */
  drawIcon(button) {
    const c = this.context;
    const cx = button.x + button.width / 2, cy = button.y + button.height / 2;
    c.strokeStyle = c.fillStyle = "#ffffff";
    c.lineWidth = 4;
    c.lineCap = "round";
    if (button.icon === "close") {
      const r = button.width * 0.2;
      c.beginPath();
      c.moveTo(cx - r, cy - r);
      c.lineTo(cx + r, cy + r);
      c.moveTo(cx + r, cy - r);
      c.lineTo(cx - r, cy + r);
      c.stroke();
    } else if (button.icon === "eye" || button.icon === "eye-off") {
      const w = 17, h = 10;
      c.beginPath();
      c.moveTo(cx - w, cy);
      c.quadraticCurveTo(cx, cy - 2 * h, cx + w, cy);
      c.quadraticCurveTo(cx, cy + 2 * h, cx - w, cy);
      c.closePath();
      c.lineWidth = 3;
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, 5, 0, 2 * Math.PI);
      c.fill();
      if (button.icon === "eye-off") {
        c.lineWidth = 4;
        c.strokeStyle = "#1d4ed8";
        c.beginPath();
        c.moveTo(cx - w, cy - 13);
        c.lineTo(cx + w, cy + 13);
        c.stroke();
        c.strokeStyle = "#ffffff";
        c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(cx - w, cy - 13);
        c.lineTo(cx + w, cy + 13);
        c.stroke();
      }
    } else if (button.icon === "clip") {
      // A square, cut by a diagonal: the part beyond it left out
      const r = 13;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(cx + r, cy - r);
      c.lineTo(cx - r, cy - r);
      c.lineTo(cx - r, cy + r);
      c.lineTo(cx + r, cy + r);
      c.closePath();
      c.globalAlpha = 0.35;
      c.stroke();
      c.globalAlpha = 1;
      c.beginPath();
      c.moveTo(cx - r, cy - r);
      c.lineTo(cx - r, cy + r);
      c.lineTo(cx + r, cy + r);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(cx - r - 5, cy - r - 5);
      c.lineTo(cx + r + 5, cy + r + 5);
      c.stroke();
    } else if (button.icon === "opacity") {
      // A circle, its left half filled: half transparent
      const r = 13;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(cx, cy, r, 0, 2 * Math.PI);
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, r, Math.PI / 2, (3 * Math.PI) / 2);
      c.closePath();
      c.fill();
    }
  }

  /** A button: lighter, with a bright edge, while it is pointed at. */
  drawButton(button, hovered) {
    const c = this.context;
    const enabled = this.enabled(button);
    const active = (button.tool && button.tool === this.activeTool) || (button.toggle && this.handlesOn) ||
      (button.resolution && button.resolution === this.resolution) || (button.category && button.category === this.category) || button.on;
    c.fillStyle = !enabled ? "#1e293b"
      : active ? (hovered ? "#8b5cf6" : "#7c3aed")
        : button.exit ? (hovered ? "#ef4444" : "#b91c1c")
          : hovered ? "#3b82f6" : "#1d4ed8";
    this.roundRect(button.x, button.y, button.width, button.height, BUTTON_RADIUS_PX);
    c.fill();
    if (button.icon) {
      this.drawIcon(button);
      this.roundRect(button.x, button.y, button.width, button.height, BUTTON_RADIUS_PX);
    }
    if (active || hovered) {
      c.strokeStyle = hovered ? "#ffffff" : "#e0e7ff";
      c.lineWidth = 4;
      c.stroke();
    }
    if (button.icon) return;
    c.fillStyle = enabled ? "#ffffff" : "#64748b";
    c.font = "600 30px system-ui, sans-serif";
    if (button.category || button.exit) {
      c.textAlign = "center";
      this.fitText(button.label, button.x + button.width / 2, button.y + button.height / 2, button.width - 24);
      c.textAlign = "start";
    } else if (button.detail) {
      this.fitText(button.label, button.x + 18, button.y + 32, button.width - 36);
      c.fillStyle = enabled ? "#bfdbfe" : "#64748b";
      c.font = "400 21px system-ui, sans-serif";
      this.fitText(button.detail, button.x + 18, button.y + 66, button.width - 36);
    } else {
      this.fitText(button.label, button.x + 18, button.y + button.height / 2, button.width - 36);
    }
  }

  /** The frame rate slider: its label, what it does now, its track and knob. */
  drawSlider(button, sliderHovered) {
    const c = this.context;
    let fraction, label, detail;
    if (button.id === "clip-offset") {
      const range = this.clip.range || 1;
      fraction = Math.min(1, Math.max(0, (this.clip.offset / range + 1) / 2));
      const mm = Math.round(this.clip.offset) || 0; // (not "-0")
      label = this.clip.enabled ? `Shift: ${mm > 0 ? "+" : ""}${mm} mm` : "Shift: turn clipping on first";
      detail = this.clip.enabled ? "along the plane's normal" : "";
    } else {
      fraction = Math.max(0, FPS_TARGETS.indexOf(this.fpsTarget)) / (FPS_TARGETS.length - 1);
      label = this.fpsTarget ? `Frame rate target: ${this.fpsTarget} fps` : "Frame rate target: none (full detail)";
      detail = this.renderStats;
    }
    if (button.disabled) sliderHovered = false;
    c.fillStyle = button.disabled ? "#64748b" : "#e2e8f0";
    c.font = "600 26px system-ui, sans-serif";
    c.textBaseline = "middle";
    c.fillText(label, button.x, button.y + 16);
    c.fillStyle = "#93c5fd";
    c.font = "400 22px system-ui, sans-serif";
    c.textAlign = "right";
    c.fillText(detail, button.x + button.width, button.y + 16);
    c.textAlign = "start";
    const trackY = button.y + 52, left = button.x + 14, right = button.x + button.width - 14;
    c.lineCap = "round";
    c.lineWidth = 12;
    c.strokeStyle = "#334155";
    c.beginPath();
    c.moveTo(left, trackY);
    c.lineTo(right, trackY);
    c.stroke();
    const knobX = left + fraction * (right - left);
    c.strokeStyle = sliderHovered ? "#3b82f6" : "#1d4ed8";
    c.beginPath();
    c.moveTo(left, trackY);
    c.lineTo(knobX, trackY);
    c.stroke();
    c.beginPath();
    c.arc(knobX, trackY, 15, 0, 2 * Math.PI);
    c.fillStyle = sliderHovered ? "#ffffff" : "#e0e7ff";
    c.fill();
  }

  /** The frame rate target at a fraction of the slider's width. */
  static fpsAt(fraction) {
    const index = Math.round(Math.min(1, Math.max(0, fraction)) * (FPS_TARGETS.length - 1));
    return FPS_TARGETS[index];
  }

  setFpsTarget(fps) {
    if (fps === this.fpsTarget) return false;
    this.fpsTarget = fps;
    this.dirty = true;
    return true;
  }

  setRenderStats(text) {
    if (text === this.renderStats) return;
    this.renderStats = text;
    this.dirty = true;
  }

  /** The picture, drawn at a quad layer's width in pixels. */
  drawQuadCanvas(pixelWidth) {
    const scale = pixelWidth / PANEL_WIDTH_PX;
    this.quadCanvas ??= document.createElement("canvas");
    this.quadCanvas.width = Math.round(PANEL_WIDTH_PX * scale);
    this.quadCanvas.height = Math.round(this.height * scale);
    const canvas = this.canvas, context = this.context;
    // draw() draws into this.canvas and this.context: pointed at the larger canvas, scaled
    this.canvas = this.quadCanvas;
    this.context = this.quadCanvas.getContext("2d");
    try {
      this.draw({ scale, readBack: false });
    } finally {
      this.canvas = canvas;
      this.context = context;
    }
    return this.quadCanvas;
  }

  fitText(text, x, y, maxWidth) {
    const c = this.context;
    let shown = text;
    while (shown.length > 1 && c.measureText(shown).width > maxWidth) shown = shown.slice(0, -2) + "…";
    c.fillText(shown, x, y);
  }

  roundRect(x, y, w, h, r) {
    const c = this.context;
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Off to the right of where the viewer looks (yaw only), a little below the eyes, turned to face them. */
  placeInFront(head) {
    const eye = [head[12], head[13], head[14]];
    const forward = M.vector(head, [0, 0, -1]);
    const yaw = Math.atan2(-forward[0], -forward[2]); // 0 when looking along -z
    const offset = M.vector(M.yaw(yaw), PANEL_OFFSET);
    const position = eye.map((v, i) => v + offset[i]);
    // Turned to face the eye: its +z towards it
    const towards = sub(eye, position);
    const facing = Math.atan2(towards[0], towards[2]);
    this.roomFromPanel = M.multiply(M.translation(...position), M.yaw(facing));
    this.moved = true;
  }

  /** Where a ray (a pose whose -z is its direction) meets the panel: its distance and the button
   *  there, or null. */
  hit(rayPose) {
    if (!this.visible || !this.roomFromPanel || !rayPose) return null;
    const panelFromRoom = M.invert(this.roomFromPanel);
    const origin = M.point(panelFromRoom, [rayPose[12], rayPose[13], rayPose[14]]);
    const direction = M.vector(panelFromRoom, M.vector(rayPose, [0, 0, -1]));
    if (Math.abs(direction[2]) < 1e-6) return null;
    const t = -origin[2] / direction[2];
    if (t <= 0 || t > 5) return null;
    const x = origin[0] + t * direction[0], y = origin[1] + t * direction[1];
    if (Math.abs(x) > this.widthM / 2 || Math.abs(y) > this.heightM / 2) return null;
    const px = (x / this.widthM + 0.5) * PANEL_WIDTH_PX, py = (0.5 - y / this.heightM) * this.height;
    // (a slider a little beyond its ends too: its ends are its first and last values)
    const button = this.buttons.find((b) => {
      const pad = b.slider ? 24 : 0;
      return !b.heading && px >= b.x - pad && px < b.x + b.width + pad && py >= b.y && py < b.y + b.height && this.enabled(b);
    });
    return { t, button: button ?? null, px, py };
  }
}

// --------------------------------------------------------------------------------- the session

class XRSessionView {
  constructor(app, python, mode, resolutionScale, ui) {
    this.app = app;
    this.python = python;
    this.mode = mode;
    this.resolutionScale = resolutionScale;
    this.ui = ui;
    // XRInputSource -> { pressed (holding the scene), grip, ray (poses), hit (on the panel), select }
    this.inputs = new Map();
    this.grab = null;
    this.panel = new XRPanel();
    this.panel.resolution = resolutionScale;
    this.panel.fpsTarget = setting("fpsTarget", 0);
    this.volumeQuality = { level: 0 };
    this.panel.exitLabel = mode === "immersive-ar" ? "Exit AR" : "Exit VR";
    this.pythonBusy = false; // Python is reading a scene: no frames are drawn until it is done
  }

  /** The session is asked for first, while the click that asked for it still counts; the 3D view
   *  is made ready for it, and taken, after that. */
  async start() {
    const session = await navigator.xr.requestSession(this.mode, {
      requiredFeatures: ["local-floor"],
      optionalFeatures: ["hand-tracking", "layers"],
    });
    this.session = session;
    console.info(`Slicer XR: ${this.mode} session started`);
    session.addEventListener("end", () => this.stopped());
    try {
      this.space = await session.requestReferenceSpace("local-floor");
      await this.attachView();

      session.addEventListener("selectstart", (e) => this.selectStart(e.inputSource));
      session.addEventListener("selectend", (e) => this.selectEnd(e.inputSource));
      session.addEventListener("squeezestart", (e) => this.hold(e.inputSource, +1));
      session.addEventListener("squeezeend", (e) => this.hold(e.inputSource, -1));
      session.addEventListener("inputsourceschange", (e) => e.removed.forEach((source) => this.inputs.delete(source)));

      await this.showVolumeIfAlone();
      this.resetPlacement();
      this.lastTime = null;
      session.requestAnimationFrame((time, frame) => this.onFrame(time, frame));
    } catch (error) {
      try {
        this.python.stop();
      } catch {}
      session.end().catch(() => {});
      throw error;
    }
  }

  /** Takes the 3D view - its context made XR compatible first - and gives the session a layer of
   *  that context to draw into. */
  async attachView() {
    const view = await makeViewXRCompatible(this.python);
    const result = this.python.start(this.mode === "immersive-ar");
    const info = result.toJs({ dict_converter: Object.fromEntries });
    result.destroy();
    if (this.bounds === undefined) this.bounds = info.bounds; // placed once; a view made anew keeps it
    this.gl = view.gl;
    this.redirect = redirectDefaultFramebuffer(view.gl);
    this.layer = new XRWebGLLayer(this.session, view.gl, {
      antialias: false, // a copy cannot go into a multisampled framebuffer
      depth: false,
      alpha: true, // where the panel is, the 3D view is clear (the panel's layer is under it)
      framebufferScaleFactor: this.resolutionScale,
    });
    this.binding = null;
    this.quad = null;
    if (this.session.enabledFeatures?.includes?.("layers") && typeof XRWebGLBinding !== "undefined") {
      try {
        this.binding = new XRWebGLBinding(this.session, view.gl);
      } catch (error) {
        console.warn("Slicer XR: no layers; the panel is drawn in the scene", error);
      }
    }
    this.updateLayers();
    this.session.updateRenderState({ depthNear: NEAR_M, depthFar: FAR_M });
    this.panel.dirty = true; // the view's new panel is given its picture
    this.firstFrameDrawn = false;
    console.info(`Slicer XR: drawing the 3D view of ${view.selector} (${info.shared ? "shared canvas" : "its own canvas"}), layer ${this.layer.framebufferWidth}x${this.layer.framebufferHeight}`);
  }

  /** The view's context was lost during the session: once SlicerWeb has made the view anew, the
   *  session goes on with that one (the headset shows the last frame meanwhile). */
  async recover() {
    if (this.recovering || this.done) return;
    this.recovering = true;
    console.info("Slicer XR: the 3D view was lost; taking the one made in its place");
    try {
      this.redirect?.end();
      try {
        this.python.stop();
      } catch {}
      await this.attachView();
    } catch (error) {
      console.error("Slicer XR: the 3D view could not be taken again", error);
      this.ui.showError(error);
      this.end();
    } finally {
      this.recovering = false;
    }
  }

  end() {
    this.session?.end().catch(() => {});
  }

  stopped() {
    if (this.done) return;
    this.done = true;
    console.info(`Slicer XR: session ended after ${this.framesDrawn ?? 0} frames`);
    this.redirect?.end();
    try {
      this.python.stop();
    } catch (error) {
      console.error("Slicer XR: the 3D view could not be given back", error);
    }
    this.ui.sessionEnded(this);
  }

  /** The scene at real size (or fit to about 60 cm when that would be too large or too small),
   *  its centre 1.1 m above the floor and 60 cm in front, the patient facing the viewer. */
  resetPlacement() {
    const b = this.bounds || [-100, 100, -100, 100, -100, 100];
    const center = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2];
    const size = Math.max(b[1] - b[0], b[3] - b[2], b[5] - b[4], 1e-3);
    let mmPerMetre = 1000;
    if (size / mmPerMetre > 1.5 || size / mmPerMetre < 0.05) mmPerMetre = size / 0.6;
    // Room from RAS: R to the viewer's left (-x), A towards the viewer (+z), S up (+y)
    const roomFromRAS = new Float64Array([-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    const roomFromWorld = M.multiply(
      M.multiply(M.translation(0, 1.1, -0.6), roomFromRAS),
      M.multiply(M.scaling(1 / mmPerMetre), M.translation(-center[0], -center[1], -center[2])),
    );
    this.worldFromRoom = M.invert(roomFromWorld);
    this.sceneCenter = center;
    this.grab = null;
  }

  input(source) {
    let input = this.inputs.get(source);
    if (!input) {
      input = { pressed: 0, grip: null, ray: null, hit: null, select: null, hover: [], drag: null };
      this.inputs.set(source, input);
    }
    return input;
  }

  /** Whether the trigger of this controller holds the clipping plane: the left one, in the
   *  Clipping category while clipping is on. */
  holdsClipPlane(source, input) {
    return source.handedness === "left" && this.panel.category === "clipping" && this.panel.clip.enabled && !!input.grip;
  }

  /** The clipping plane held: it moves and turns with the hand until let go. */
  clipGrabStart(input) {
    const panel = this.panel;
    input.select = "clip";
    input.clipGrab = true;
    if (panel.clipFollow) {
      panel.clipFollow = false; // (it would turn it back)
      panel.layout();
    }
    panel.setStatus(this.python.clipGrabStart(this.handInScene(input)));
  }

  clipGrabEnd(input) {
    input.clipGrab = false;
    this.panel.setStatus(this.python.clipGrabEnd());
    this.refreshClipState(true);
  }

  /** A hand's pose in the scene, row by row (as Python takes a matrix). */
  handInScene(input) {
    return M.rowMajor(M.multiply(this.worldFromRoom, input.grip));
  }

  /** The grip or squeeze holds the scene (and so does the trigger, away from the panel and when
   *  no markup is being placed). */
  hold(source, delta) {
    const input = this.input(source);
    input.pressed = Math.max(0, input.pressed + delta);
    this.grab = null; // started again with the hands that hold it now
  }

  /** The trigger (or a pinch): presses the button it points at, else places a markup's point at
   *  the controller's tip when a markup is being placed, else holds the scene. */
  selectStart(source) {
    const input = this.input(source);
    if (input.hit?.button?.slider && this.panel.enabled(input.hit.button)) {
      // The slider follows the ray while the trigger is held
      input.select = "slider";
      input.slider = input.hit.button;
      this.slideTo(input);
    } else if (input.hit) {
      input.select = "panel";
      if (input.hit.button) this.press(input.hit.button);
    } else if (input.hover?.length === 3 && input.hover[1] === COMPONENT_CONTROL_POINT && input.grip) {
      // In a control point: it is dragged, keeping where it is from the tip (it does not jump to it)
      const [nodeID, , index] = input.hover;
      const point = this.python.pointPosition(nodeID, index)?.toJs?.() ?? [];
      if (point.length === 3) {
        const tip = this.tipOf(input);
        input.select = "drag";
        input.drag = { nodeID, type: COMPONENT_CONTROL_POINT, index, offset: point.map((v, i) => v - tip[i]) };
        this.panel.setStatus(`Moving ${this.python.describePoint(nodeID, index)}`);
      }
    } else if (input.hover?.length === 3 && input.grip) {
      // In an interaction handle: it moves, turns or resizes the markup as the tip moves
      const [nodeID, type, index] = input.hover;
      input.select = "handle";
      input.drag = { nodeID, type, index };
      this.panel.setStatus(this.python.handleDragStart(nodeID, type, index, ...this.tipOf(input)));
    } else if (this.holdsClipPlane(source, input)) {
      this.clipGrabStart(input);
    } else if (source.handedness === "left" && this.panel.category === "data") {
      input.select = "data";
      this.chosenItemVisibility();
    } else if (this.panel.activeTool && input.grip) {
      input.select = "place";
      this.placePoint(input);
    } else {
      input.select = "hold";
      this.hold(source, +1);
    }
  }

  selectEnd(source) {
    const input = this.input(source);
    input.slider = null;
    if (input.select === "hold") this.hold(source, -1);
    if (input.select === "clip" && input.clipGrab) this.clipGrabEnd(input);
    if (input.select === "drag" && input.drag) {
      this.panel.setStatus(`Moved ${this.python.describePoint(input.drag.nodeID, input.drag.index)}`);
      input.drag = null;
    }
    if (input.select === "handle" && input.drag) {
      this.panel.setStatus(this.python.handleDragEnd());
      input.drag = null;
    }
    input.select = null;
  }

  /** The frame rate target where the ray is across the slider (above or below it too). */
  slideTo(input) {
    if (!input.slider || !input.hit) return;
    const slider = input.slider;
    const fraction = (input.hit.px - (slider.x + 14)) / (slider.width - 28);
    if (slider.id === "clip-offset") {
      // The clipping plane, from half the size of what it clips on one side to the other
      const clip = this.panel.clip;
      const offset = (2 * Math.min(1, Math.max(0, fraction)) - 1) * clip.range;
      if (Math.abs(offset - clip.offset) < clip.range / 500) return;
      this.python.setClipOffset(offset);
      this.panel.setClipState({ ...clip, offset });
      this.panel.dirty = true;
      return;
    }
    if (this.panel.setFpsTarget(XRPanel.fpsAt(fraction))) {
      keepSetting("fpsTarget", this.panel.fpsTarget);
      this.volumeQuality.goodSeconds = 0;
      if (!this.panel.fpsTarget) this.setVolumeLevel(0);
    }
  }

  /** The headset's resolution: a new layer for the 3D view, from the next frame on. */
  setResolution(scale) {
    if (scale === this.resolutionScale) return;
    this.resolutionScale = scale;
    this.panel.resolution = scale;
    this.panel.dirty = true;
    keepSetting("resolution", scale);
    this.layer = new XRWebGLLayer(this.session, this.gl, {
      antialias: false,
      depth: false,
      alpha: true,
      framebufferScaleFactor: scale,
    });
    this.updateLayers();
    this.resolutionChanged = true;
    console.info(`Slicer XR: resolution ${Math.round(scale * 100)}%, layer ${this.layer.framebufferWidth}x${this.layer.framebufferHeight}`);
  }

  /**
   * Volume rendering kept at the frame rate target: every second, when the frames came slower than
   * the target, the volumes are drawn coarser (rays for fewer pixels, longer steps along them); when
   * they came well faster for two seconds, finer again. Only while a volume is shown.
   */
  adaptVolumeQuality(now) {
    const q = this.volumeQuality;
    if (q.since === undefined) {
      Object.assign(q, { since: now, frames: this.framesDrawn ?? 0 });
      return;
    }
    if (now - q.since < 1000) return;
    const fps = (((this.framesDrawn ?? 0) - q.frames) * 1000) / (now - q.since);
    Object.assign(q, { since: now, frames: this.framesDrawn ?? 0, fps });
    const target = this.panel.fpsTarget;
    const shown = this.python.volumesShown();
    if (target && shown) {
      if (fps < target * 0.92 && q.level < VOLUME_LEVELS.length - 1) {
        this.setVolumeLevel(q.level + 1);
        q.goodSeconds = 0;
      } else if (fps > target * 1.12 && q.level > 0) {
        q.goodSeconds = (q.goodSeconds ?? 0) + 1;
        if (q.goodSeconds >= 2) {
          this.setVolumeLevel(q.level - 1);
          q.goodSeconds = 0;
        }
      } else {
        q.goodSeconds = 0;
      }
    }
    // Next to the slider while there is a target: the frame rate and how coarse the volumes are.
    // Not every second - each change sends the panel's whole picture to the headset again - but
    // when the coarseness changes, or the frame rate by 5 or more (at most every 5 seconds)
    if (!target) {
      this.panel.setRenderStats("");
      return;
    }
    const [rays, steps] = VOLUME_LEVELS[q.level];
    const changed = q.shownLevel !== q.level || q.shownFps === undefined ||
      (Math.abs(fps - q.shownFps) >= 5 && now - (q.shownAt ?? 0) >= 5000);
    if (!changed) return;
    Object.assign(q, { shownLevel: q.level, shownFps: fps, shownAt: now });
    this.panel.setRenderStats(`now ${Math.round(fps)} fps` + (shown ? ` · rays 1 per ${rays}×${rays} px · steps ×${steps}` : ""));
  }

  setVolumeLevel(level) {
    this.volumeQuality.level = level;
    const [rays, steps] = VOLUME_LEVELS[level];
    this.python.setVolumeQuality(rays, steps);
  }

  /** The tip of the controller's cone (slicer_xr.py), in Slicer's coordinates. */
  tipOf(input) {
    return M.point(M.multiply(this.worldFromRoom, input.grip), [0, 0, -0.075]);
  }

  /** A point at the tip of the controller. */
  placePoint(input) {
    this.panel.setStatus(this.python.placePoint(...this.tipOf(input), M.scaleOf(this.worldFromRoom)));
  }

  /** The control points being dragged follow the tips; then what each tip is in is highlighted. */
  updateControlPoints(shown) {
    for (const input of this.inputs.values()) {
      if (!input.drag || !input.grip) continue;
      const tip = this.tipOf(input);
      if (input.select === "drag") {
        const { nodeID, index, offset } = input.drag;
        const status = this.python.moveControlPoint(nodeID, index, ...tip.map((v, i) => v + offset[i]));
        if (status) this.panel.setStatus(`Moving ${status}`);
      } else if (input.select === "handle") {
        const status = this.python.handleDragMove(...tip);
        if (status) this.panel.setStatus(status);
      }
    }
    // A tip on the panel is not in a control point (the trigger presses the button)
    const tips = shown.map((input) => (input.grip && !input.hit ? this.tipOf(input) : []));
    const found = this.python.updateHover(tips, M.scaleOf(this.worldFromRoom));
    const hovered = found.toJs();
    found.destroy();
    shown.forEach((input, i) => {
      // What is being dragged stays this controller's, wherever other points and handles are
      input.hover = input.drag ? [input.drag.nodeID, input.drag.type, input.drag.index] : hovered[i];
    });
  }

  press(button) {
    const panel = this.panel;
    try {
      if (button.category) {
        panel.setCategory(button.category);
        if (button.category === "data") this.refreshDataItems(true);
      } else if (button.id?.startsWith("eye:")) {
        this.toggleDataItem(button.treeItem);
      } else if (button.id?.startsWith("opacity:")) {
        panel.setStatus(this.python.toggleDataItemOpacity(button.treeItem.id));
        this.refreshDataItems(true);
      } else if (button.id?.startsWith("clip:")) {
        panel.setStatus(this.python.setNodeClipping(button.treeItem.id, !button.treeItem.clipped));
        this.refreshDataItems(true);
      } else if (button.treeRow) {
        panel.selectItem(button.treeRow.id);
        panel.setStatus(panel.selectedItem === null ? "" : `${button.treeRow.name} chosen (for clipping)`);
      } else if (button.id === "clip-enable") {
        panel.setStatus(this.python.setClippingEnabled(!panel.clip.enabled, panel.selectedItem ?? 0, ...this.viewDirection()));
        this.refreshClipState(true);
        this.refreshDataItems(true);
      } else if (button.id === "clip-follow") {
        panel.clipFollow = !panel.clipFollow;
        if (panel.clipFollow) this.python.followClipView(...this.viewDirection());
        panel.setStatus(panel.clipFollow ? "The clipping plane faces you as you move" : "The clipping plane stays where it is");
        panel.layout();
        this.refreshClipState(true);
      } else if (button.id === "clip-plane") {
        panel.setStatus(this.python.setClipPlaneShown(!panel.clip.planeShown));
        this.refreshClipState(true);
      } else if (button.id === "clip-handles") {
        const shown = !panel.clip.handlesShown;
        if (shown && panel.clipFollow) {
          // (the handles turn the plane: it does not follow the view meanwhile)
          panel.clipFollow = false;
          panel.layout();
        }
        panel.setStatus(this.python.setClipHandlesShown(shown));
        this.refreshClipState(true);
      } else if (button.id === "data-previous" || button.id === "data-next") {
        panel.dataPage = Math.min(panel.dataPages - 1, Math.max(0, panel.dataPage + (button.id === "data-next" ? 1 : -1)));
        panel.layout();
      } else if (button.resolution) {
        this.setResolution(button.resolution);
      } else if (button.id === "exit") {
        this.end();
      } else if (button.tool) {
        panel.setStatus(this.python.placeStart(button.tool));
        panel.setActiveTool(button.tool);
      } else if (button.id === "done") {
        this.python.placeStop();
        panel.setActiveTool(null);
        panel.setStatus("");
      } else if (button.id === "handles") {
        const shown = !this.python.handlesShown();
        panel.setStatus(this.python.setHandlesShown(shown));
        panel.handlesOn = shown;
        panel.dirty = true;
      } else if (button.id === "undo") {
        panel.setStatus(this.python.undoPoint());
      } else if (button.id === "delete") {
        panel.setStatus(this.python.deleteMarkups());
      } else if (button.id === "reset") {
        this.resetPlacement();
      } else if (button.id === "hide") {
        panel.visible = false;
      }
    } catch (error) {
      console.error("Slicer XR:", error);
      panel.setStatus(String(error.message || error).split("\n").filter(Boolean).pop());
    }
  }

  /** A volume in a scene that shows nothing else in 3D - as a volume loaded with the page's Samples
   *  button or as a file is - is shown volume rendered, with the preset SlicerWeb chooses for it:
   *  in a headset there is nothing else to see of it. */
  async showVolumeIfAlone() {
    const volumeID = this.python.volumeToRender();
    if (!volumeID) return;
    await this.setVolumeRendering(volumeID);
    this.panel.setStatus(`${this.python.volumeName(volumeID)} is shown volume rendered`);
  }

  async setVolumeRendering(volumeID) {
    this.pythonBusy = true;
    try {
      await this.app.bridge.call("setVolumeRendering", [volumeID, { visible: true }]);
    } finally {
      this.pythonBusy = false;
    }
    const bounds = this.python.sceneBounds();
    this.bounds = bounds ? bounds.toJs() : null;
    bounds?.destroy?.();
  }

  /** The panel's Volume rendering button: off if it is shown, else on for the latest volume. */
  /** What the Clipping category shows, asked of Python at most every second (and at once when asked):
   *  the plane is moved by its handles too. */
  refreshClipState(now = false) {
    const time = performance.now();
    if (!now && time - (this.clipAskedAt ?? 0) < 1000) return;
    this.clipAskedAt = time;
    const state = this.python.clippingState();
    this.panel.setClipState(state.toJs({ dict_converter: Object.fromEntries }));
    state.destroy();
  }

  /** Where the viewer looks, in the scene (a unit vector). */
  viewDirection() {
    if (!this.head) return [0, 0, -1];
    return normalize(M.vector(M.multiply(this.worldFromRoom, this.head), [0, 0, -1]));
  }

  /** What the Data category lists, asked of Python at most every second (and at once when asked). */
  refreshDataItems(now = false) {
    const time = performance.now();
    if (!now && time - (this.dataAskedAt ?? 0) < 1000) return;
    this.dataAskedAt = time;
    const items = this.python.dataItems();
    this.panel.setDataItems(items.toJs({ dict_converter: Object.fromEntries }));
    items.destroy();
  }

  /** Shows what is hidden, or hides what is shown; a volume is shown volume rendered (with the
   *  preset SlicerWeb chooses for it). */
  async toggleDataItem(item) {
    const panel = this.panel;
    if (panel.busy) return;
    if (item.kind !== "Volume" || item.visible) {
      // (a folder: everything in it)
      panel.setStatus(this.python.setDataItemVisible(item.id, !item.visible));
      this.refreshDataItems(true);
      return;
    }
    panel.setBusy(true);
    try {
      panel.setStatus(`Volume rendering ${item.name}…`);
      await this.nextFrame();
      const placed = this.bounds;
      await this.setVolumeRendering(item.nodeID);
      if (!placed) this.resetPlacement(); // there was nothing to place before
      panel.setStatus(`${item.name} is shown volume rendered`);
    } catch (error) {
      console.error("Slicer XR: volume rendering could not be shown", error);
      panel.setStatus(`Volume rendering could not be shown: ${String(error.message || error).split("\n")[0]}`);
    } finally {
      panel.setBusy(false);
      this.refreshDataItems(true);
    }
  }

  async toggleVolumeRendering() {
    const panel = this.panel;
    if (panel.busy) return;
    panel.setBusy(true);
    try {
      if (this.python.volumeRenderingShown()) {
        this.python.hideVolumeRendering();
        panel.setStatus("Volume rendering off");
        return;
      }
      const volumeID = this.python.latestVolume();
      if (!volumeID) {
        panel.setStatus("There is no volume to show");
        return;
      }
      panel.setStatus(`Volume rendering ${this.python.volumeName(volumeID)}…`);
      await this.nextFrame();
      const placed = this.bounds;
      await this.setVolumeRendering(volumeID);
      if (!placed) this.resetPlacement(); // there was nothing to place before
      panel.setStatus(`${this.python.volumeName(volumeID)} is shown volume rendered`);
    } catch (error) {
      console.error("Slicer XR: volume rendering could not be shown", error);
      panel.setStatus(`Volume rendering could not be shown: ${String(error.message || error).split("\n")[0]}`);
    } finally {
      panel.setBusy(false);
    }
  }

  /**
   * The session's layers. Where the browser has WebXR layers, the panel is a quad layer of its own:
   * the headset draws it at the resolution of its display, however finely the 3D view is rendered
   * (its text was blurred in the 3D view at the headset's resolution setting "Speed"). Elsewhere
   * the panel is a plane in the 3D view (slicer_xr.py).
   */
  updateLayers() {
    const panel = this.panel;
    if (this.binding && panel.visible && panel.roomFromPanel) {
      const pixelHeight = Math.round(panel.height * PANEL_QUAD_PIXELS);
      if (!this.quad || this.quadPixelHeight !== pixelHeight) {
        try {
          this.quad = this.binding.createQuadLayer({
            space: this.space,
            viewPixelWidth: Math.round(PANEL_WIDTH_PX * PANEL_QUAD_PIXELS),
            viewPixelHeight: pixelHeight,
            layout: "mono",
          });
          this.quadPixelHeight = pixelHeight;
          this.quadDrawn = false;
        } catch (error) {
          console.warn("Slicer XR: the panel's quad layer could not be made; it is drawn in the scene", error);
          this.binding = null;
          this.quad = null;
        }
      }
    }
    if (this.quad) {
      const [x, y, z] = [panel.roomFromPanel[12], panel.roomFromPanel[13], panel.roomFromPanel[14]];
      const yaw = Math.atan2(panel.roomFromPanel[8], panel.roomFromPanel[10]);
      this.quad.transform = new XRRigidTransform({ x, y, z }, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
      this.quad.width = panel.widthM * QUAD_SIZE_FACTOR;
      this.quad.height = panel.heightM * QUAD_SIZE_FACTOR;
    }
    // The panel's layer under the 3D view's: the 3D view is clear where the panel is (a plane drawn
    // there clear, with its depth: slicer_xr.py), so the panel shows there, and whatever is in front
    // of it - the rays, the controllers, the scene - is drawn over it, as it should be. Between the
    // two, over the panel: the layers that light the buttons pointed at.
    const hovers = this.quad && panel.visible ? (this.hoverShown ?? []).map((entry) => entry.layer) : [];
    const layers = this.quad && panel.visible ? [this.quad, ...hovers, this.layer] : [this.layer];
    panel.hoverAsLayer = !!(this.quad && panel.visible);
    if (this.binding) this.session.updateRenderState({ layers });
    else this.session.updateRenderState({ baseLayer: this.layer });
    this.layersShown = layers;
  }

  /** A canvas into a layer's texture; Slicer's context gets back what of its state this changes. */
  uploadToTexture(colorTexture, canvas, premultiply) {
    const gl = this.gl;
    const unit = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const premultiplied = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
    const rowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH);
    const unpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, colorTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // a texture's first row is its bottom
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplied);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);
      gl.activeTexture(unit);
    }
  }

  /**
   * The buttons pointed at, each lit by a small layer over the panel's (a clear white and a bright
   * edge, see XRPanel.drawHoverCanvas), drawn by the headset as sharply as the panel is. Pointing
   * at another button moves a layer; nothing is sent, and the panel's picture is not drawn again.
   */
  updateHoverLayers(frame, shown) {
    const panel = this.panel;
    const entries = [];
    if (this.quad && panel.visible) {
      const buttons = [];
      for (const input of shown) {
        const button = input?.hit?.button;
        if (button && !buttons.includes(button)) buttons.push(button);
      }
      this.hoverLayers ??= new Map();
      buttons.forEach((button, i) => {
        const [width, height] = XRPanel.hoverPixels(button);
        const key = `${i}:${width}x${height}`;
        let entry = this.hoverLayers.get(key);
        if (!entry) {
          entry = { layer: this.binding.createQuadLayer({ space: this.space, viewPixelWidth: width, viewPixelHeight: height, layout: "mono" }), content: null };
          this.hoverLayers.set(key, entry);
        }
        // Its picture is the same for every button of its size: drawn once (and when the headset
        // asks for it again). Pointing at another button only moves the layer.
        if (!entry.content || entry.layer.needsRedraw) {
          const subImage = this.binding.getSubImage(entry.layer, frame);
          this.uploadToTexture(subImage.colorTexture, panel.drawHoverCanvas(button), true); // (premultiplied, as layers are)
          entry.content = key;
        }
        const rect = panel.rectInPanel(button);
        const m = M.multiply(panel.roomFromPanel, rect.center);
        const yaw = Math.atan2(panel.roomFromPanel[8], panel.roomFromPanel[10]);
        entry.layer.transform = new XRRigidTransform({ x: m[12], y: m[13], z: m[14] }, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
        entry.layer.width = rect.size[0] * QUAD_SIZE_FACTOR;
        entry.layer.height = rect.size[1] * QUAD_SIZE_FACTOR;
        entries.push(entry);
      });
    }
    const before = this.hoverShown ?? [];
    this.hoverShown = entries;
    if (before.length !== entries.length || before.some((entry, i) => entry !== entries[i])) this.updateLayers();
  }

  /** The panel's picture into its quad layer's texture (when it changed, or the headset asks). */
  drawQuad(frame) {
    const panel = this.panel;
    if (!this.quad || !panel.visible || (this.quadDrawn && !panel.quadDirty && !this.quad.needsRedraw)) return;
    const subImage = this.binding.getSubImage(this.quad, frame);
    const canvas = panel.drawQuadCanvas(subImage.textureWidth ?? Math.round(PANEL_WIDTH_PX * PANEL_QUAD_PIXELS));
    this.uploadToTexture(subImage.colorTexture, canvas, false);
    this.quadDrawn = true;
    panel.quadDirty = false;
  }

  /** Every two seconds, whether the GPU refused something of the frame (which shows as something
   *  missing, not as an error). Depth peeling - how Slicer draws translucent surfaces - is what a
   *  GPU is likeliest to refuse: on an error it is turned off for the session, and the translucent
   *  surfaces are blended plainly instead. */
  checkGLErrors(now) {
    if (now - (this.lastGLCheck ?? 0) < 2000) return;
    this.lastGLCheck = now;
    const errors = new Set();
    for (let e = this.gl.getError(), n = 0; e !== this.gl.NO_ERROR && e !== this.gl.CONTEXT_LOST_WEBGL && n < 10; e = this.gl.getError(), n++) errors.add(e);
    if (!errors.size) return;
    const codes = [...errors].map((e) => `0x${e.toString(16)}`).join(", ");
    if (!this.depthPeelingOff && this.python.depthPeelingOn()) {
      this.depthPeelingOff = true;
      this.python.setDepthPeeling(false);
      console.warn(`Slicer XR: GL errors (${codes}) while drawing; depth peeling turned off for the session`);
    } else if (!this.loggedGLErrors?.has(codes)) {
      (this.loggedGLErrors ??= new Set()).add(codes);
      console.warn(`Slicer XR: GL errors while drawing: ${codes}`);
    }
  }

  /** An error logged once per kind (a frame repeats it 72 times a second), and on the panel. */
  reportOnce(what, error) {
    const text = String(error?.message ?? error).split("\n").filter(Boolean).pop() ?? "";
    const key = `${what}: ${text}`;
    this.reported ??= new Set();
    if (this.reported.has(key)) return;
    this.reported.add(key);
    console.error(`Slicer XR: ${what}`, error);
    this.panel.setStatus(`Error: ${text}`.slice(0, 120));
  }

  /** Resolves once the next frame has been drawn. */
  nextFrame() {
    return new Promise((resolve) => (this.afterFrame = resolve));
  }

  /** The pose of a space in the room (column-major), or null. */
  poseOf(frame, space) {
    const pose = space && frame.getPose(space, this.space);
    return pose ? Float64Array.from(pose.transform.matrix) : null;
  }

  /** Holding moves the scene with the hand; two hands also scale and turn it. */
  updateGrab() {
    const holding = [...this.inputs.values()].filter((input) => input.pressed > 0 && input.grip);
    if (holding.length === 0) {
      this.grab = null;
      return;
    }
    const hands = holding.slice(0, 2);
    if (!this.grab || this.grab.hands.length !== hands.length || this.grab.hands.some((h, i) => h !== hands[i])) {
      this.grab = { hands, worldFromRoom: this.worldFromRoom, poses: hands.map((h) => h.grip) };
      return;
    }
    const g = this.grab;
    let roomMotion; // where the grabbed points of the room have gone
    if (hands.length === 1) {
      roomMotion = M.multiply(hands[0].grip, M.invert(g.poses[0]));
    } else {
      const position = (m) => [m[12], m[13], m[14]];
      const [a0, b0] = g.poses.map(position);
      const [a, b] = hands.map((h) => position(h.grip));
      const from = sub(b0, a0), to = sub(b, a);
      const scale = Math.min(10, Math.max(0.1, length(to) / Math.max(length(from), 1e-4)));
      const mid0 = a0.map((v, i) => (v + b0[i]) / 2), mid = a.map((v, i) => (v + b[i]) / 2);
      roomMotion = M.multiply(
        M.multiply(M.translation(...mid), M.rotationBetween(normalize(from), normalize(to))),
        M.multiply(M.scaling(scale), M.translation(-mid0[0], -mid0[1], -mid0[2])),
      );
    }
    this.worldFromRoom = M.multiply(g.worldFromRoom, M.invert(roomMotion));
    this.clampScale();
  }

  /**
   * The controllers' buttons and thumbsticks. The right one, and the left one in the View category:
   * the thumbstick turns the scene about its centre (left-right) and scales it (up-down); A or X
   * puts it back, B or Y shows the panel (in front of the viewer) or hides it. The left one does
   * what the panel's category is for: in Data, its thumbstick chooses an item of the data tree (up,
   * down) and pages it (left, right), its trigger shows or hides the item (selectStart), X makes it
   * half transparent and Y clips it; in Markups, X
   * takes back the last point and Y shows or hides the handles; in Clipping, X turns clipping on or
   * off, Y turns the plane square to the line of sight, the thumbstick moves the plane along its
   * normal (and the trigger holds it: clipGrabStart).
   * A button the browser gives that the xr-standard mapping has no name for shows or hides the
   * panel: the left controller's Menu button, which the Quest's browser gives as button 12.
   */
  updateGamepads(frame, dt) {
    for (const source of frame.session.inputSources) {
      const pad = source.gamepad;
      if (!pad) continue;
      const input = this.input(source);
      const down = pad.buttons.map((b) => !!b?.pressed);
      const pressed = (i) => down[i] && !input.down?.[i];
      const role = source.handedness === "left" ? this.panel.category : "view";
      const togglePanel = () => {
        this.panel.visible = !this.panel.visible;
        if (this.panel.visible && this.head) this.panel.placeInFront(this.head);
      };
      for (let i = 6; i < down.length; i++) {
        // (6: the thumb rest, touched not pressed; beyond it, buttons with no standard name)
        if (!pressed(i)) continue;
        console.info(`Slicer XR: button ${i} of the ${source.handedness} controller pressed`);
        if (i > 6) togglePanel();
      }
      if (role === "data") {
        // The item chosen in the tree: X makes it half transparent or opaque, Y clips it or not
        // (and the trigger shows or hides it: selectStart)
        if (pressed(4)) this.chosenItemTransparency();
        if (pressed(5)) this.chosenItemClipping();
      } else if (role === "markups") {
        if (pressed(4)) this.press({ id: "undo" });
        if (pressed(5)) this.press({ id: "handles" });
      } else if (role === "clipping") {
        if (pressed(4)) this.press({ id: "clip-enable" });
        if (pressed(5) && this.panel.clip.enabled) {
          // The plane turned square to the line of sight (once: Follow view keeps it so)
          this.python.followClipView(...this.viewDirection());
          this.panel.setStatus("Clipping plane turned square to your line of sight");
        }
      } else {
        if (pressed(4)) this.resetPlacement();
        if (pressed(5)) togglePanel();
      }
      input.down = down;
      // One of the two at a time, whichever way the stick is pushed more (a push is never quite
      // straight), from the edge of a wide dead zone and gently at first
      const x = pad.axes[2] ?? 0, y = pad.axes[3] ?? 0;
      const horizontal = Math.abs(x) >= Math.abs(y);
      const amount = stickResponse(horizontal ? x : y);
      if (role === "data") {
        this.stickData(input, amount ? (horizontal ? x : y) : 0, horizontal, dt);
        continue;
      }
      if (role === "clipping") {
        // Up: the plane farther from the viewer (as the slider to the right), half the range a second
        const clip = this.panel.clip;
        if (amount && !horizontal && clip.enabled && !input.clipGrab) {
          const offset = this.python.shiftClip(-amount * clip.range * 0.5 * dt);
          this.panel.setClipState({ ...clip, offset });
          this.panel.dirty = true;
        }
        continue;
      }
      if (!amount) continue;
      const turn = horizontal ? amount : 0, zoom = horizontal ? 0 : amount;
      const center = M.point(M.invert(this.worldFromRoom), this.sceneCenter); // in the room
      const roomMotion = M.multiply(
        M.multiply(M.translation(...center), M.yaw(-turn * STICK_TURN_RATE * dt)),
        M.multiply(M.scaling(Math.exp(-zoom * STICK_ZOOM_RATE * dt)), M.translation(-center[0], -center[1], -center[2])),
      );
      this.worldFromRoom = M.multiply(this.worldFromRoom, M.invert(roomMotion));
      this.clampScale();
    }
  }

  /** The item chosen in the Data category, or null (and the panel says to choose one). */
  chosenItem() {
    const item = this.panel.dataItems.find((i) => i.id === this.panel.selectedItem) ?? null;
    if (!item) this.panel.setStatus("Choose an item first: left stick up or down");
    return item;
  }

  chosenItemVisibility() {
    const item = this.chosenItem();
    if (item) this.toggleDataItem(item);
  }

  chosenItemTransparency() {
    const item = this.chosenItem();
    if (!item) return;
    if (item.opacity) this.press({ id: `opacity:${item.id}`, treeItem: item });
    else this.panel.setStatus(`${item.name} has no transparency to set`);
  }

  /** Clipping of the chosen item: on or off for it while clipping is on; turned on for it (which
   *  puts the plane through it) while clipping is off. */
  chosenItemClipping() {
    const item = this.chosenItem();
    if (!item) return;
    if (!this.panel.clip.enabled) {
      this.press({ id: "clip-enable" });
    } else if (item.clippable) {
      this.press({ id: `clip:${item.id}`, treeItem: item });
    } else {
      this.panel.setStatus(`${item.name} cannot be clipped`);
    }
  }

  /** The data tree with the thumbstick: up or down chooses the item above or below the chosen one
   *  (the first of the page when none is chosen; the page follows it), right or left shows the next
   *  or the previous page, with the item in the same row of it chosen. Held, it goes on: an item
   *  every quarter of a second, a page every half. */
  stickData(input, value, horizontal, dt) {
    if (!value) {
      input.stickWait = 0;
      return;
    }
    input.stickWait = (input.stickWait ?? 0) - dt;
    if (input.stickWait > 0) return;
    input.stickWait = horizontal ? 0.5 : 0.25;
    const panel = this.panel;
    const step = value > 0 ? 1 : -1; // (down and right are positive)
    const items = panel.dataItems;
    if (horizontal) {
      const page = Math.min(panel.dataPages - 1, Math.max(0, panel.dataPage + step));
      if (page === panel.dataPage) return;
      const current = items.findIndex((i) => i.id === panel.selectedItem);
      const row = Math.max(0, panel.pageRows(panel.dataPage).indexOf(current));
      const rows = panel.pageRows(page);
      const item = items[rows[Math.min(rows.length - 1, row)]];
      panel.dataPage = page;
      panel.selectedItem = item?.id ?? null;
      panel.setStatus(`Page ${page + 1} of ${panel.dataPages}` + (item ? `: ${item.name} chosen` : ""));
      panel.layout();
      return;
    }
    if (!items.length) return;
    // The row below or above on the page shown (with the items its first one is in, above it);
    // past its last row the first item of the next page, before its first row the last item of
    // the previous page. Nothing chosen on it: its first row.
    const current = items.findIndex((i) => i.id === panel.selectedItem);
    const rows = panel.pageRows(panel.dataPage);
    const at = rows.indexOf(current);
    let index, page = panel.dataPage;
    if (at < 0) {
      index = rows[0];
    } else if (at + step >= 0 && at + step < rows.length) {
      index = rows[at + step];
    } else {
      page += step;
      if (page < 0 || page >= panel.dataPages) return;
      const { own } = panel.dataPageTable()[page];
      index = step > 0 ? own[0] : own[own.length - 1];
    }
    if (index === undefined || index === current) return;
    const item = items[index];
    panel.selectedItem = item.id;
    panel.dataPage = page;
    panel.setStatus(`${item.name} chosen`);
    panel.layout();
  }

  clampScale() {
    const mmPerMetre = M.scaleOf(this.worldFromRoom);
    const clamped = Math.min(1e6, Math.max(1, mmPerMetre));
    if (clamped !== mmPerMetre) this.worldFromRoom = M.multiply(this.worldFromRoom, M.scaling(clamped / mmPerMetre));
  }

  /**
   * A controller's ray to the panel as a ribbon turned to the viewer: the 8 corners (in Slicer's
   * coordinates) of its two ends, each end across the ribbon clear - white - white - clear. Its
   * white middle is RAY_WIDTH_M wide (and never thinner than 1.5 pixels of an eye), its edges fade
   * out over RAY_FEATHER_PX pixels: a line with soft edges, which a line drawn as a line has not.
   * pixelsPerUnit: pixels of an eye per unit of the tangent of the angle from its axis, times 2.
   */
  rayRibbon(input, pixelsPerUnit) {
    const ray = input.ray;
    const start = [ray[12], ray[13], ray[14]];
    const direction = normalize(M.vector(ray, [0, 0, -1]));
    const end = start.map((v, i) => v + direction[i] * input.hit.t);
    const eye = this.head ? [this.head[12], this.head[13], this.head[14]] : [0, 1.6, 0];
    const section = (point) => {
      const toEye = sub(eye, point);
      let across = cross(direction, toEye);
      if (length(across) < 1e-6) across = cross(direction, [0, 1, 0]);
      across = normalize(across);
      const metresPerPixel = (length(toEye) * 2) / pixelsPerUnit;
      const core = Math.max(RAY_WIDTH_M / 2, 0.75 * metresPerPixel);
      const feather = RAY_FEATHER_PX * metresPerPixel;
      return [-(core + feather), -core, core, core + feather]
        .map((k) => M.point(this.worldFromRoom, point.map((v, i) => v + across[i] * k)));
    };
    return [...section(start), ...section(end)].flat();
  }

  /** What the camera of an eye is, as slicer_xr.py renderEye takes it. */
  eyeCamera(view) {
    const worldFromEye = M.multiply(this.worldFromRoom, Float64Array.from(view.transform.matrix));
    const mmPerMetre = M.scaleOf(this.worldFromRoom);
    const position = M.point(worldFromEye, [0, 0, 0]);
    const forward = normalize(M.vector(worldFromEye, [0, 0, -1]));
    const up = normalize(M.vector(worldFromEye, [0, 1, 0]));
    const focal = position.map((v, i) => v + forward[i] * mmPerMetre);
    // The eye's frustum, with near and far planes in Slicer's millimetres
    const p = view.projectionMatrix;
    const near = NEAR_M * mmPerMetre, far = FAR_M * mmPerMetre;
    const projection = [
      p[0], 0, p[8], 0,
      0, p[5], p[9], 0,
      0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
      0, 0, -1, 0,
    ];
    const top = (1 + p[9]) / p[5], bottom = (p[9] - 1) / p[5];
    const viewAngle = ((Math.atan(top) - Math.atan(bottom)) * 180) / Math.PI;
    return [...position, ...focal, ...up, near, far, viewAngle, ...projection];
  }

  onFrame(time, frame) {
    if (this.done) return;
    const session = frame.session;
    session.requestAnimationFrame((t, f) => this.onFrame(t, f));
    if (this.pythonBusy || this.recovering) return; // the headset shows the last frame meanwhile
    if (this.gl.isContextLost() || !this.python.alive()) {
      this.recover();
      return;
    }
    const layersInUse = session.renderState.layers?.length ? session.renderState.layers : [session.renderState.baseLayer];
    if (!layersInUse.includes(this.layer)) return; // a new layer is used from the next frame
    const pose = frame.getViewerPose(this.space);
    if (!pose) return;
    const dt = this.lastTime === null ? 0 : Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;
    this.head = Float64Array.from(pose.transform.matrix);
    if (!this.panel.roomFromPanel) this.panel.placeInFront(this.head);

    // Where the controllers are, and what on the panel they point at
    const sources = [...session.inputSources];
    let hover = null;
    for (const source of sources) {
      const input = this.input(source);
      input.grip = this.poseOf(frame, source.gripSpace || source.targetRaySpace);
      input.ray = this.poseOf(frame, source.targetRaySpace);
      input.hit = this.panel.hit(input.ray);
      hover ||= input.hit?.button?.id ?? null;
    }
    this.panel.setHover(hover);

    for (const input of this.inputs.values()) if (input.select === "slider") this.slideTo(input);
    if (this.panel.visible && this.panel.category === "data") {
      try {
        this.refreshDataItems();
      } catch (error) {
        this.reportOnce("the scene's data could not be listed", error);
      }
    }
    if (this.panel.visible && this.panel.category === "clipping" && ![...this.inputs.values()].some((i) => i.select === "slider")) {
      try {
        this.refreshClipState();
      } catch (error) {
        this.reportOnce("the clipping could not be read", error);
      }
    }
    if (this.panel.clipFollow && this.panel.clip.enabled) {
      try {
        this.python.followClipView(...this.viewDirection());
      } catch (error) {
        this.reportOnce("the clipping plane could not follow the view", error);
      }
    }
    this.updateGrab();
    this.updateGamepads(frame, dt);
    for (const input of this.inputs.values()) {
      if (!input.clipGrab || !input.grip) continue;
      try {
        this.python.clipGrabMove(this.handInScene(input));
      } catch (error) {
        this.reportOnce("the clipping plane could not be moved", error);
      }
    }

    const shown = sources.slice(0, 2).map((source) => this.inputs.get(source));
    const controllers = shown.map((input) => (input.grip ? M.rowMajor(M.multiply(this.worldFromRoom, input.grip)) : []));
    const eyeHeightPx = this.layer.getViewport(pose.views[0]).height;
    const rays = shown.map((input) => (input.hit && input.ray ? this.rayRibbon(input, pose.views[0].projectionMatrix[5] * eyeHeightPx) : []));
    // The panel: its own layer where there are layers, else a plane in the scene
    const panelInScene = this.panel.visible && !this.quad;
    const panelMatrix = panelInScene ? M.rowMajor(M.multiply(this.worldFromRoom, this.panel.roomFromPanel)) : [];
    // Where the panel's layer is, the 3D view is clear, with a soft edge a few pixels wide
    const worldFromPanel = this.panel.roomFromPanel ? M.multiply(this.worldFromRoom, this.panel.roomFromPanel) : null;
    const holed = !!(this.quad && this.panel.visible && worldFromPanel);
    const holeMatrix = holed ? M.rowMajor(worldFromPanel) : [];
    if (this.panel.moved || (this.quad === null && this.binding && this.panel.visible) || this.panelShown !== this.panel.visible) {
      this.panel.moved = false;
      this.panelShown = this.panel.visible;
      this.updateLayers();
    }

    const layer = this.layer;
    const viewports = pose.views.map((view) => layer.getViewport(view));
    const width = viewports[0].width, height = viewports[0].height;
    try {
      // What the controllers point at and drag: a failure there is reported, and the frame is drawn
      try {
        this.updateControlPoints(shown);
      } catch (error) {
        this.reportOnce("control points and handles could not be followed", error);
      }
      if (this.panel.dirty) {
        if (this.quad) {
          this.panel.dirty = false;
          this.panel.quadDirty = true;
        } else {
          const { pixels, width: pw, height: ph } = this.panel.draw();
          this.python.setPanelImage(pixels, pw, ph, this.panel.widthM, this.panel.heightM);
        }
      }
      try {
        this.drawQuad(frame);
        this.updateHoverLayers(frame, shown);
      } catch (error) {
        this.reportOnce("the panel's layer could not be drawn", error);
      }
      this.redirect.begin(layer.framebuffer);
      // In VR the background is drawn on a sphere around the viewer (20 m away, well inside the far
      // plane): it stays where it is as the head turns, and it leaves the panel's place clear
      const vr = this.mode !== "immersive-ar";
      const skyMatrix = vr && this.head
        ? M.rowMajor(M.multiply(this.worldFromRoom, M.multiply(M.translation(this.head[12], this.head[13], this.head[14]), scale3(SKY_RADIUS_M, SKY_RADIUS_M, SKY_RADIUS_M))))
        : [];
      let holeSize = [], ringT = [];
      if (holed) {
        // The soft edge: a few pixels of an eye, at the panel's distance
        const panelM = this.panel.roomFromPanel;
        const eye = [this.head[12], this.head[13], this.head[14]];
        const distance = length(sub([panelM[12], panelM[13], panelM[14]], eye));
        const metresPerPixel = (distance * 2) / (pose.views[0].projectionMatrix[5] * height);
        const feather = Math.min(0.012, Math.max(0.0005, Math.round((EDGE_FEATHER_PX * metresPerPixel) / 0.00025) * 0.00025));
        const w = this.panel.widthM / 2, h = this.panel.heightM / 2;
        holeSize = [this.panel.widthM, this.panel.heightM, feather];
        // Where on the sky's gradient (0 at the bottom, 1 at the top) the corners of the panel and
        // of the inside of its soft edge are seen: the edge is the sky's colour, fading out
        if (vr) {
          ringT = [[-w, -h], [w, -h], [w, h], [-w, h], [-w + feather, -h + feather], [w - feather, -h + feather], [w - feather, h - feather], [-w + feather, h - feather]]
            .map(([x, y]) => (normalize(sub(M.point(panelM, [x, y, 0]), eye))[1] + 1) / 2);
        }
      }
      this.python.beginFrame(width, height, controllers, rays, panelMatrix, holeMatrix, skyMatrix, holeSize, ringT);
      pose.views.forEach((view, i) => {
        const viewport = viewports[i];
        this.redirect.offset = [viewport.x, viewport.y];
        this.python.renderEye(this.eyeCamera(view));
      });
      this.failedFrames = 0;
    } catch (error) {
      if (this.gl.isContextLost() || !this.python.alive()) {
        this.recover(); // lost while it was drawn
      } else {
        // A frame that fails now and then is reported and skipped; the session ends only when
        // frames keep failing (a second's worth), as nothing would be seen of it
        this.failedFrames = (this.failedFrames ?? 0) + 1;
        this.reportOnce("a frame could not be drawn", error);
        if (this.failedFrames >= 72) {
          console.error("Slicer XR: frames keep failing; the session is ended");
          this.ui.showError(error);
          this.end();
        }
      }
    } finally {
      this.redirect.end();
    }
    this.checkGLErrors(now0());
    try {
      this.adaptVolumeQuality(now0());
    } catch (error) {
      this.reportOnce("volume rendering could not be adapted", error);
    }
    // How the session goes, for the log: the first frame, then the frame rate every 10 seconds
    this.framesDrawn = (this.framesDrawn ?? 0) + 1;
    if (!this.firstFrameDrawn) {
      this.firstFrameDrawn = true;
      this.redirect.blits = 0;
      console.info(`Slicer XR: first frame drawn, eyes ${width}x${height}`);
    } else if (this.resolutionChanged) {
      this.resolutionChanged = false;
      const viewports = pose.views.map((view) => layer.getViewport(view)).map((v) => `${v.x},${v.y} ${v.width}x${v.height}`);
      console.info(`Slicer XR: first frame at the new resolution: eyes ${viewports.join(" and ")}, Slicer's view ${this.python.viewSize()}`);
    } else if (this.framesDrawn === 10) {
      // Two copies a frame (an eye each) is what reaching the headset looks like
      console.info(`Slicer XR: frames 2-10: ${this.redirect.blits} copies into the headset's framebuffer (${2 * 9} expected)`);
    }
    const now = performance.now();
    this.statsSince ??= { time: now, frames: this.framesDrawn };
    if (now - this.statsSince.time > 10000) {
      const fps = ((this.framesDrawn - this.statsSince.frames) * 1000) / (now - this.statsSince.time);
      console.info(`Slicer XR: ${fps.toFixed(0)} frames per second, eyes ${width}x${height}`);
      this.statsSince = { time: now, frames: this.framesDrawn };
    }
    const afterFrame = this.afterFrame;
    this.afterFrame = null;
    afterFrame?.();
  }
}

// --------------------------------------------------------------------------------- the buttons

class XRButtons {
  constructor() {
    this.session = null;
    this.supported = { "immersive-vr": false, "immersive-ar": false };
    this.build();
    this.checkSupport();
    this.timer = setInterval(() => this.refresh(), 500);
  }

  build() {
    const style = document.createElement("style");
    style.textContent = `
      #slicer-xr[hidden] { display: none; }
      #slicer-xr { position: fixed; right: 16px; bottom: 16px; z-index: 10000; display: flex; gap: 8px;
        align-items: center; font: 600 14px/1.2 system-ui, sans-serif; }
      #slicer-xr button { border: 0; border-radius: 999px; padding: 10px 16px; cursor: pointer;
        background: #2563eb; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.35); font: inherit; }
      #slicer-xr button.ar { background: #7c3aed; }
      #slicer-xr button:disabled { background: #6b7280; cursor: default; opacity: .85; }
      #slicer-xr .message { max-width: 320px; padding: 8px 12px; border-radius: 10px; font-weight: 500;
        background: rgba(17,24,39,.92); color: #f3f4f6; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
      #slicer-xr .message:empty { display: none; }
    `;
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.id = "slicer-xr";
    this.root = root;
    root.innerHTML = `
      <div class="message"></div>
      <button class="vr" disabled>Enter VR</button>
      <button class="ar" disabled hidden>Enter AR</button>`;
    document.body.appendChild(root);
    this.message = root.querySelector(".message");
    this.vr = root.querySelector("button.vr");
    this.ar = root.querySelector("button.ar");
    this.vr.addEventListener("click", () => this.toggle("immersive-vr"));
    this.ar.addEventListener("click", () => this.toggle("immersive-ar"));
  }

  async checkSupport() {
    if (!navigator.xr) return this.refresh();
    for (const mode of Object.keys(this.supported)) {
      try {
        this.supported[mode] = await navigator.xr.isSessionSupported(mode);
      } catch {
        this.supported[mode] = false;
      }
    }
    this.refresh();
  }

  refresh() {
    const ready = !!slicerWebApp();
    const active = this.session?.mode;
    // Application settings > General > Virtual and augmented reality (a session that is on goes on: it ends from the headset)
    this.root.hidden = !xrEnabled() && !active;
    const label = (mode, name) => (active === mode ? `Exit ${name}` : `Enter ${name}`);
    this.vr.textContent = label("immersive-vr", "VR");
    this.ar.textContent = label("immersive-ar", "AR");
    this.ar.hidden = !this.supported["immersive-ar"];
    const usable = (mode) => this.supported[mode] && ready && !this.starting && (!active || active === mode);
    this.vr.disabled = !usable("immersive-vr");
    this.ar.disabled = !usable("immersive-ar");
    if (!navigator.xr || !window.isSecureContext) {
      this.vr.title = "WebXR needs a headset browser and a secure (https or localhost) page";
    } else if (!this.supported["immersive-vr"]) {
      this.vr.title = "This browser has no immersive VR";
    } else if (!ready) {
      this.vr.title = "Slicer is loading";
    } else {
      this.vr.title = "Show the 3D view in the headset";
    }
  }

  async toggle(mode) {
    if (this.session) {
      this.session.end();
      return;
    }
    const app = slicerWebApp();
    if (!app) return;
    this.starting = true;
    this.showError(null);
    this.refresh();
    // The session has to be asked for while the click still counts as the user's: the Python half
    // is loaded in the background beforehand (below), so nothing long is waited for first
    let session = null;
    try {
      const python = await slicerXRPython(app);
      session = new XRSessionView(app, python, mode, setting("resolution", 0.7), this);
      session.mode = mode;
      this.session = session;
      await session.start();
    } catch (error) {
      console.error("Slicer XR: the session could not be started", error);
      this.session = null;
      this.showError(error);
    } finally {
      this.starting = false;
      this.refresh();
    }
  }

  sessionEnded(session) {
    if (this.session === session) this.session = null;
    this.refresh();
  }

  showError(error) {
    this.message.textContent = error ? String(error.message || error).split("\n").slice(-2).join(" ") : "";
  }
}

// Python is loaded in the background as soon as Slicer is, so that the click starts the session at once
// On a headset the 3D view's context is made XR compatible too, still on the page: if the browser
// loses the context on the way (see makeViewXRCompatible), SlicerWeb makes the view anew there,
// where nobody is looking, rather than in the first session. (?xrPrepare=0: not, for the tests.)
const preload = setInterval(() => {
  const app = slicerWebApp();
  if (!app) return;
  clearInterval(preload);
  slicerXRPython(app)
    .then(async (python) => {
      if (new URLSearchParams(location.search).get("xrPrepare") === "0" || !navigator.xr || !xrEnabled()) return;
      const modes = await Promise.all(["immersive-vr", "immersive-ar"].map((mode) => navigator.xr.isSessionSupported(mode).catch(() => false)));
      if (!modes.some(Boolean)) return;
      window.slicerXR.preparing = makeViewXRCompatible(python).then(
        () => console.info("Slicer XR: the 3D view is ready for XR"),
        (error) => console.warn("Slicer XR: the 3D view could not be made ready for XR in advance", error),
      );
    })
    .catch((error) => console.error("Slicer XR: slicer_xr.py could not be loaded", error));
}, 500);

// --------------------------------------------------------------------------------- the setting
// "XR/Enabled" among SlicerWeb's application settings (its default the application's: XR_DEFAULT):
// whether the page offers VR and AR. SlicerWeb keeps its settings in the browser - those that differ from its defaults - and
// keeps one it does not know of too; the checkbox for it is put in its Application settings dialog,
// at the end of the General section, made as the dialog's own checkboxes are (SwCheckBox).
const XR_SETTING = "XR/Enabled";
const SETTINGS_STORAGE = "slicerweb.settings"; // SlicerWeb's (web/src/core/settings.ts SETTINGS_KEY)

// Whether the setting is on before a user changes it: as the application's application.json says
// (feature webxr: enabledByDefault or disabledByDefault; main.ts puts it on the script's tag)
const XR_DEFAULT = document.querySelector('script[src$="xr/slicer-xr.js"]')?.dataset.webxr !== "disabledByDefault";

function xrEnabled() {
  const settings = window.slicerWeb?.store?.settings;
  if (settings && XR_SETTING in settings) return settings[XR_SETTING] !== false;
  try {
    const kept = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) ?? "{}");
    return kept && XR_SETTING in kept ? kept[XR_SETTING] !== false : XR_DEFAULT;
  } catch {
    return XR_DEFAULT;
  }
}

function setXREnabled(enabled) {
  const store = window.slicerWeb?.store;
  if (store) store.settings = { ...store.settings, [XR_SETTING]: enabled };
  try {
    // Kept as a user set it, whichever the application's default (which may change)
    const kept = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) ?? "{}") ?? {};
    kept[XR_SETTING] = !!enabled;
    localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(kept));
  } catch {
    // a private window: the setting holds for this page
  }
  console.info(`Slicer XR: WebXR ${enabled ? "enabled" : "disabled"} (Application settings)`);
  window.slicerXR?.refresh();
}

/** The checkbox, while the dialog shows its General section (found by a checkbox of that section),
 *  and gone when the dialog shows another section: what the dialog's own Vue code does not draw, it
 *  does not take away either. */
function settingsCheckbox() {
  const anchor = document.querySelector('[data-name="settings-dialog"] [data-name="saveWrittenFilesToDownloads"]');
  const existing = document.getElementById("slicer-xr-setting");
  if (!anchor) {
    existing?.remove();
    return;
  }
  const section = anchor.parentElement;
  if (existing && existing.parentElement === section) {
    const input = existing.querySelector("input");
    if (input.checked !== xrEnabled()) input.checked = xrEnabled();
    return;
  }
  existing?.remove();
  const block = document.createElement("div");
  block.id = "slicer-xr-setting";
  block.innerHTML = `
    <label class="sw-checkbox mt-3 inline-flex cursor-pointer items-center gap-2 text-[13px] text-foreground" data-name="xrEnabled">
      <input type="checkbox" class="h-3.5 w-3.5 accent-highlight" />
      <span>Virtual and augmented reality (WebXR)</span>
    </label>
    <div class="mt-1 pl-6 text-[12px] text-muted-foreground">
      Shows the Enter VR and Enter AR buttons, which display the 3D view in a headset such as the Meta Quest
      when this page is opened in the headset's web browser. When this option is turned off, the buttons are hidden.
    </div>`;
  const input = block.querySelector("input");
  input.checked = xrEnabled();
  input.addEventListener("change", () => setXREnabled(input.checked));
  section.appendChild(block);
}
new MutationObserver(() => settingsCheckbox()).observe(document.documentElement, { childList: true, subtree: true });

window.slicerXR = new XRButtons();
// For tests (tests/render-eyes.mjs), which draw frames without a headset
window.slicerXR.internals = { M, redirectDefaultFramebuffer, XRSessionView, XRPanel, slicerXRPython, slicerWebApp };
