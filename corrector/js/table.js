// Lectura de una hoja de respuestas con formato de TABLA (p. ej. la hoja de Word del
// examen): no necesita marcas de esquina, usa las propias líneas de la tabla como
// referencia. Cada celda se ubica por la intersección de sus 4 líneas, así que
// tolera foto torcida, en perspectiva y sin centrar.
//
// Estructura esperada: una o más tablas con columnas  N.º | a | b | c | d | e ,
// la primera fila es encabezado. Las filas se leen tabla por tabla, de izquierda a
// derecha y de arriba hacia abajo, y se asignan en orden a las líneas de la clave
// (las filas de desarrollo se declaran en la clave con opciones "-").

import { toGray, integral, boxMean, decide, OMRError } from './omr.js';

export const TABLE_THRESHOLDS = {
  mark: 0.12, // oscurecimiento del 15 % más oscuro (sobre la celda más limpia) para considerar marcada
  empty: 0.07, // por debajo: vacía; entre ambos: dudosa -> revisar
  numbers: 0.12, // tinta mínima de la columna N.º (verifica la orientación)
};

const INSET = 0.2; // margen interno de la celda que no se mide (evita las líneas)

// ---------- Segmentos de línea ----------

function darkMask({ w, h, g }) {
  const I = integral(g, w, h);
  const r = Math.max(6, Math.round(Math.max(w, h) / 50));
  const dark = new Uint8Array(w * h);
  // Se ignora una franja junto al borde de la imagen (viñeteo, bordes de la foto).
  const m = Math.round(0.01 * Math.max(w, h)) + 2;
  for (let y = m; y < h - m; y++) {
    for (let x = m; x < w - m; x++) {
      const i = y * w + x;
      if (g[i] < 0.8 * boxMean(I, w, h, x, y, r)) dark[i] = 1;
    }
  }
  return dark;
}

// Píxeles oscuros que forman parte de una corrida larga en la dirección dada,
// tolerando ±1 px de desvío (líneas levemente inclinadas) y huecos cortos
// (impresión gastada, fotocopias, compresión de la foto).
const MAX_GAP = 3;
function runMask(dark, w, h, horizontal, minRun) {
  const out = new Uint8Array(w * h);
  const [n, len] = horizontal ? [h, w] : [w, h];
  const at = (a, b) => (horizontal ? b * w + a : a * w + b); // a: a lo largo, b: transversal
  for (let b = 0; b < n; b++) {
    let start = -1, lastOn = -1;
    for (let a = 0; a <= len; a++) {
      let on = false;
      if (a < len) {
        for (let d = -1; d <= 1 && !on; d++) {
          const bb = b + d;
          if (bb >= 0 && bb < n && dark[at(a, bb)]) on = true;
        }
      }
      if (on) {
        if (start < 0) start = a;
        lastOn = a;
      } else if (start >= 0 && (a - lastOn > MAX_GAP || a === len)) {
        if (lastOn - start + 1 >= minRun) {
          for (let k = start; k <= lastOn; k++) {
            // píxel de la línea en esta fila, o hueco (se rellena para no cortar la componente)
            const above = b > 0 && dark[at(k, b - 1)], below = b < n - 1 && dark[at(k, b + 1)];
            if (dark[at(k, b)] || (!above && !below)) out[at(k, b)] = 1;
          }
        }
        start = -1;
      }
    }
  }
  return out;
}

// Filtro de "cresta": un píxel de una línea horizontal es más oscuro que los que están
// 3 px arriba y abajo. Esa diferencia relativa se promedia a lo largo de ~15 px: responde
// fuerte a líneas largas aunque sean finas, tenues o estén cortadas, y poco a texto o X.
const RIDGE_D = 3, RIDGE_L = 7, RIDGE_T = 0.05;
function blur3({ w, h, g }) {
  const out = new Uint8ClampedArray(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1] + 2 * g[i - 1] + 4 * g[i] + 2 * g[i + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) / 16;
    }
  }
  return out;
}

function ridgeMask(img, horizontal) {
  const { w, h } = img;
  const g = blur3(img); // atenúa la trama de las celdas grises y el ruido
  const r = new Float32Array(w * h);
  const D = RIDGE_D;
  for (let y = D; y < h - D; y++) {
    for (let x = D; x < w - D; x++) {
      const i = y * w + x;
      const step = horizontal ? w : 1;
      const side = (g[i - D * step] + g[i + D * step]) / 2;
      const core = Math.min(g[i - step], g[i], g[i + step]);
      if (side > 1 && core < side) r[i] = (side - core) / side;
    }
  }
  const out = new Uint8Array(w * h);
  const m = Math.round(0.01 * Math.max(w, h)) + 2; // franja del borde de la imagen
  if (horizontal) {
    for (let y = m; y < h - m; y++) {
      let acc = 0;
      for (let x = 0; x < w; x++) {
        acc += r[y * w + x];
        if (x >= 2 * RIDGE_L + 1) acc -= r[y * w + x - 2 * RIDGE_L - 1];
        const cx = x - RIDGE_L;
        if (cx >= m && cx < w - m && acc / (2 * RIDGE_L + 1) > RIDGE_T) out[y * w + cx] = 1;
      }
    }
  } else {
    for (let x = m; x < w - m; x++) {
      let acc = 0;
      for (let y = 0; y < h; y++) {
        acc += r[y * w + x];
        if (y >= 2 * RIDGE_L + 1) acc -= r[(y - 2 * RIDGE_L - 1) * w + x];
        const cy = y - RIDGE_L;
        if (cy >= m && cy < h - m && acc / (2 * RIDGE_L + 1) > RIDGE_T) out[cy * w + x] = 1;
      }
    }
  }
  return out;
}

// Componentes conexas (8-vecinos) de la máscara; para cada una se ajusta una recta
// por mínimos cuadrados: y = m·x + q (horizontales) o x = m·y + q (verticales).
function segments(mask, w, h, horizontal, minLen) {
  const label = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    let sp = 0, n = 0, su = 0, sv = 0, suu = 0, suv = 0, uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    stack[sp++] = s; label[s] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      const u = horizontal ? x : y, v = horizontal ? y : x;
      n++; su += u; sv += v; suu += u * u; suv += u * v;
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) { label[j] = 1; stack[sp++] = j; }
        }
      }
    }
    const span = uMax - uMin;
    if (span < minLen || vMax - vMin > 0.3 * span + 4) continue;
    const den = n * suu - su * su;
    const m = den ? (n * suv - su * sv) / den : 0;
    const q = (sv - m * su) / n;
    out.push({ m, q, u0: uMin, u1: uMax, n, su, sv, suu, suv });
  }
  return out;
}

const at = (s, u) => s.m * u + s.q;

// Une piezas colineales (p. ej. una vertical cortada por una fila combinada).
function mergeCollinear(segs, tol, uRef) {
  segs.sort((a, b) => at(a, uRef) - at(b, uRef));
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && Math.abs(at(last, uRef) - at(s, uRef)) < tol) {
      const t = { n: last.n + s.n, su: last.su + s.su, sv: last.sv + s.sv, suu: last.suu + s.suu, suv: last.suv + s.suv };
      const den = t.n * t.suu - t.su * t.su;
      t.m = den ? (t.n * t.suv - t.su * t.sv) / den : 0;
      t.q = (t.sv - t.m * t.su) / t.n;
      t.u0 = Math.min(last.u0, s.u0); t.u1 = Math.max(last.u1, s.u1);
      out[out.length - 1] = t;
    } else out.push({ ...s });
  }
  return out;
}

// Intersección de una horizontal (y = a·x + b) con una vertical (x = c·y + d).
function cross(hz, vt) {
  const y = (hz.m * vt.q + hz.q) / (1 - hz.m * vt.m);
  return [vt.m * y + vt.q, y];
}

// ---------- Tablas ----------

// Largo cubierto por la unión de intervalos [u0,u1].
function coverage(segs, lo, hi) {
  const iv = segs.map((s) => [Math.max(lo, s.u0), Math.min(hi, s.u1)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of iv) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

// Las filas de la tabla tienen la misma altura: se descartan líneas espurias
// demasiado cercanas (texto, sombras) y se interpolan las que faltan.
function regularize(hs, xm) {
  hs = hs.sort((a, b) => at(a, xm) - at(b, xm));
  const spacing = () => {
    const d = hs.slice(1).map((s, i) => at(s, xm) - at(hs[i], xm)).sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
  };
  let m = spacing();
  for (let i = 1; i < hs.length; ) {
    if (at(hs[i], xm) - at(hs[i - 1], xm) < 0.6 * m) {
      hs.splice(hs[i].cov < hs[i - 1].cov ? i : i - 1, 1);
      m = spacing();
    } else i++;
  }
  const out = [hs[0]];
  for (let i = 1; i < hs.length; i++) {
    const gap = at(hs[i], xm) - at(hs[i - 1], xm);
    const k = Math.round(gap / m);
    if (k >= 2 && k <= 3 && Math.abs(gap / k - m) < 0.15 * m) {
      for (let j = 1; j < k; j++) {
        const f = j / k;
        out.push({ m: (1 - f) * hs[i - 1].m + f * hs[i].m, q: (1 - f) * hs[i - 1].q + f * hs[i].q, u0: hs[i].u0, u1: hs[i].u1, cov: 0, interpolated: true });
      }
    }
    out.push(hs[i]);
  }
  return out;
}

export function findTables(img, nCols, debug = null) {
  const { w, h } = img;
  const H = segments(ridgeMask(img, true), w, h, true, 0.08 * w);
  const V = segments(ridgeMask(img, false), w, h, false, 0.08 * h);
  if (debug) { debug.H = H; debug.V = V; }

  // 1. Verticales: unir piezas colineales (cortadas por filas combinadas).
  const ymid = h / 2;
  const vs = mergeCollinear(V, 0.012 * w, ymid).filter((s) => s.u1 - s.u0 > 0.1 * h);

  // 2. Dos verticales vecinas son de la misma tabla si varias horizontales cruzan entre ellas.
  const spans = (a, b) => {
    const y0 = Math.max(a.u0, b.u0), y1 = Math.min(a.u1, b.u1);
    if (y1 <= y0) return 0;
    const ym = (y0 + y1) / 2;
    const xa = at(a, ym), xb = at(b, ym), d = 0.2 * (xb - xa);
    return H.filter((s) => {
      const y = at(s, (xa + xb) / 2);
      return y > y0 - 5 && y < y1 + 5 && s.u0 <= xa + d && s.u1 >= xb - d;
    }).length;
  };
  const groups = [];
  let cur = [];
  for (const v of vs) {
    if (cur.length && spans(cur[cur.length - 1], v) < 3) { groups.push(cur); cur = []; }
    cur.push(v);
  }
  if (cur.length) groups.push(cur);

  const tables = [];
  for (const gv of groups) {
    if (gv.length !== nCols + 1) continue;
    // Borde superior/inferior: los dos bordes exteriores de la tabla (las verticales
    // internas pueden cortarse en filas combinadas, como "Desarrollo").
    const outer = [gv[0], gv[gv.length - 1]];
    const top = Math.min(...outer.map((s) => s.u0)), bot = Math.max(...outer.map((s) => s.u1));
    const ym = (top + bot) / 2;
    const x0 = at(gv[0], ym), x1 = at(gv[gv.length - 1], ym), xm = (x0 + x1) / 2;
    const rowTol = 0.25 * (x1 - x0) / (nCols + 1);
    // 3. Horizontales de la tabla: piezas dentro del rango, unidas si son colineales.
    const pieces = H.filter((s) => {
      const y = at(s, xm);
      return s.u1 > x0 && s.u0 < x1 && y > top - rowTol && y < bot + rowTol;
    });
    const lines = [];
    for (const s of pieces.sort((a, b) => at(a, xm) - at(b, xm))) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(at(last[0], xm) - at(s, xm)) < 5) last.push(s); else lines.push([s]);
    }
    let hs = lines
      .filter((ps) => coverage(ps, x0, x1) > 0.6 * (x1 - x0))
      .map((ps) => ({ ...mergeCollinear(ps, 5, xm)[0], cov: coverage(ps, x0, x1) }));
    if (hs.length < 3) continue;
    hs = regularize(hs, xm);
    tables.push({ h: hs, v: gv, x: x0 });
  }
  return tables.sort((a, b) => a.x - b.x);
}

// Mide la tinta en el interior de una celda (cuadrilátero de 4 esquinas).
function cellInk(img, tl, tr, br, bl) {
  const N = 20, vals = [];
  for (let j = 0; j < N; j++) {
    const v = INSET + ((1 - 2 * INSET) * (j + 0.5)) / N;
    for (let i = 0; i < N; i++) {
      const u = INSET + ((1 - 2 * INSET) * (i + 0.5)) / N;
      const x = (1 - v) * ((1 - u) * tl[0] + u * tr[0]) + v * ((1 - u) * bl[0] + u * br[0]);
      const y = (1 - v) * ((1 - u) * tl[1] + u * tr[1]) + v * ((1 - u) * bl[1] + u * br[1]);
      const xi = Math.min(img.w - 1, Math.max(0, Math.round(x))), yi = Math.min(img.h - 1, Math.max(0, Math.round(y)));
      vals.push(img.g[yi * img.w + xi]);
    }
  }
  // Papel = percentil 80 de la celda. Puntaje = oscurecimiento medio del 15 % de
  // píxeles más oscuros: una X ocupa ~10–15 % de la celda; una celda vacía sólo
  // tiene ruido. No depende de la resolución ni del grosor del trazo.
  const sorted = [...vals].sort((a, b) => a - b);
  const paper = sorted[Math.floor(sorted.length * 0.8)] || 1;
  const k = Math.max(1, Math.round(sorted.length * 0.15));
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.max(0, (paper - sorted[i]) / paper);
  return s / k;
}

// Escala la imagen para que el lado largo mida `target` px (las fotos de 12 MP se achican).
function resize({ w, h, g }, target) {
  const k = target / Math.max(w, h);
  if (k >= 1) return { w, h, g };
  const W = Math.round(w * k), H = Math.round(h * k), out = new Uint8ClampedArray(W * H);
  const r = 1 / k;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // promedio del bloque de origen (evita perder líneas finas)
      const x0 = Math.floor(x * r), x1 = Math.min(w, Math.ceil((x + 1) * r));
      const y0 = Math.floor(y * r), y1 = Math.min(h, Math.ceil((y + 1) * r));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g[yy * w + xx]; n++; }
      out[y * W + x] = s / n;
    }
  }
  return { w: W, h: H, g: out };
}

// Ángulo de inclinación (−45°..45°) que deja las líneas de la tabla horizontales:
// maximiza la "nitidez" del perfil de proyección de los píxeles oscuros.
export function estimateSkew(img, curve = null, vertical = false) {
  const { w, h } = img;
  const dark = darkMask(img);
  const xs = [], ys = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (dark[y * w + x]) { xs.push(x - w / 2); ys.push(y - h / 2); }
  const diag = Math.hypot(w, h);
  const bins = new Float64Array(Math.ceil(diag / 2) + 2);
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    bins.fill(0);
    for (let i = 0; i < xs.length; i++) {
      const b = vertical
        ? Math.round((xs[i] - ys[i] * t + diag / 2) / 2)
        : Math.round((ys[i] - xs[i] * t + diag / 2) / 2); // casilleros de 2 px (el muestreo es cada 2 px)
      if (b >= 0 && b < bins.length) bins[b]++;
    }
    let s = 0;
    for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
    return s;
  };
  let best = 0, bestS = -1;
  for (let d = -45; d < 45; d += 1) { const sc = score(d); if (curve) curve.push([d, sc]); if (sc > bestS) { bestS = sc; best = d; } }
  for (let d = best - 1; d <= best + 1; d += 0.1) { const sc = score(d); if (sc > bestS) { bestS = sc; best = d; } }
  return best;
}

// Endereza la imagen con una transformación afín: las horizontales de la tabla
// (inclinadas ah grados) y las verticales (inclinadas av grados) quedan alineadas
// con los ejes. Corrige giro y también el "trapecio" de una foto en perspectiva.
function unshear({ w, h, g }, ah, av) {
  if (Math.abs(ah) < 0.2 && Math.abs(av) < 0.2) return { w, h, g };
  const th = (ah * Math.PI) / 180, tv = (av * Math.PI) / 180;
  const e1 = [Math.cos(th), Math.sin(th)]; // dirección de las horizontales en la foto
  const e2 = [Math.sin(tv), Math.cos(tv)]; // dirección de las verticales en la foto
  const det = e1[0] * e2[1] - e1[1] * e2[0];
  // tamaño de salida: esquinas de la imagen expresadas en la base (e1, e2)
  const toOut = (x, y) => [(x * e2[1] - y * e2[0]) / det, (y * e1[0] - x * e1[1]) / det];
  const cs = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => toOut(x, y));
  const W = Math.ceil(Math.max(...cs.map((c) => c[0])) - Math.min(...cs.map((c) => c[0])));
  const H = Math.ceil(Math.max(...cs.map((c) => c[1])) - Math.min(...cs.map((c) => c[1])));
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x - W / 2, v = y - H / 2;
      const sx = u * e1[0] + v * e2[0] + w / 2, sy = u * e1[1] + v * e2[1] + h / 2;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { out[y * W + x] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
      out[y * W + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
    }
  }
  return { w: W, h: H, g: out };
}

function rotateGray({ w, h, g }, quarter) {
  if (!quarter) return { w, h, g };
  const W = quarter % 2 ? h : w, H = quarter % 2 ? w : h;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X, Y;
      if (quarter === 1) { X = h - 1 - y; Y = x; }
      else if (quarter === 2) { X = w - 1 - x; Y = h - 1 - y; }
      else { X = y; Y = w - 1 - x; }
      out[Y * W + X] = g[y * w + x];
    }
  }
  return { w: W, h: H, g: out };
}

function cellsOf(img, tables, nCols) {
  const cells = [];
  for (const t of tables) {
    for (let r = 1; r < t.h.length - 1; r++) {
      const row = [];
      for (let c = 0; c < nCols; c++) {
        const tl = cross(t.h[r], t.v[c]), tr = cross(t.h[r], t.v[c + 1]);
        const bl = cross(t.h[r + 1], t.v[c]), br = cross(t.h[r + 1], t.v[c + 1]);
        row.push({ quad: [tl, tr, br, bl], ink: cellInk(img, tl, tr, br, bl) });
      }
      cells.push(row);
    }
  }
  return cells;
}

// rows: filas de la clave en orden, { label, opts, key, skip }.
// Prueba las 4 orientaciones; la correcta es la que tiene los números de pregunta
// (tinta en todas las filas) en la primera columna.
export function readTableSheet(imageData, rows, T = TABLE_THRESHOLDS, nCols = 6, debug = null) {
  const small = resize(toGray(imageData), 1400);
  const skew = estimateSkew(small);
  const skewV = estimateSkew(small, null, true);
  // Ángulo de las verticales: x = y·tan(av), e2 = (sin av, cos av). En una rotación pura
  // av = −ah; la perspectiva agrega unos grados de diferencia. Si la estimación de las
  // verticales es incoherente, se asume rotación pura.
  const base = unshear(small, skew, Math.abs(skewV + skew) < 15 ? skewV : -skew);
  if (debug) { debug.skew = skew; debug.base = base; debug.seg = {}; findTables(base, nCols, debug.seg); }
  let found = null, lastErr = null;
  for (const quarter of [0, 2, 1, 3]) {
    const img = rotateGray(base, quarter);
    const tables = findTables(img, nCols);
    if (!tables.length) continue;
    const dataRows = tables.reduce((s, t) => s + t.h.length - 2, 0);
    if (dataRows !== rows.length) {
      lastErr = `Se ven ${dataRows} filas de respuestas y la clave tiene ${rows.length}. Asegurate de que entren todas las tablas completas en la foto.`;
      continue;
    }
    const cells = cellsOf(img, tables, nCols);
    const numbered = cells.filter((row) => row[0].ink > T.numbers).length / cells.length;
    if (numbered < 0.8) continue; // primera columna sin números: orientación equivocada
    found = { img, tables, cells, quarter };
    break;
  }
  if (!found) {
    throw new OMRError(lastErr || 'No se encontró la tabla de respuestas. Que se vea la tabla entera, con luz pareja.');
  }

  const { cells } = found;
  const opt = (i) => cells[i].slice(1, 1 + rows[i].opts.length);
  const rowMins = rows.map((it, i) => (it.skip ? null : Math.min(...opt(i).map((c) => c.ink))));
  const results = rows.map((it, i) => {
    if (it.skip) return { label: it.label, skip: true, quads: [], scores: [], marked: [], doubtful: [], status: 'skip' };
    const own = opt(i);
    const scores = own.map((c) => c.ink);
    const nb = rowMins.filter((v, j) => v !== null && j !== i && Math.abs(j - i) <= 4).sort((a, b) => a - b);
    const nbBase = nb.length ? nb[Math.floor(nb.length / 2)] : Infinity;
    const d = decide(scores, Math.max(1, it.key.length), T, nbBase);
    return { label: it.label, quads: own.map((c) => c.quad), scores, ...d };
  });
  return { ...found, results };
}
