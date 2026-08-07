import maplibregl, { type CustomLayerInterface, type Map as MlMap } from 'maplibre-gl';
import type { LevelConfig, LngLat } from '../types';
import { MOTION } from '../theme';

/**
 * Floor plans as textured quads at altitude.
 *
 * MapLibre's `image` source is welded to the ground, which makes the whole
 * exploded multi-storey view impossible: two plans at ground level are two
 * plans fighting for the same pixels. Drawing them as quads at an arbitrary
 * altitude is about a hundred lines and unlocks the entire indoor half of the
 * card — storeys that separate vertically, fade independently, and share a
 * depth order with the sectors.
 *
 * Outdoors is simply a level at elevation 0 with no plan; the basemap is the
 * floor.
 */

const VS = `
precision highp float;
attribute vec3 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 1.0);
}
`;

const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform float u_opacity;
void main() {
  vec4 c = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(c.rgb * c.a * u_opacity, c.a * u_opacity);
}
`;

/** Corner order the config documents: top-left, top-right, bottom-right, bottom-left. */
const UV: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

interface Plan {
  levelId: string;
  url: string;
  texture: WebGLTexture | null;
  buffer: WebGLBuffer | null;
  opacity: number;
  target: number;
}

function compile(gl: WebGLRenderingContext): WebGLProgram {
  const build = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`Sémaphore plan shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
  };
  const p = gl.createProgram()!;
  const v = build(gl.VERTEX_SHADER, VS);
  const f = build(gl.FRAGMENT_SHADER, FS);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Sémaphore plan program: ${gl.getProgramInfoLog(p)}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  return p;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // WebGL refuses to sample a texture from an origin that did not opt in, so
    // a cross-origin plan needs CORS. Same-origin `/local/...` — the normal
    // case in Home Assistant — must not set it, or some setups reject the
    // request outright.
    try {
      if (new URL(url, location.href).origin !== location.origin) {
        img.crossOrigin = 'anonymous';
      }
    } catch {
      /* relative URL: same origin by definition */
    }
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export class PlanLayer implements CustomLayerInterface {
  readonly id = 'semaphore-plans';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private gl?: WebGLRenderingContext;
  private map?: MlMap;
  private program?: WebGLProgram;
  private plans: Plan[] = [];
  private textures = new Map<string, WebGLTexture>();
  private lastFrame = 0;

  private attribs: Record<string, number> = {};
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  /** Pending level state that arrived before the GL context did. */
  private pending: { levels: LevelConfig[]; explode: number } | null = null;

  onAdd(map: MlMap, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.program = compile(gl);
    for (const n of ['a_pos', 'a_uv']) {
      this.attribs[n] = gl.getAttribLocation(this.program, n);
    }
    for (const n of ['u_matrix', 'u_texture', 'u_opacity']) {
      this.uniforms[n] = gl.getUniformLocation(this.program, n);
    }
    if (this.pending) {
      const { levels, explode } = this.pending;
      this.pending = null;
      void this.setLevels(levels, explode);
    }
  }

  onRemove(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const p of this.plans) if (p.buffer) gl.deleteBuffer(p.buffer);
    for (const t of this.textures.values()) gl.deleteTexture(t);
    if (this.program) gl.deleteProgram(this.program);
    this.textures.clear();
    this.plans = [];
    this.gl = undefined;
  }

  /** True while any plan is mid-fade — one of the reasons the rAF loop lives. */
  get animating(): boolean {
    return this.plans.some((p) => Math.abs(p.opacity - p.target) > 0.004);
  }

  /**
   * Rebuilds the quads. `explode` lifts level *n* by *n × explode* metres, the
   * same stacking the room geometry uses, so walls and plans never drift apart.
   */
  async setLevels(levels: LevelConfig[], explode: number): Promise<void> {
    if (!this.gl) {
      this.pending = { levels, explode };
      return;
    }
    const gl = this.gl;
    const next: Plan[] = [];

    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const plan = level.plan;
      if (!plan?.url || plan.corners?.length < 4) continue;

      const texture = await this.texture(plan.url);
      if (!texture) continue;

      const altitude = level.elevation + explode * i;
      const previous = this.plans.find((p) => p.levelId === level.id);
      const buffer = previous?.buffer ?? gl.createBuffer();
      this.writeQuad(buffer!, plan.corners, altitude);

      next.push({
        levelId: level.id,
        url: plan.url,
        texture,
        buffer,
        // A rebuilt plan keeps whatever opacity it had, so changing altitude
        // does not make every storey flash.
        opacity: previous?.opacity ?? 0,
        target: previous?.target ?? plan.opacity ?? 0.9,
      });
    }

    for (const old of this.plans) {
      if (!next.some((p) => p.buffer === old.buffer) && old.buffer) {
        gl.deleteBuffer(old.buffer);
      }
    }
    this.plans = next;
    this.map?.triggerRepaint();
  }

  /** Target opacity per level id. Anything omitted fades out. */
  setVisibility(visibility: Record<string, number>): void {
    for (const p of this.plans) p.target = visibility[p.levelId] ?? 0;
    this.map?.triggerRepaint();
  }

  private async texture(url: string): Promise<WebGLTexture | null> {
    const cached = this.textures.get(url);
    if (cached) return cached;

    const img = await loadImage(url);
    const gl = this.gl;
    if (!img || !gl) return null;

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Plans are arbitrary sizes, so no mipmaps and clamped wrapping — the
    // non-power-of-two rules in WebGL 1 allow nothing else.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    this.textures.set(url, tex);
    return tex;
  }

  private writeQuad(buffer: WebGLBuffer, corners: LngLat[], altitude: number): void {
    const gl = this.gl!;
    const merc = corners.slice(0, 4).map((c) =>
      maplibregl.MercatorCoordinate.fromLngLat({ lng: c[0], lat: c[1] }, altitude),
    );

    const data = new Float32Array(6 * 5);
    // Two triangles, TL-TR-BR and TL-BR-BL.
    const order = [0, 1, 2, 0, 2, 3];
    order.forEach((idx, i) => {
      const m = merc[idx];
      const uv = UV[idx];
      data[i * 5] = m.x;
      data[i * 5 + 1] = m.y;
      data[i * 5 + 2] = m.z ?? 0;
      data[i * 5 + 3] = uv[0];
      data[i * 5 + 4] = uv[1];
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  private static resolveMatrix(arg: unknown): Float32Array | number[] {
    if (arg instanceof Float32Array || Array.isArray(arg)) return arg;
    const data = (arg as any)?.defaultProjectionData;
    return data?.mainMatrix ?? (arg as any)?.mainMatrix ?? IDENTITY;
  }

  render(gl: WebGLRenderingContext, arg: unknown): void {
    if (!this.program || !this.plans.length) return;

    const now = performance.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;
    const step = dt / MOTION.scene;

    const matrix = PlanLayer.resolveMatrix(arg);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uniforms.u_matrix, false, matrix as Float32Array);
    gl.uniform1i(this.uniforms.u_texture, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);

    for (const plan of this.plans) {
      const delta = plan.target - plan.opacity;
      plan.opacity += Math.abs(delta) < 0.004 ? delta : delta * Math.min(1, step * 3);
      if (plan.opacity <= 0.004 || !plan.texture || !plan.buffer) continue;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plan.texture);
      gl.uniform1f(this.uniforms.u_opacity, plan.opacity);

      gl.bindBuffer(gl.ARRAY_BUFFER, plan.buffer);
      if (this.attribs.a_pos >= 0) {
        gl.enableVertexAttribArray(this.attribs.a_pos);
        gl.vertexAttribPointer(this.attribs.a_pos, 3, gl.FLOAT, false, 20, 0);
      }
      if (this.attribs.a_uv >= 0) {
        gl.enableVertexAttribArray(this.attribs.a_uv);
        gl.vertexAttribPointer(this.attribs.a_uv, 2, gl.FLOAT, false, 20, 12);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    for (const loc of Object.values(this.attribs)) {
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }
    gl.depthMask(true);
  }
}
