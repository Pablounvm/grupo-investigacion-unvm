// Simulador de fotos de hojas completadas a mano, para medir la tasa de error del lector.
// No reemplaza la validación con hojas reales: es un banco de pruebas reproducible.
import { A4, FIDUCIALS, FIDUCIAL_SIZE, ORIENT, buildLayout } from '../js/layout.js';

export function rng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(next.range(a, b + 1));
  next.gauss = () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next());
  return next;
}

const S = 8; // px/mm del "papel" simulado

class Paper {
  constructor() {
    this.w = A4.w * S; this.h = A4.h * S;
    this.g = new Float32Array(this.w * this.h).fill(245);
  }
  rect(x, y, w, h, v) {
    for (let j = Math.round(y * S); j < Math.round((y + h) * S); j++)
      for (let i = Math.round(x * S); i < Math.round((x + w) * S); i++) this.g[j * this.w + i] = Math.min(this.g[j * this.w + i], v);
  }
  // Trazo con antialias: cobertura según distancia al segmento.
  seg(x0, y0, x1, y1, width, v) {
    const r = (width * S) / 2;
    const ax = x0 * S, ay = y0 * S, bx = x1 * S, by = y1 * S;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), maxX = Math.min(this.w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), maxY = Math.min(this.h - 1, Math.ceil(Math.max(ay, by) + r + 1));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        const cov = Math.max(0, Math.min(1, r - d + 0.5));
        if (cov > 0) {
          const i = y * this.w + x;
          this.g[i] = Math.min(this.g[i], 245 - cov * (245 - v));
        }
      }
    }
  }
  poly(pts, width, v) {
    for (let i = 1; i < pts.length; i++) this.seg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], width, v);
  }
  boxOutline(cx, cy, b, width, v) {
    const h = b / 2;
    this.poly([[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h], [cx - h, cy - h]], width, v);
  }
}

// "Texto" impreso o manuscrito aproximado como garabatos cortos.
function scribble(P, R, x, y, w, h, width, v, n) {
  let px = x, py = y + R.range(0, h);
  for (let i = 0; i < n; i++) {
    const nx = Math.min(x + w, px + R.range(0.3, 1.5));
    const ny = y + R.range(0, h);
    P.seg(px, py, nx, ny, width, v);
    px = nx >= x + w ? x : nx; py = ny;
  }
}

function drawMark(P, R, cx, cy, L, style, strength = 1) {
  const width = R.range(0.25, 0.6);
  const ink = 245 - strength * (245 - R.range(25, 110));
  const ox = R.range(-0.6, 0.6), oy = R.range(-0.6, 0.6);
  const b = L.box / 2;
  if (style === 'x') {
    const e = R.range(0.6, 1.25) * b;
    P.seg(cx + ox - e + R.range(-0.5, 0.5), cy + oy - e, cx + ox + e, cy + oy + e + R.range(-0.5, 0.5), width, ink);
    P.seg(cx + ox + e, cy + oy - e + R.range(-0.5, 0.5), cx + ox - e + R.range(-0.5, 0.5), cy + oy + e, width, ink);
  } else if (style === 'circle') {
    // Círculo dentro del casillero o alrededor, a veces sin cerrar.
    const rad = R.range(0.55, 1.35) * b, ry = rad * R.range(0.8, 1.15);
    const a0 = R.range(0, 6.28), span = R.range(5.2, 6.9), pts = [];
    for (let t = 0; t <= 24; t++) {
      const a = a0 + (span * t) / 24;
      pts.push([cx + ox + rad * Math.cos(a), cy + oy + ry * Math.sin(a)]);
    }
    P.poly(pts, width, ink);
  } else if (style === 'tick') {
    P.poly([[cx + ox - b * 0.8, cy + oy], [cx + ox - b * 0.2, cy + oy + b * 0.8], [cx + ox + b, cy + oy - b]], width, ink);
  } else if (style === 'fill') {
    for (let k = -b; k <= b; k += 0.45) P.seg(cx - b, cy + k, cx + b, cy + k + R.range(-0.3, 0.3), width + 0.2, ink);
  }
}

const STYLES = ['x', 'x', 'x', 'circle', 'circle', 'tick', 'fill'];

// Genera la hoja con marcas "verdaderas" (conjunto de opciones marcadas por ítem) y la dibuja.
export function makeFilledSheet(R, items, mix = {}) {
  const { blank = 0.06, multiple = 0.05, faint = 0.04, stray = 0.03 } = mix;
  const L = buildLayout(items);
  const P = new Paper();
  for (const [x, y] of FIDUCIALS) P.rect(x - FIDUCIAL_SIZE / 2, y - FIDUCIAL_SIZE / 2, FIDUCIAL_SIZE, FIDUCIAL_SIZE, 15);
  P.rect(ORIENT.x - ORIENT.size / 2, ORIENT.y - ORIENT.size / 2, ORIENT.size, ORIENT.size, 15);
  scribble(P, R, 60, 23.5, 90, 4.5, 0.7, 20, 120); // título
  scribble(P, R, 30, 37, 30, 4, 0.35, 20, 40);
  scribble(P, R, 66, 36, R.range(30, 100), 5, 0.45, R.range(30, 90), 80); // nombre a mano
  scribble(P, R, 30, 45, 22, 4, 0.35, 20, 30);
  scribble(P, R, 58, 44, 40, 5, 0.45, R.range(30, 90), 40); // legajo a mano
  for (const y of [55.5, 60, 64.5]) scribble(P, R, 30, y, 150, 2.5, 0.25, 50, 220);
  for (const h of L.headers) scribble(P, R, h.x - 1.2, h.y - 1.4, 2.4, 2.8, 0.4, 20, 6);
  for (const q of L.questions) {
    scribble(P, R, q.labelPos.x - 5, q.labelPos.y - 1.2, 4.6, 2.4, 0.3, 20, 8);
    for (const c of q.cells) P.boxOutline(c.x, c.y, L.box, 0.3, 20);
  }

  const truth = [];
  L.questions.forEach((q) => {
    const n = q.cells.length;
    const u = R();
    const style = STYLES[R.int(0, STYLES.length - 1)];
    if (u < blank) {
      truth.push({ marks: [] });
    } else if (u < blank + multiple) {
      const a = R.int(0, n - 1); let b = R.int(0, n - 2); if (b >= a) b++;
      drawMark(P, R, q.cells[a].x, q.cells[a].y, L, style);
      drawMark(P, R, q.cells[b].x, q.cells[b].y, L, STYLES[R.int(0, STYLES.length - 1)]);
      truth.push({ marks: [a, b].sort() });
    } else {
      const a = R.int(0, n - 1);
      const isFaint = u < blank + multiple + faint;
      drawMark(P, R, q.cells[a].x, q.cells[a].y, L, style, isFaint ? R.range(0.35, 0.6) : 1);
      truth.push({ marks: [a], faint: isFaint, style });
    }
    if (R() < stray) {
      // Desliz de lapicera: rayita corta que roza otro casillero.
      const k = R.int(0, n - 1), c = q.cells[k];
      const a = R.range(0, 6.28), l = R.range(0.8, 2);
      const sx = c.x + R.range(-L.roi, L.roi), sy = c.y + R.range(-L.roi, L.roi);
      P.seg(sx, sy, sx + l * Math.cos(a), sy + l * Math.sin(a), 0.3, 80);
      truth[truth.length - 1].stray = true;
    }
  });
  return { paper: P, truth, layout: L };
}

// Estructura de ítems de un examen al azar (sin clave: la lectura no la necesita).
export function randomItems(R) {
  const n = R.int(10, 60);
  const items = [];
  let opts = 'abcde'.slice(0, R.int(3, 5));
  for (let i = 0; i < n; i++) {
    if (R() < 0.15) opts = ['abcd', 'abcde', 'abc', 'VF', 'abcdef'][R.int(0, 4)];
    items.push({ label: String(i + 1), opts, key: R() < 0.1 ? 'ab' : 'a', points: 1 });
  }
  return items;
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

// Fotografía simulada: perspectiva, giro, fondo, sombra, desenfoque y ruido.
export function photograph(P, R, opts = {}) {
  const portrait = R() < 0.8;
  const W = portrait ? 1200 : 1600, H = portrait ? 1600 : 1200;
  const quarter = opts.quarter ?? (R() < 0.15 ? R.int(1, 3) : 0);
  const severity = opts.severity ?? 1;
  const fill = R.range(0.7, 0.9);
  const sheetW = A4.w, sheetH = A4.h;
  const rotated = quarter % 2 === 1;
  const scale = Math.min(W / (rotated ? sheetH : sheetW), H / (rotated ? sheetW : sheetH)) * fill;
  const ang = quarter * (Math.PI / 2) + R.range(-0.2, 0.2) * severity;
  const cx = W / 2 + R.range(-0.05, 0.05) * W, cy = H / 2 + R.range(-0.05, 0.05) * H;
  const corners = [[0, 0], [sheetW, 0], [sheetW, sheetH], [0, sheetH]].map(([x, y]) => {
    const X = (x - sheetW / 2) * scale, Y = (y - sheetH / 2) * scale;
    const j = 0.05 * scale * sheetW * severity;
    return [cx + X * Math.cos(ang) - Y * Math.sin(ang) + R.range(-j, j), cy + X * Math.sin(ang) + Y * Math.cos(ang) + R.range(-j, j)];
  });
  // Homografía papel(px de Paper) -> foto, y su inversa.
  const src = [[0, 0], [P.w, 0], [P.w, P.h], [0, P.h]];
  const Hm = solveH(src, corners);
  const Hi = invert3(Hm);

  const bg = R.range(50, 200);
  const grad = R.range(0, 0.35) * severity, gAng = R.range(0, 6.28);
  const shadow = R() < 0.5 ? { x: R.range(0, W), y: R.range(0, H), r: R.range(200, 600), k: R.range(0.1, 0.35) * severity } : null;
  const noise = R.range(2, 7);
  const out = new Float32Array(W * H);
  const sub = [0.25, 0.75];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (const sy of sub) for (const sx of sub) {
        const X = x + sx, Y = y + sy;
        const d = Hi[6] * X + Hi[7] * Y + Hi[8];
        const u = (Hi[0] * X + Hi[1] * Y + Hi[2]) / d, v = (Hi[3] * X + Hi[4] * Y + Hi[5]) / d;
        if (u >= 0 && v >= 0 && u < P.w - 1 && v < P.h - 1) s += P.g[(v | 0) * P.w + (u | 0)];
        else s += bg + 15 * Math.sin(X / 37) * Math.cos(Y / 53);
      }
      let val = s / 4;
      let light = 1 - grad * (0.5 + 0.5 * Math.cos(gAng) * (x / W - 0.5) * 2 + 0.5 * Math.sin(gAng) * (y / H - 0.5) * 2);
      if (shadow) light -= shadow.k * Math.exp(-((x - shadow.x) ** 2 + (y - shadow.y) ** 2) / (2 * shadow.r ** 2));
      out[y * W + x] = val * light;
    }
  }
  // Desenfoque leve (caja 3x3) y ruido.
  const blurred = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += out[(y + j) * W + x + i];
    blurred[y * W + x] = s / 9;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = blurred[i] + noise * R.gauss();
    data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = v; data[4 * i + 3] = 255;
  }
  const fid = FIDUCIALS.map(([x, y]) => {
    const X = x * S, Y = y * S, d = Hm[6] * X + Hm[7] * Y + Hm[8];
    return [(Hm[0] * X + Hm[1] * Y + Hm[2]) / d, (Hm[3] * X + Hm[4] * Y + Hm[5]) / d];
  });
  return { data, width: W, height: H, fid };
}

function solveH(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) { const k = A[r][c] / A[c][c]; for (let j = c; j < n; j++) A[r][j] -= k * A[c][j]; b[r] -= k * b[c]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j]; x[r] = s / A[r][r]; }
  return [...x, 1];
}
