import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';

/**
 * Every sector and every blip, in two buffers and two draw calls.
 *
 * The load-bearing decision: **animation is a uniform, not an upload**. Sweep,
 * radial falloff, the outer arc and focus dimming are all computed in the
 * fragment shader from `u_time`. Moving a camera from "idle" to "detection"
 * changes a colour in a buffer that was going to be re-uploaded anyway; it does
 * not recompute geometry, and an idle dashboard sends zero bytes to the GPU per
 * frame.
 *
 * The other one: the isovist polygon is star-shaped about its apex, so it
 * triangulates as a fan — `(apex, rim[i], rim[i+1])`. No earcut, no per-frame
 * CPU geometry.
 */

export interface SectorInput {
  /** Mercator `[x, y, z]`, apex first, then the rim in angular order. */
  vertices: Array<[number, number, number]>;
  /** Per-vertex distance from the apex, normalised to the camera's range. */
  radii: number[];
  color: [number, number, number];
  intensity: number;
  /** Revolutions per second. Zero means a still sector — and a still card. */
  sweep: number;
  cameraIndex: number;
}

export interface BlipInput {
  position: [number, number, number];
  color: [number, number, number];
  /** 0 = now, →1 = about to vanish. Drives both alpha and size. */
  age: number;
  size: number;
}

/** pos(3f) · apex(2f) · radius(1f) · params(3f) · colour(4×u8) */
const SECTOR_STRIDE = 4 * 9 + 4;
/** pos(3f) · age(1f) · size(1f) · colour(4×u8) */
const BLIP_STRIDE = 4 * 5 + 4;

const SECTOR_VS = `
precision highp float;
attribute vec3 a_pos;
attribute vec2 a_apex;
attribute float a_radius;
attribute vec3 a_params;   // intensity, sweep, camera index
attribute vec4 a_color;

uniform mat4 u_matrix;

varying vec2 v_fromApex;
varying float v_radius;
varying vec3 v_params;
varying vec3 v_color;

void main() {
  // Kept in mercator space rather than screen space: the bearing has to be the
  // bearing on the ground, not the one the current map rotation happens to show.
  v_fromApex = a_pos.xy - a_apex;
  v_radius = a_radius;
  v_params = a_params;
  v_color = a_color.rgb;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}
`;

const SECTOR_FS = `
precision highp float;

varying vec2 v_fromApex;
varying float v_radius;
varying vec3 v_params;
varying vec3 v_color;

uniform float u_time;
uniform float u_focus;   // -1 when nothing is focused

const float TAU = 6.28318530718;

void main() {
  float intensity = v_params.x;
  float sweep = v_params.y;
  float index = v_params.z;

  // Near the tip every direction collapses, so the sweep would alias into
  // noise. Fading it in over the first few percent of the range hides that and
  // reads as the beam leaving the lens rather than being born mid-air.
  float tip = smoothstep(0.0, 0.06, v_radius);

  // The wash: strongest at the camera, gone at the stated range.
  float falloff = 1.0 - pow(clamp(v_radius, 0.0, 1.0), 1.55);
  float alpha = intensity * falloff;

  // The rim, where a chart draws the arc bounding a light's sector.
  float arc = smoothstep(0.88, 0.985, v_radius) * (1.0 - smoothstep(0.985, 1.0, v_radius));
  alpha += arc * intensity * 1.9;

  if (sweep > 0.0) {
    float bearing = atan(v_fromApex.x, -v_fromApex.y);
    float phase = fract(bearing / TAU - u_time * sweep);
    // A long trailing tail and a hard leading edge: the shape of a radar
    // afterglow, and the only part of this card that is decoration.
    float beam = pow(1.0 - phase, 22.0);
    alpha += beam * intensity * 1.6 * tip;
  }

  // Focus mode dims every sector but one. Doing it here rather than by
  // re-uploading intensities is what keeps focus a free operation.
  if (u_focus >= 0.0 && abs(index - u_focus) > 0.5) {
    alpha *= 0.18;
  }

  // The arc and the sweep are both additive, so a lit sector can pass 1.0 on
  // its own — and four cameras covering one driveway, which is the normal
  // case, would wash the ground to flat white. Capping below 1 keeps
  // overlapping coverage readable as layers instead of as a blown highlight.
  alpha = clamp(alpha, 0.0, 0.72);

  gl_FragColor = vec4(v_color * alpha, alpha);
}
`;

const BLIP_VS = `
precision highp float;
attribute vec3 a_pos;
attribute float a_age;
attribute float a_size;
attribute vec4 a_color;

uniform mat4 u_matrix;
uniform float u_pixelRatio;

varying float v_age;
varying vec3 v_color;

void main() {
  v_age = a_age;
  v_color = a_color.rgb;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
  gl_PointSize = a_size * u_pixelRatio * (1.0 - a_age * 0.55);
}
`;

const BLIP_FS = `
precision highp float;

varying float v_age;
varying vec3 v_color;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  if (r > 1.0) discard;

  // A hard core with a halo: at 7 px a trail dot still reads as a dot, and the
  // halo keeps the head visible against a bright satellite basemap.
  float core = 1.0 - smoothstep(0.0, 0.55, r);
  float halo = (1.0 - smoothstep(0.4, 1.0, r)) * 0.45;
  float alpha = (core + halo) * (1.0 - v_age);

  gl_FragColor = vec4(v_color * alpha, alpha);
}
`;

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const build = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Sémaphore shader: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };

  const program = gl.createProgram()!;
  const v = build(gl.VERTEX_SHADER, vs);
  const f = build(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Sémaphore program: ${gl.getProgramInfoLog(program)}`);
  }
  // Attached shaders stay alive until the program is deleted, so they can be
  // released the moment linking succeeds.
  gl.deleteShader(v);
  gl.deleteShader(f);
  return program;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class SceneLayer implements CustomLayerInterface {
  readonly id = 'semaphore-scene';
  readonly type = 'custom' as const;
  /** Sectors and blips carry altitude, so they need the depth buffer. */
  readonly renderingMode = '3d' as const;

  /** Index of the focused camera, or -1. Read straight into a uniform. */
  focusIndex = -1;
  /** When set, `u_time` stops here — the timeline scrubber freezing the scene. */
  frozenTime: number | null = null;

  private gl?: WebGLRenderingContext;
  private map?: MlMap;

  private sectorProgram?: WebGLProgram;
  private blipProgram?: WebGLProgram;
  private sectorBuffer?: WebGLBuffer;
  private blipBuffer?: WebGLBuffer;

  private sectorVerts = 0;
  private blipVerts = 0;
  private pendingSectors: SectorInput[] | null = null;
  private pendingBlips: BlipInput[] | null = null;
  private started = performance.now();

  private sectorAttribs: Record<string, number> = {};
  private blipAttribs: Record<string, number> = {};
  private sectorUniforms: Record<string, WebGLUniformLocation | null> = {};
  private blipUniforms: Record<string, WebGLUniformLocation | null> = {};

  // ---- MapLibre custom layer ----------------------------------------------

  onAdd(map: MlMap, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;

    this.sectorProgram = compile(gl, SECTOR_VS, SECTOR_FS);
    this.blipProgram = compile(gl, BLIP_VS, BLIP_FS);
    this.sectorBuffer = gl.createBuffer()!;
    this.blipBuffer = gl.createBuffer()!;

    for (const name of ['a_pos', 'a_apex', 'a_radius', 'a_params', 'a_color']) {
      this.sectorAttribs[name] = gl.getAttribLocation(this.sectorProgram, name);
    }
    for (const name of ['u_matrix', 'u_time', 'u_focus']) {
      this.sectorUniforms[name] = gl.getUniformLocation(this.sectorProgram, name);
    }
    for (const name of ['a_pos', 'a_age', 'a_size', 'a_color']) {
      this.blipAttribs[name] = gl.getAttribLocation(this.blipProgram, name);
    }
    for (const name of ['u_matrix', 'u_pixelRatio']) {
      this.blipUniforms[name] = gl.getUniformLocation(this.blipProgram, name);
    }

    // Data that arrived before the GL context existed.
    if (this.pendingSectors) this.uploadSectors(this.pendingSectors);
    if (this.pendingBlips) this.uploadBlips(this.pendingBlips);
    this.pendingSectors = null;
    this.pendingBlips = null;
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    if (this.sectorProgram) gl.deleteProgram(this.sectorProgram);
    if (this.blipProgram) gl.deleteProgram(this.blipProgram);
    if (this.sectorBuffer) gl.deleteBuffer(this.sectorBuffer);
    if (this.blipBuffer) gl.deleteBuffer(this.blipBuffer);
    this.gl = undefined;
  }

  /**
   * MapLibre 4 hands `render` the projection matrix directly; MapLibre 5 hands
   * it a struct and puts the matrix in `defaultProjectionData.mainMatrix`.
   * Supporting both is three lines, and saves the card from pinning a major.
   */
  private static resolveMatrix(arg: unknown): Float32Array | number[] {
    if (arg instanceof Float32Array || Array.isArray(arg)) return arg;
    const data = (arg as any)?.defaultProjectionData;
    return data?.mainMatrix ?? (arg as any)?.mainMatrix ?? IDENTITY;
  }

  render(gl: WebGLRenderingContext, arg: unknown): void {
    if (!this.sectorProgram || !this.blipProgram) return;
    const matrix = SceneLayer.resolveMatrix(arg);
    const time =
      this.frozenTime ?? (performance.now() - this.started) / 1000;

    gl.enable(gl.BLEND);
    // Premultiplied alpha: the shaders already fold alpha into rgb, so
    // overlapping coverage adds light instead of the later cone flatly
    // replacing the earlier one.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Tested against the depth the basemap wrote, so a building hides the cone
    // behind it — but never written, so cones never hide each other.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    if (this.sectorVerts) {
      gl.useProgram(this.sectorProgram);
      gl.uniformMatrix4fv(this.sectorUniforms.u_matrix, false, matrix as Float32Array);
      gl.uniform1f(this.sectorUniforms.u_time, time);
      gl.uniform1f(this.sectorUniforms.u_focus, this.focusIndex);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.sectorBuffer!);
      const a = this.sectorAttribs;
      this.vec(gl, a.a_pos, 3, gl.FLOAT, false, SECTOR_STRIDE, 0);
      this.vec(gl, a.a_apex, 2, gl.FLOAT, false, SECTOR_STRIDE, 12);
      this.vec(gl, a.a_radius, 1, gl.FLOAT, false, SECTOR_STRIDE, 20);
      this.vec(gl, a.a_params, 3, gl.FLOAT, false, SECTOR_STRIDE, 24);
      this.vec(gl, a.a_color, 4, gl.UNSIGNED_BYTE, true, SECTOR_STRIDE, 36);
      gl.drawArrays(gl.TRIANGLES, 0, this.sectorVerts);
      this.disableAll(gl, a);
    }

    if (this.blipVerts) {
      gl.useProgram(this.blipProgram);
      gl.uniformMatrix4fv(this.blipUniforms.u_matrix, false, matrix as Float32Array);
      gl.uniform1f(this.blipUniforms.u_pixelRatio, window.devicePixelRatio || 1);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.blipBuffer!);
      const a = this.blipAttribs;
      this.vec(gl, a.a_pos, 3, gl.FLOAT, false, BLIP_STRIDE, 0);
      this.vec(gl, a.a_age, 1, gl.FLOAT, false, BLIP_STRIDE, 12);
      this.vec(gl, a.a_size, 1, gl.FLOAT, false, BLIP_STRIDE, 16);
      this.vec(gl, a.a_color, 4, gl.UNSIGNED_BYTE, true, BLIP_STRIDE, 20);
      gl.drawArrays(gl.POINTS, 0, this.blipVerts);
      this.disableAll(gl, a);
    }

    gl.depthMask(true);
  }

  private vec(
    gl: WebGLRenderingContext,
    loc: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
  }

  /**
   * MapLibre's own draw calls assume they own the attribute state. Leaving one
   * of ours enabled makes the next layer read our buffer, which shows up as
   * torn basemap geometry rather than as an error.
   */
  private disableAll(gl: WebGLRenderingContext, attribs: Record<string, number>): void {
    for (const loc of Object.values(attribs)) {
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }
  }

  // ---- uploads ------------------------------------------------------------

  setSectors(sectors: SectorInput[]): void {
    if (!this.gl) {
      this.pendingSectors = sectors;
      return;
    }
    this.uploadSectors(sectors);
    this.map?.triggerRepaint();
  }

  private uploadSectors(sectors: SectorInput[]): void {
    const gl = this.gl!;

    let triangles = 0;
    for (const s of sectors) triangles += Math.max(0, s.vertices.length - 2);
    this.sectorVerts = triangles * 3;
    if (!this.sectorVerts) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sectorBuffer!);
      gl.bufferData(gl.ARRAY_BUFFER, new ArrayBuffer(0), gl.DYNAMIC_DRAW);
      return;
    }

    const data = new ArrayBuffer(this.sectorVerts * SECTOR_STRIDE);
    const f32 = new Float32Array(data);
    const u8 = new Uint8Array(data);
    let v = 0;

    const write = (s: SectorInput, i: number): void => {
      const base = v * (SECTOR_STRIDE / 4);
      const p = s.vertices[i];
      const apex = s.vertices[0];
      f32[base] = p[0];
      f32[base + 1] = p[1];
      f32[base + 2] = p[2];
      f32[base + 3] = apex[0];
      f32[base + 4] = apex[1];
      f32[base + 5] = s.radii[i] ?? 0;
      f32[base + 6] = s.intensity;
      f32[base + 7] = s.sweep;
      f32[base + 8] = s.cameraIndex;
      const c = v * SECTOR_STRIDE + 36;
      u8[c] = Math.round(s.color[0] * 255);
      u8[c + 1] = Math.round(s.color[1] * 255);
      u8[c + 2] = Math.round(s.color[2] * 255);
      u8[c + 3] = 255;
      v++;
    };

    // The fan the isovist's star-shape earns us.
    for (const s of sectors) {
      for (let i = 1; i < s.vertices.length - 1; i++) {
        write(s, 0);
        write(s, i);
        write(s, i + 1);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.sectorBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  setBlips(blips: BlipInput[]): void {
    if (!this.gl) {
      this.pendingBlips = blips;
      return;
    }
    this.uploadBlips(blips);
    this.map?.triggerRepaint();
  }

  private uploadBlips(blips: BlipInput[]): void {
    const gl = this.gl!;
    this.blipVerts = blips.length;

    const data = new ArrayBuffer(Math.max(1, this.blipVerts) * BLIP_STRIDE);
    const f32 = new Float32Array(data);
    const u8 = new Uint8Array(data);

    blips.forEach((b, v) => {
      const base = v * (BLIP_STRIDE / 4);
      f32[base] = b.position[0];
      f32[base + 1] = b.position[1];
      f32[base + 2] = b.position[2];
      f32[base + 3] = b.age;
      f32[base + 4] = b.size;
      const c = v * BLIP_STRIDE + 20;
      u8[c] = Math.round(b.color[0] * 255);
      u8[c + 1] = Math.round(b.color[1] * 255);
      u8[c + 2] = Math.round(b.color[2] * 255);
      u8[c + 3] = 255;
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, this.blipBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }
}
