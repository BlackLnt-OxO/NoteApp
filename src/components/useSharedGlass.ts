import { useLayoutEffect, useRef, type RefObject } from 'react';
import { cardFrostRadius } from '../workspaceBackground';
import { useNoteStore } from '../store';
import { GLASS_OPTICS } from './liquidGlassFilters';
import { finishNoteMeasure, startNoteMeasure } from './noteMotionMetrics';

export const GLASS_LAYOUT_START = 'noteapp:glass-layout-start';
export const GLASS_LAYOUT_RESIZE = 'noteapp:glass-layout-resize';

const vertexSource = `#version 300 es
layout(location = 0) in vec4 bounds;
layout(location = 1) in float radius;
uniform vec2 viewport;
out vec2 positionInCard;
flat out vec2 cardSize;
flat out float cornerRadius;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  positionInCard = corner * bounds.zw;
  cardSize = bounds.zw;
  cornerRadius = radius;
  vec2 point = (bounds.xy + positionInCard) / viewport;
  gl_Position = vec4(point.x * 2.0 - 1.0, 1.0 - point.y * 2.0, 0.0, 1.0);
}`;

const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D frostedBackdrop;
uniform vec2 backdropSize;
uniform vec2 backdropOffset;
uniform vec2 pixelRatio;
uniform vec2 clipSize;
uniform vec2 viewport;
uniform float uiScale;
in vec2 positionInCard;
flat in vec2 cardSize;
flat in float cornerRadius;
out vec4 color;
void main() {
  vec2 point = vec2(gl_FragCoord.x, viewport.y * pixelRatio.y - gl_FragCoord.y) / pixelRatio;
  if (point.x > clipSize.x || point.y > clipSize.y) discard;
  vec2 center = positionInCard - cardSize * 0.5;
  vec2 curve = abs(center) - cardSize * 0.5 + cornerRadius;
  vec2 outside = max(curve, vec2(0.0));
  float diagonal = length(outside);
  float distance = diagonal + min(max(curve.x, curve.y), 0.0) - cornerRadius;
  float matte = 1.0 - smoothstep(-0.6, 0.6, distance * pixelRatio.x);
  if (matte <= 0.0) discard;
  float shorterSide = min(cardSize.x, cardSize.y);
  float bevel = min(shorterSide * 0.5, clamp(shorterSide * ${GLASS_OPTICS.bevelRatio},
    ${GLASS_OPTICS.minBevel}.0 * uiScale, ${GLASS_OPTICS.maxBevel}.0 * uiScale));
  float depth = clamp(1.0 + distance / bevel, 0.0, 1.0);
  vec2 uv = (point + backdropOffset) / backdropSize;
  vec3 material = texture(frostedBackdrop, uv).rgb;
  if (depth > 0.0) {
    vec2 normal = diagonal > 0.0 ? outside / diagonal : vec2(float(curve.x > curve.y), float(curve.x <= curve.y));
    vec2 shift = -sign(center) * normal * ${GLASS_OPTICS.bend}.0 / 255.0 * smoothstep(0.0, 1.0, depth) * uiScale / backdropSize;
    vec3 bent = vec3(
      texture(frostedBackdrop, uv + shift * ${GLASS_OPTICS.refraction - GLASS_OPTICS.dispersion}).r,
      texture(frostedBackdrop, uv + shift * ${GLASS_OPTICS.refraction}.0).g,
      texture(frostedBackdrop, uv + shift * ${GLASS_OPTICS.refraction + GLASS_OPTICS.dispersion}).b
    );
    material = mix(material, bent, smoothstep(0.0, 1.0, depth));
  }
  color = vec4(material * matte, matte);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw Error('Could not allocate glass shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw Error(gl.getShaderInfoLog(shader) ?? 'Could not compile glass shader');
  }
  return shader;
}

function createRenderer(gl: WebGL2RenderingContext) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  const instances = gl.createBuffer();
  const texture = gl.createTexture();
  if (!program || !instances || !texture) throw Error('Could not allocate shared glass');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? 'Could not link shared glass');
  gl.useProgram(program);
  const uniforms = Object.fromEntries([
    'viewport', 'backdropSize', 'backdropOffset', 'pixelRatio', 'clipSize', 'uiScale',
  ].map(name => [name, gl.getUniformLocation(program, name)]));
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'frostedBackdrop'), 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.enableVertexAttribArray(0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
  gl.vertexAttribDivisor(0, 1);
  gl.vertexAttribDivisor(1, 1);
  return {
    uniforms,
    upload(backdrop: HTMLCanvasElement) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, backdrop);
    },
    draw(data: number[]) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / 5);
    },
    dispose() {
      gl.deleteBuffer(instances);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    },
  };
}

function overlaps(a: DOMRectReadOnly, b: DOMRectReadOnly) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function overlapsDuringMove(fromA: DOMRectReadOnly, toA: DOMRectReadOnly, fromB: DOMRectReadOnly, toB: DOMRectReadOnly) {
  // All cards in a batch share one easing curve. Intersect the time ranges
  // in which their four edges overlap instead of comparing swept bounding boxes.
  let low = 0;
  let high = 1;
  for (const [start, end] of [
    [fromA.left - fromB.right, toA.left - toB.right],
    [fromB.left - fromA.right, toB.left - toA.right],
    [fromA.top - fromB.bottom, toA.top - toB.bottom],
    [fromB.top - fromA.bottom, toB.top - toA.bottom],
  ]) {
    if (start >= 0 && end >= 0) return false;
    if (start < 0 && end < 0) continue;
    const cross = start / (start - end);
    if (start >= 0) low = Math.max(low, cross);
    else high = Math.min(high, cross);
  }
  return low < high;
}

let wallpaperCache: { key: string; source: string; image: HTMLCanvasElement } | undefined;

function prepareWallpaper(source: HTMLImageElement, w: number, h: number, base: string, shade: string, frost: number, key: string) {
  if (wallpaperCache?.key === key && wallpaperCache.source === source.currentSrc) return wallpaperCache.image;
  const backdrop = document.createElement('canvas');
  const blur = document.createElement('canvas');
  backdrop.width = blur.width = w;
  backdrop.height = blur.height = h;
  const picture = backdrop.getContext('2d', { alpha: false });
  const target = blur.getContext('2d');
  if (!picture || !target) throw Error('Could not prepare shared wallpaper');
  const cover = Math.max(w / source.naturalWidth, h / source.naturalHeight);
  const width = source.naturalWidth * cover;
  const height = source.naturalHeight * cover;
  picture.fillStyle = base;
  picture.fillRect(0, 0, w, h);
  picture.drawImage(source, (w - width) / 2, (h - height) / 2, width, height);
  picture.fillStyle = shade;
  picture.fillRect(0, 0, w, h);
  target.filter = frost ? `blur(${frost}px)` : 'none';
  target.drawImage(backdrop, 0, 0);
  target.filter = 'none';
  target.globalCompositeOperation = 'destination-over';
  target.drawImage(backdrop, 0, 0);
  wallpaperCache = { key, source: source.currentSrc, image: blur };
  return blur;
}

export function useSharedGlass(viewportRef: RefObject<HTMLDivElement>, gridRef: RefObject<HTMLDivElement>, trackMotion = false) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const grid = gridRef.current;
    const workspace = viewport?.closest<HTMLElement>('[data-pointer-scope]');
    if (canvas && viewport && grid && workspace) return mountSharedGlass(canvas, viewport, grid, workspace, trackMotion);
  }, [viewportRef, gridRef, trackMotion]);
  return canvasRef;
}

function mountSharedGlass(
  canvas: HTMLCanvasElement, viewport: HTMLDivElement, grid: HTMLDivElement, workspace: HTMLElement, trackMotion: boolean,
) {
  if (!window.ResizeObserver) return;
  const webgl = canvas.getContext('webgl2', { antialias: false, failIfMajorPerformanceCaveat: true });
  if (!webgl) return;
  const gl = webgl;
  const panel = trackMotion ? viewport.closest<HTMLElement>('[data-ink-workspace]') : null;

  let renderer: ReturnType<typeof createRenderer> | undefined;
  let frame: number | undefined;
  let lost = false;
  let failed = false;
  let source: HTMLImageElement | null = null;
  let cachedBackdrop = '';
  let uploadedImage = '';
  let selected = new Set<HTMLElement>();
  let movingSvg: Set<HTMLElement> | undefined;

  function select(cards: Set<HTMLElement>) {
    for (const card of selected) if (!cards.has(card)) delete card.dataset.glassGpu;
    for (const card of cards) if (!selected.has(card)) card.dataset.glassGpu = '';
    selected = cards;
    canvas.hidden = !cards.size;
    canvas.dataset.sharedGlassCount = String(cards.size);
  }

  function schedule() {
    if (frame === undefined && !lost && !failed) frame = requestAnimationFrame(draw);
  }

  function draw() {
    frame = undefined;
    const measure = trackMotion ? startNoteMeasure() : undefined;
    try {
      render();
    } catch {
      failed = true;
      renderer?.dispose();
      renderer = undefined;
      select(new Set());
    } finally {
      finishNoteMeasure('note-shared-glass', measure);
    }
  }

  function render() {
    const image = workspace.querySelector<HTMLImageElement>('img[data-workspace-background]');
    if (source !== image) {
      source?.removeEventListener('load', schedule);
      source = image;
      source?.addEventListener('load', schedule);
    }
    const entranceMoving = grid.getAnimations().some(animation => animation.playState === 'running');
    const layoutMoving = grid.hasAttribute('data-glass-layout-pending') || grid.hasAttribute('data-grid-settling');
    if (entranceMoving || (trackMotion && layoutMoving)) schedule();
    if (!image?.complete || !image.naturalWidth || workspace.hasAttribute('data-settings-open') ||
      grid.dataset.glassEntrance === 'pending' || (!trackMotion && (layoutMoving || entranceMoving))) {
      select(new Set());
      return;
    }

    const view = viewport.getBoundingClientRect();
    const wallpaper = image.getBoundingClientRect();
    const scale = wallpaper.width / image.offsetWidth;
    if (!view.width || !view.height || !scale) {
      select(new Set());
      return;
    }
    const top = viewport.scrollTop;
    const bottom = top + viewport.clientHeight;
    const candidates: { card: HTMLElement; box: DOMRect; wrapper: HTMLElement }[] = [];
    let editorMoving = false;
    for (const wrapper of grid.children) {
      if (!(wrapper instanceof HTMLElement) || !wrapper.hasAttribute('data-grid-card-id')) continue;
      if (wrapper.hasAttribute('data-note-edit-moving')) editorMoving = true;
      const y = parseFloat(wrapper.style.top);
      if (!wrapper.hasAttribute('data-grid-layout-moving') &&
        (y >= bottom || y + parseFloat(wrapper.style.height) <= top)) continue;
      const card = wrapper.firstElementChild;
      if (!(card instanceof HTMLElement) || !card.classList.contains('liquid-glass-card')) continue;
      const box = card.getBoundingClientRect();
      if (overlaps(view, box)) candidates.push({ card, box, wrapper });
    }
    if (!layoutMoving) movingSvg = undefined;
    if (trackMotion && layoutMoving && !movingSvg) {
      movingSvg = new Set();
      const slide = candidates.map(({ card, box, wrapper }) => {
        if (!wrapper.hasAttribute('data-grid-layout-moving')) return { card, from: box, to: box };
        const x = view.left + (parseFloat(wrapper.style.left) - viewport.scrollLeft) * scale;
        const y = view.top + (parseFloat(wrapper.style.top) - viewport.scrollTop) * scale;
        return { card, from: box, to: new DOMRectReadOnly(x, y, box.width, box.height) };
      });
      for (let i = 0; i < slide.length; i++) for (let j = i + 1; j < slide.length; j++) {
        const [a, b] = [slide[i], slide[j]];
        if (!overlapsDuringMove(a.from, a.to, b.from, b.to)) continue;
        movingSvg.add(a.card);
        movingSvg.add(b.card);
      }
    }
    const cards = new Set<HTMLElement>();
    const data: number[] = [];
    for (const { card, box } of candidates) {
      if ((!trackMotion && !card.hasAttribute('data-glass-optics')) || card.hasAttribute('data-glass-placeholder') ||
        card.hasAttribute('data-selected') || card.parentElement?.hasAttribute('data-note-edit-moving') ||
        movingSvg?.has(card) ||
        candidates.some(other => other.card !== card && overlaps(box, other.box))) continue;
      cards.add(card);
      data.push(box.left - view.left, box.top - view.top, box.width, box.height,
        Math.min(parseFloat(card.style.borderRadius) * scale, box.width / 2, box.height / 2));
    }
    if (editorMoving) schedule();
    if (!cards.size) {
      select(cards);
      return;
    }

    renderer ??= createRenderer(gl);
    const dpr = window.devicePixelRatio;
    const w = Math.round(wallpaper.width * dpr);
    const h = Math.round(wallpaper.height * dpr);
    const shade = workspace.querySelector<HTMLElement>('[data-workspace-background-shade]');
    const backdropColor = getComputedStyle(image).backgroundColor;
    const shadeColor = shade ? getComputedStyle(shade).backgroundColor : 'transparent';
    const frost = cardFrostRadius(useNoteStore.getState().settings.cardFrost) * scale * dpr;
    const key = JSON.stringify([w, h, backdropColor, shadeColor, frost]);
    if (cachedBackdrop !== key || uploadedImage !== image.currentSrc) {
      const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (!w || !h || w > maxSize || h > maxSize) {
        select(new Set());
        return;
      }
      const measure = trackMotion ? startNoteMeasure() : undefined;
      renderer.upload(prepareWallpaper(image, w, h, backdropColor, shadeColor, frost, key));
      finishNoteMeasure('note-wallpaper-upload', measure);
      if (gl.getError() !== gl.NO_ERROR) throw Error('Could not upload shared backdrop');
      cachedBackdrop = key;
      uploadedImage = image.currentSrc;
    }

    const outputWidth = panel ? Math.max(view.width, panel.clientWidth * scale) : view.width;
    const outputHeight = panel ? Math.max(view.height, panel.clientHeight * scale) : view.height;
    const canvasWidth = Math.round(outputWidth * dpr);
    const canvasHeight = Math.round(outputHeight * dpr);
    if (panel) {
      const cssWidth = `${outputWidth / scale}px`;
      const cssHeight = `${outputHeight / scale}px`;
      if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
      if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
    }
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    const u = renderer.uniforms;
    gl.uniform2f(u.viewport, outputWidth, outputHeight);
    gl.uniform2f(u.backdropSize, wallpaper.width, wallpaper.height);
    gl.uniform2f(u.backdropOffset, view.left - wallpaper.left, view.top - wallpaper.top);
    gl.uniform2f(u.pixelRatio, canvasWidth / outputWidth, canvasHeight / outputHeight);
    gl.uniform2f(u.clipSize, viewport.clientWidth * scale, view.height);
    gl.uniform1f(u.uiScale, scale);
    renderer.draw(data);
    select(cards);
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport);
  resize.observe(workspace);
  const mutations = new MutationObserver(records => {
    if (records.some(record => {
      if (record.target === grid || record.target === workspace || record.target === document.documentElement) return true;
      if (!(record.target instanceof HTMLElement)) return false;
      if (record.target.parentElement === grid) return true;
      return record.type === 'attributes' && record.attributeName !== 'style';
    })) schedule();
  });
  mutations.observe(grid, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['style', 'data-glass-optics', 'data-glass-placeholder', 'data-selected', 'data-glass-entrance', 'data-glass-layout-pending', 'data-grid-settling', 'data-note-edit-moving'] });
  mutations.observe(workspace, { attributes: true, childList: true, attributeFilter: ['style', 'data-settings-open'] });
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const unsubscribe = useNoteStore.subscribe((state, previous) => {
    if (state.settings.cardFrost !== previous.settings.cardFrost || state.settings.backgroundImage !== previous.settings.backgroundImage) schedule();
  });
  const lose = (event: Event) => {
    event.preventDefault();
    lost = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    renderer = undefined;
    cachedBackdrop = '';
    select(new Set());
  };
  const restore = () => { lost = false; failed = false; schedule(); };
  const suspend = () => {
    movingSvg = undefined;
    if (trackMotion) schedule();
    else select(new Set());
  };
  const syncResize = () => {
    if (lost || failed) return;
    if (frame !== undefined) cancelAnimationFrame(frame);
    draw();
  };
  grid.addEventListener(GLASS_LAYOUT_START, suspend);
  grid.addEventListener(GLASS_LAYOUT_RESIZE, syncResize);
  canvas.addEventListener('webglcontextlost', lose);
  canvas.addEventListener('webglcontextrestored', restore);
  viewport.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  schedule();
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    source?.removeEventListener('load', schedule);
    resize.disconnect();
    mutations.disconnect();
    unsubscribe();
    grid.removeEventListener(GLASS_LAYOUT_START, suspend);
    grid.removeEventListener(GLASS_LAYOUT_RESIZE, syncResize);
    canvas.removeEventListener('webglcontextlost', lose);
    canvas.removeEventListener('webglcontextrestored', restore);
    viewport.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    select(new Set());
    renderer?.dispose();
  };
}
