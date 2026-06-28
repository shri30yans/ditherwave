import { VERT } from './shaders/vertex';
import { BAYER } from './shaders/bayer';
import { FLOYD } from './shaders/floyd';
import { DOTS } from './shaders/dots';
import { ASCII } from './shaders/ascii';
import { program, quadVAO, createTex, parseColor } from './gl';
import { buildAtlas } from './atlas';
import type { DitherMode, DitherOptions, DitherHandle } from './types';

const DEFAULTS: Required<Omit<DitherOptions, 'charset'>> & { charset: string } = {
  mode: 'bayer',
  resolution: 256,
  palette: ['#0f0f10', '#f5f3ef'],
  intensity: 1,
  animate: false,
  matrixSize: 8,
  charset: ' .:-=+*#%@',
  contrast: 1,
  brightness: 1,
  pauseOffscreen: true,
  pixelRatio: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1,
};

// All uniform names used across every shader. Queried once after program link
// and stored in a per-mode cache; never called inside the render loop.
const UNIFORM_NAMES = [
  'u_src', 'u_pal', 'u_res', 'u_time', 'u_intensity',
  'u_contrast', 'u_brightness', 'u_paletteCount',
  'u_matrixSize', 'u_atlas', 'u_charCount', 'u_cell',
] as const;

type UniformName = typeof UNIFORM_NAMES[number];
type UniformCache = Record<UniformName, WebGLUniformLocation | null>;

type Source = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

function isImg(el: Element): el is HTMLImageElement {
  return (el as HTMLElement).tagName === 'IMG';
}
function isVideo(el: Element): el is HTMLVideoElement {
  return (el as HTMLElement).tagName === 'VIDEO';
}
function isCanvas(el: Element): el is HTMLCanvasElement {
  return (el as HTMLElement).tagName === 'CANVAS';
}

export function createDither(target: HTMLCanvasElement, source: Source, opts: DitherOptions = {}): DitherHandle {
  let options = { ...DEFAULTS, ...opts };

  const gl = target.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 not supported');

  const progs: Record<DitherMode, WebGLProgram> = {
    bayer: program(gl, VERT, BAYER),
    floyd: program(gl, VERT, FLOYD),
    dots: program(gl, VERT, DOTS),
    ascii: program(gl, VERT, ASCII),
  };

  // Cache all uniform locations once per program immediately after linking.
  // getUniformLocation is a synchronous driver call that can stall the GPU
  // command queue — calling it inside the render loop was the primary perf bug.
  const uniforms = {} as Record<DitherMode, UniformCache>;
  for (const mode of Object.keys(progs) as DitherMode[]) {
    const cache = {} as UniformCache;
    for (const name of UNIFORM_NAMES) {
      cache[name] = gl.getUniformLocation(progs[mode], name);
    }
    uniforms[mode] = cache;
  }

  const vao = quadVAO(gl);
  const srcTex = createTex(gl, { filter: gl.LINEAR });
  const palTex = createTex(gl, { filter: gl.NEAREST });
  const atlasTex = createTex(gl, { filter: gl.LINEAR });

  // Initialise srcTex with a 1×1 transparent pixel so the first few RAFs
  // before a video frame / image load have valid (rather than undefined)
  // texture state. Avoids garbage flashing when wrapping <video> sources.
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));

  let atlasCanvas: HTMLCanvasElement | null = null;
  let charCount = options.charset.length;

  function uploadPalette(colors: string[]): number {
    const n = Math.max(2, Math.min(8, colors.length));
    const buf = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = parseColor(colors[i] || '#000');
      buf[i * 4 + 0] = Math.round(r * 255);
      buf[i * 4 + 1] = Math.round(g * 255);
      buf[i * 4 + 2] = Math.round(b * 255);
      buf[i * 4 + 3] = 255;
    }
    gl!.bindTexture(gl!.TEXTURE_2D, palTex);
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, n, 1, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, buf);
    return n;
  }

  function uploadAtlas(charset: string) {
    atlasCanvas = buildAtlas(charset);
    charCount = charset.length;
    gl!.bindTexture(gl!.TEXTURE_2D, atlasTex);
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, atlasCanvas);
  }

  let paletteCount = uploadPalette(options.palette);
  uploadAtlas(options.charset);

  function sourceSize(): { w: number; h: number } {
    let sw = 0, sh = 0;
    if (isImg(source)) { sw = source.naturalWidth; sh = source.naturalHeight; }
    else if (isVideo(source)) { sw = source.videoWidth; sh = source.videoHeight; }
    else { sw = source.width; sh = source.height; }
    if (!sw || !sh) { sw = 640; sh = 360; }
    return { w: sw, h: sh };
  }

  // Apply a CSS pixel size to the backing canvas buffer, accounting for DPR.
  // Called once at init and then exclusively by ResizeObserver — never inside
  // the render loop, so it never causes per-frame layout reads.
  function applySize(cssW: number, cssH: number) {
    const { w: sw, h: sh } = sourceSize();
    const cw = cssW || sw;
    const ch = cssH || sh;
    const dpr = options.pixelRatio;
    const pw = Math.max(1, Math.floor(cw * dpr));
    const ph = Math.max(1, Math.floor(ch * dpr));
    if (target.width !== pw) target.width = pw;
    if (target.height !== ph) target.height = ph;
  }

  // Bootstrap canvas size with a single layout read (acceptable — happens
  // once, not per frame). ResizeObserver handles all subsequent changes.
  const refEl = target.parentElement ?? target;
  const { w: sw, h: sh } = sourceSize();
  applySize(refEl.clientWidth || sw, refEl.clientHeight || sh);

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      applySize(e.contentRect.width, e.contentRect.height);
      // Re-render static image immediately when its container resizes.
      if (!options.animate && isImg(source) && imgLoaded) {
        needsDraw = true;
        if (raf === 0) raf = requestAnimationFrame(tick);
      }
    }
  });
  ro.observe(refEl);

  function uploadSource() {
    gl!.bindTexture(gl!.TEXTURE_2D, srcTex);
    gl!.pixelStorei(gl!.UNPACK_ALIGNMENT, 1);
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, source as TexImageSource);
    } catch {
      // Source not ready yet (video with no frame, img not loaded).
    }
    gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, false);
  }

  let imgLoaded = false;
  if (isImg(source)) {
    if (source.complete && source.naturalWidth > 0) {
      imgLoaded = true;
      uploadSource();
    } else {
      source.addEventListener('load', () => {
        imgLoaded = true;
        uploadSource();
        needsDraw = true;
        if (raf === 0) raf = requestAnimationFrame(tick);
      }, { once: true });
    }
  } else {
    imgLoaded = true;
  }

  let visible = true;
  let io: IntersectionObserver | null = null;
  if (options.pauseOffscreen && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) visible = e.isIntersecting;
    }, { threshold: 0 });
    io.observe(target);
  }

  const start = performance.now();
  let raf = 0;
  let vfc = 0;

  // Signals that the output has changed and a redraw is needed.
  // For animated / video / canvas sources this is always true; for static
  // images with animate:false it flips to false after the first draw so the
  // RAF loop can stop instead of spinning at 60 fps producing identical frames.
  let needsDraw = true;

  function draw() {
    if (!gl) return;

    const mode = options.mode;
    const prog = progs[mode];
    const u = uniforms[mode];

    gl.useProgram(prog);
    gl.bindVertexArray(vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    if (u.u_src) gl.uniform1i(u.u_src, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, palTex);
    if (u.u_pal) gl.uniform1i(u.u_pal, 1);

    if (u.u_res) gl.uniform2f(u.u_res, options.resolution, options.resolution);
    if (u.u_time) gl.uniform1f(u.u_time, options.animate ? (performance.now() - start) / 1000 : 0);
    if (u.u_intensity) gl.uniform1f(u.u_intensity, options.intensity);
    if (u.u_contrast) gl.uniform1f(u.u_contrast, options.contrast);
    if (u.u_brightness) gl.uniform1f(u.u_brightness, options.brightness);
    if (u.u_paletteCount) gl.uniform1f(u.u_paletteCount, paletteCount);

    if (mode === 'bayer' && u.u_matrixSize) {
      gl.uniform1f(u.u_matrixSize, options.matrixSize);
    }

    if (mode === 'ascii') {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      if (u.u_atlas) gl.uniform1i(u.u_atlas, 2);
      if (u.u_charCount) gl.uniform1f(u.u_charCount, charCount);
      if (u.u_cell) {
        const aspect = target.width / target.height;
        const cellX = Math.max(4, Math.floor(options.resolution / 4));
        const cellY = Math.max(4, Math.floor(cellX / aspect));
        gl.uniform2f(u.u_cell, cellX, cellY);
      }
    }

    gl.viewport(0, 0, target.width, target.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible || !imgLoaded || !needsDraw) return;

    if (isVideo(source) && source.readyState >= 2) uploadSource();
    else if (isCanvas(source)) uploadSource();

    draw();

    // Static images with animate:false produce an identical frame every tick.
    // Stop the loop after the first successful draw; ResizeObserver and
    // setOptions() will restart it when the output actually needs to change.
    if (!options.animate && isImg(source)) {
      needsDraw = false;
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  raf = requestAnimationFrame(tick);

  // Use requestVideoFrameCallback if available for tear-free video sampling.
  function vidTick() {
    if (isVideo(source) && 'requestVideoFrameCallback' in source) {
      vfc = (source as HTMLVideoElement).requestVideoFrameCallback(() => {
        uploadSource();
        vidTick();
      });
    }
  }
  vidTick();

  const onLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
  };
  // On context restore the engine doesn't auto-rebuild — the host has to
  // re-instantiate via createDither. Listener is registered so the default
  // browser handler doesn't run, but we don't log; consumers who care can
  // listen on the canvas themselves.
  const onRestored = () => {};
  target.addEventListener('webglcontextlost', onLost);
  target.addEventListener('webglcontextrestored', onRestored);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (io) io.disconnect();
      target.removeEventListener('webglcontextlost', onLost);
      target.removeEventListener('webglcontextrestored', onRestored);
      if (isVideo(source) && 'cancelVideoFrameCallback' in source && vfc) {
        (source as HTMLVideoElement).cancelVideoFrameCallback(vfc);
      }
      gl.deleteTexture(srcTex);
      gl.deleteTexture(palTex);
      gl.deleteTexture(atlasTex);
      (Object.values(progs) as WebGLProgram[]).forEach((p) => gl.deleteProgram(p));
    },
    setOptions(next: Partial<DitherOptions>) {
      const prevPalette = options.palette;
      const prevCharset = options.charset;
      options = { ...options, ...next };
      if (next.palette && next.palette !== prevPalette) paletteCount = uploadPalette(options.palette);
      if (next.charset && next.charset !== prevCharset) uploadAtlas(options.charset);
      if (next.pixelRatio !== undefined) {
        applySize(refEl.clientWidth, refEl.clientHeight);
      }
      // Any option change invalidates a previously static frame.
      needsDraw = true;
      if (raf === 0 && imgLoaded) raf = requestAnimationFrame(tick);
    },
    render() {
      needsDraw = true;
      draw();
    },
  };
}
