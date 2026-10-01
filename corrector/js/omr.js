// Lectura óptica de marcas (OMR) sin dependencias externas.
// Entrada: píxeles RGBA de la foto. Todo se procesa en el dispositivo.
//
// Pasos:
//  1. Gris = mínimo de R,G,B (las tintas azules/negras quedan oscuras; el papel, claro).
//  2. Umbral adaptativo + componentes conexas -> 4 cuadrados negros de esquina.
//  3. Homografía hoja(mm) -> foto(px); se prueba la rotación usando la marca de orientación.
//  4. Se "endereza" la hoja a 5 px/mm y se normaliza la iluminación localmente.
//  5. Por casillero se mide la tinta; por pregunta se compara contra el casillero más limpio.

import { A4, FIDUCIALS, FIDUCIAL_SIZE, ORIENT, buildLayout } from './layout.js';

export const PX_PER_MM = 5;

// Umbrales de decisión (calibrados con tests/synthetic.test.js).
export const THRESHOLDS = {
  ink: 0.12, // oscurecimiento relativo mínimo de un píxel para contar como tinta
  mark: 0.005, // tinta extra (sobre la opción más limpia) desde la cual una opción está marcada
  empty: 0.0008, // por debajo de esto, la opción está vacía; entre ambos, dudosa
  band: 0.04, // tinta extra sobre el borde impreso (vs. ítems vecinos) que obliga a revisar
  bandRel: 1.45, // ...y al menos 45 % más que la referencia
  outline: 0.05, // tinta mínima típica del borde impreso (verifica que la grilla coincide)
};

export class OMRError extends Error {}

export function toGray({ data, width, height }) {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const r = data[j], gg = data[j + 1], b = data[j + 2];
    g[i] = r < gg ? (r < b ? r : b) : gg < b ? gg : b;
  }
  return { w: width, h: height, g };
}

export function integral(g, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

export function boxMean(I, w, h, x, y, r) {
  const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
  const x1 = Math.min(w, x + r + 1), y1 = Math.min(h, y + r + 1);
  const W = w + 1;
  const s = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  return s / ((x1 - x0) * (y1 - y0));
}

// ---------- 1. Marcas de esquina ----------

export function findFiducials({ w, h, g }) {
  const I = integral(g, w, h);
  const r = Math.max(8, Math.round(Math.min(w, h) / 14));
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (g[i] < 0.75 * boxMean(I, w, h, x, y, r)) dark[i] = 1;
    }
  }

  const minArea = Math.pow(Math.min(w, h) / 90, 2);
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || label[start]) continue;
    let sp = 0, area = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    stack[sp++] = start;
    label[start] = next;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      area++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && dark[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && dark[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && dark[i - w] && !label[i - w]) { label[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && dark[i + w] && !label[i + w]) { label[i + w] = next; stack[sp++] = i + w; }
    }
    next++;
    if (area < minArea) continue;
    if (minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) continue; // toca el borde
    const cx = sx / area, cy = sy / area;
    const mxx = sxx / area - cx * cx, myy = syy / area - cy * cy, mxy = sxy / area - cx * cy;
    // (mu20+mu02)/area^2 = 1/6 para un cuadrado macizo, sin importar el giro.
    const J = (mxx + myy) / area;
    const tr = mxx + myy, det = mxx * myy - mxy * mxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const elong = (tr / 2 + disc) / Math.max(1e-9, tr / 2 - disc);
    if (J < 0.145 || J > 0.21 || elong > 2.2) continue;
    comps.push({ x: cx, y: cy, area });
  }

  comps.sort((a, b) => b.area - a.area);
  if (comps.length < 4) throw new OMRError('No se encontraron los 4 cuadrados negros de las esquinas. Encuadrá la hoja completa.');
  return comps.slice(0, 8);
}

// ---------- 2. Homografía ----------

function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new OMRError('Geometría de la hoja degenerada.');
    for (let r = c + 1; r < n; r++) {
      const k = A[r][c] / A[c][c];
      for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  return x;
}

export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function project(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

function bilinear({ w, h, g }, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 255;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = g[y0 * w + x0], b = g[y0 * w + x1], c = g[y1 * w + x0], d = g[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function meanAround(img, H, cx, cy, half) {
  let s = 0, n = 0;
  for (let dy = -half; dy <= half; dy += half / 3) {
    for (let dx = -half; dx <= half; dx += half / 3) {
      const [u, v] = project(H, cx + dx, cy + dy);
      s += bilinear(img, u, v); n++;
    }
  }
  return s / n;
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function* combinations(n, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < n; i++) yield* combinations(n, k, i + 1, [...acc, i]);
}

// Elige, entre los candidatos, los 4 que forman una hoja geométricamente coherente:
// el área de cada cuadrado detectado debe coincidir con la que predice la perspectiva,
// y la marca de orientación debe aparecer donde corresponde. Si nada cierra, se rechaza
// la foto: es preferible pedir otra foto que leer mal una hoja entera.
export function locateSheet(img) {
  const cand = findFiducials(img);
  const s = FIDUCIAL_SIZE / 2;
  let best = null;
  for (const idx of combinations(cand.length, 4)) {
    const pts = idx.map((i) => cand[i]);
    const mx = pts.reduce((t, p) => t + p.x, 0) / 4, my = pts.reduce((t, p) => t + p.y, 0) / 4;
    pts.sort((a, b) => Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx));
    const quadArea = polyArea(pts.map((p) => [p.x, p.y]));
    if (quadArea < 0.1 * img.w * img.h) continue;
    const areas = pts.map((p) => p.area);
    if (Math.max(...areas) / Math.min(...areas) > 2.2) continue; // tamaños incompatibles
    const side = (i) => Math.hypot(pts[(i + 1) % 4].x - pts[i].x, pts[(i + 1) % 4].y - pts[i].y);
    const [s0, s1, s2, s3] = [0, 1, 2, 3].map(side);
    if (Math.max(s0, s2) / Math.min(s0, s2) > 1.6 || Math.max(s1, s3) / Math.min(s1, s3) > 1.6) continue;
    const aspect = (s0 + s2) / (s1 + s3); // A4 entre centros de marcas: 178/265 = 0.67 (o su inversa si está girada)
    if (Math.min(aspect, 1 / aspect) < 0.45 || Math.min(aspect, 1 / aspect) > 0.9) continue;
    for (let rot = 0; rot < 4; rot++) {
      const dst = [0, 1, 2, 3].map((i) => pts[(i + rot) % 4]);
      const H = homography(FIDUCIALS, dst.map((p) => [p.x, p.y]));
      let err = 0;
      for (let i = 0; i < 4; i++) {
        const [fx, fy] = FIDUCIALS[i];
        const sq = [[fx - s, fy - s], [fx + s, fy - s], [fx + s, fy + s], [fx - s, fy + s]].map(([x, y]) => project(H, x, y));
        err = Math.max(err, Math.abs(Math.log(dst[i].area / polyArea(sq))));
      }
      if (err > 0.45) continue; // un cuadrado de área muy distinta a la esperada: no es una esquina
      const mark = meanAround(img, H, ORIENT.x, ORIENT.y, ORIENT.size * 0.3);
      const paper = meanAround(img, H, ORIENT.x + 9, ORIENT.y, 1.5);
      const contrast = paper - mark;
      if (contrast < 0.25 * paper) continue;
      const score = contrast / paper - err;
      if (!best || score > best.score) best = { H, score };
    }
  }
  if (!best) {
    throw new OMRError('No se pudo ubicar la hoja: verificá que se vean los 4 cuadrados negros y el cuadradito de orientación, sin sombras fuertes encima.');
  }
  return best.H;
}

// ---------- 3. Hoja enderezada y normalizada ----------

export function rectify(img, H, R = PX_PER_MM) {
  const W = Math.round(A4.w * R), Ht = Math.round(A4.h * R);
  const g = new Uint8ClampedArray(W * Ht);
  for (let v = 0; v < Ht; v++) {
    for (let u = 0; u < W; u++) {
      const [x, y] = project(H, (u + 0.5) / R, (v + 0.5) / R);
      g[v * W + u] = bilinear(img, x, y);
    }
  }
  return { w: W, h: Ht, g, R };
}

// Oscurecimiento relativo al papel circundante (0 = papel, 1 = negro).
export function darkness({ w, h, g, R }) {
  // Fondo local = media de los píxeles claros en una ventana de ~12 mm.
  // Se estima en dos pasadas: media cruda y luego media sólo de lo que no es tinta.
  const I = integral(g, w, h);
  const r = Math.round(6 * R);
  const masked = new Uint8ClampedArray(g.length);
  const keep = new Uint8Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = boxMean(I, w, h, x, y, r);
      if (g[i] >= 0.85 * m) { masked[i] = g[i]; keep[i] = 1; }
    }
  }
  const I2 = integral(masked, w, h);
  const K = integral(keep, w, h);
  const d = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const cnt = boxMean(K, w, h, x, y, r);
      const bg = cnt > 0.05 ? boxMean(I2, w, h, x, y, r) / cnt : boxMean(I, w, h, x, y, r);
      d[i] = bg > 1 ? Math.max(0, Math.min(1, (bg - g[i]) / bg)) : 0;
    }
  }
  return { w, h, d, R };
}

// Tinta manuscrita en la región del casillero. Se excluye una franja alrededor del
// borde impreso: su aporte varía con la luz y enmascararía cruces finas.
export const OUTLINE_BAND = 0.6; // mm a cada lado del borde impreso

function cellInk(D, cx, cy, half, box, inkMin) {
  const { w, d, R } = D;
  const x0 = Math.round((cx - half) * R), x1 = Math.round((cx + half) * R);
  const y0 = Math.round((cy - half) * R), y1 = Math.round((cy + half) * R);
  const hb = box / 2;
  let s = 0, n = 0, sb = 0, nb = 0;
  for (let y = y0; y < y1; y++) {
    const dy = Math.abs((y + 0.5) / R - cy);
    for (let x = x0; x < x1; x++) {
      const dx = Math.abs((x + 0.5) / R - cx);
      const v = Math.max(0, d[y * w + x] - inkMin);
      if (Math.abs(Math.max(dx, dy) - hb) < OUTLINE_BAND && Math.min(dx, dy) < hb + OUTLINE_BAND) {
        sb += v; nb++;
      } else {
        s += v; n++;
      }
    }
  }
  // core: tinta fuera del borde impreso. band: tinta sobre la franja del borde.
  return { core: s / n, band: sb / Math.max(1, nb) };
}

// ---------- 4. Decisión por ítem ----------
// Cada opción se compara con la opción más limpia del mismo ítem (misma impresión,
// misma luz). Resultado por opción: marcada, vacía o dudosa. Nunca se decide en
// silencio un caso dudoso: queda "a revisar" para el docente.

export function decide(scores, expected = 1, T = THRESHOLDS, neighbourBase = Infinity, band = null, bandRef = 0) {
  // Si TODAS las opciones están marcadas, la más limpia ya no es papel: se usa la
  // referencia de los ítems vecinos.
  const rowMin = Math.min(...scores);
  const base = rowMin - neighbourBase > T.mark ? neighbourBase : rowMin;
  const delta = scores.map((s) => s - base);
  const marked = [], doubtful = [];
  // Tinta extra sobre el borde impreso (p. ej. un círculo dibujado justo encima del
  // borde): no decide por sí sola, pero manda el ítem a revisión.
  const bandHigh = (k) => band && band[k] - bandRef >= T.band && band[k] >= T.bandRel * bandRef;
  delta.forEach((d, k) => {
    if (d >= T.mark) marked.push(k);
    else if (d >= T.empty || bandHigh(k)) doubtful.push(k);
  });
  let status = 'ok';
  if (doubtful.length || marked.length > expected) status = 'review';
  else if (!marked.length) status = 'blank';
  return { marked, doubtful, status, delta };
}

export function readSheet(imageData, items, T = THRESHOLDS) {
  const img = toGray(imageData);
  const H = locateSheet(img);
  const rect = rectify(img, H);
  const D = darkness(rect);
  const L = buildLayout(items);
  const cells = L.questions.map((q) => q.cells.map((c) => cellInk(D, c.x, c.y, L.roi, L.box, T.ink)));
  const allScores = cells.map((row) => row.map((c) => c.core));
  const rowMins = allScores.map((s) => Math.min(...s));
  // Verificación final: los bordes impresos de los casilleros tienen que estar donde
  // la grilla configurada dice. Si no, la foto no corresponde a este examen.
  const bands = cells.flat().map((c) => c.band).sort((a, b) => a - b);
  const outline = bands[Math.floor(bands.length / 2)];
  if (outline < T.outline) {
    throw new OMRError('La grilla de la foto no coincide con la del examen configurado. ¿Es la hoja de este examen?');
  }
  const results = allScores.map((scores, i) => {
    const band = cells[i].map((c) => c.band);
    const nbBands = cells.filter((_, j) => j !== i && Math.abs(j - i) <= 4).flat().map((c) => c.band).sort((a, b) => a - b);
    const bandRef = nbBands.length ? nbBands[Math.floor(nbBands.length / 2)] : Math.min(...band);
    const nb = rowMins.filter((_, j) => j !== i && Math.abs(j - i) <= 4).sort((a, b) => a - b);
    const nbBase = nb.length ? nb[Math.floor(nb.length / 2)] : Infinity;
    return { label: L.questions[i].label, scores, band, ...decide(scores, Math.max(1, items[i].key.length), T, nbBase, band, bandRef) };
  });
  return { layout: L, rect, results, outline };
}
