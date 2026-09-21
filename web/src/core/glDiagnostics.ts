import type { SlicerBridge } from "./bridge";

/**
 * What the graphics driver says when a shader will not compile or link.
 *
 * VTK prints the shader it failed on but not always the reason: the message it prints is the log of
 * the driver, and several drivers give none to it. The calls are wrapped here instead, where the log
 * can be read straight from the context, so that a failure on someone's phone says what was wrong
 * rather than only that "the shader program could not be set".
 *
 * Failures are reported to the application log (the log window shows them) and are also kept in
 * window.slicerWebGLFailures for a look in the browser's console.
 */
export interface ShaderFailure {
  kind: "compile" | "link";
  log: string;
  shaderType?: string;
  source?: string;
}

const failures: ShaderFailure[] = [];
let reportTo: SlicerBridge | undefined;

/** Line of the source the driver's message points at, which is usually what is wrong. */
function sourceExcerpt(source: string, log: string): string {
  const lines = source.split("\n");
  const match = /(?:^|\D)(\d+)\s*[:(]\s*(\d+)/.exec(log); // "0:57" or "ERROR: 0(57)"
  const number = match ? Number(match[2]) : NaN;
  if (Number.isFinite(number) && number >= 1 && number <= lines.length) {
    return lines
      .slice(Math.max(0, number - 2), number + 1)
      .map((l, i) => `${Math.max(1, number - 1) + i}: ${l}`)
      .join("\n");
  }
  return lines.slice(0, 3).join("\n");
}

function report(failure: ShaderFailure) {
  failures.push(failure);
  if (failures.length > 20) failures.shift();
  const text = [
    `${failure.kind === "compile" ? "Shader compilation" : "Shader linking"} failed`,
    failure.shaderType ? `(${failure.shaderType})` : "",
    ": ",
    failure.log || "the driver gave no message",
    failure.source ? `\n${failure.source}` : "",
  ].join("");
  console.error("[WebGL]", text);
  reportTo?.call("logMessage", ["ERROR", text, "WebGL"]).catch(() => {});
}

/** Watch every WebGL context of the page for shaders that will not build. */
export function installGLDiagnostics() {
  const contexts = [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype];
  for (const proto of contexts) {
    if (!proto || (proto as { __slicerWebPatched?: boolean }).__slicerWebPatched) continue;
    (proto as { __slicerWebPatched?: boolean }).__slicerWebPatched = true;

    const compileShader = proto.compileShader;
    proto.compileShader = function (shader: WebGLShader) {
      compileShader.call(this, shader);
      if (!shader || this.getShaderParameter(shader, this.COMPILE_STATUS)) return;
      const source = this.getShaderSource(shader) ?? "";
      const log = this.getShaderInfoLog(shader) ?? "";
      const type = this.getShaderParameter(shader, this.SHADER_TYPE);
      report({
        kind: "compile",
        log,
        shaderType: type === this.VERTEX_SHADER ? "vertex" : type === this.FRAGMENT_SHADER ? "fragment" : String(type),
        source: sourceExcerpt(source, log),
      });
    };

    const linkProgram = proto.linkProgram;
    proto.linkProgram = function (program: WebGLProgram) {
      linkProgram.call(this, program);
      if (!program || this.getProgramParameter(program, this.LINK_STATUS)) return;
      report({ kind: "link", log: this.getProgramInfoLog(program) ?? "" });
    };
  }
  (window as unknown as { slicerWebGLFailures: ShaderFailure[] }).slicerWebGLFailures = failures;
}

/** Send failures to the application log as well, and record what this device renders with. */
export function reportGLToApplication(bridge: SlicerBridge) {
  reportTo = bridge;
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
  if (!gl) {
    bridge.call("logMessage", ["WARNING", "This browser has no WebGL", "WebGL"]).catch(() => {});
    return;
  }
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const description = [
    gl.getParameter(gl.VERSION),
    info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    `attributes: ${gl.getParameter(gl.MAX_VERTEX_ATTRIBS)}`,
    `texture size: ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`,
    `varyings: ${gl.getParameter(gl.MAX_VARYING_VECTORS)}`,
  ].join(", ");
  bridge.call("logMessage", ["INFO", description, "WebGL"]).catch(() => {});
  for (const failure of failures) report(failure); // failures from before the bridge was ready
}
