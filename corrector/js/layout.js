// Geometría de la hoja de respuestas, en milímetros sobre A4 vertical.
// La misma función la usan el generador de la hoja (sheet.js) y el lector (omr.js),
// así lo que se imprime y lo que se lee coinciden siempre.
//
// Un examen es una lista de ítems: { label: '27.1', opts: 'abcde', key: 'bd', points: 1.5 }.
// Cada ítem puede tener distinta cantidad de opciones (p. ej. a–e, a–d, V/F).

export const A4 = { w: 210, h: 297 };

// Marcas de esquina (cuadrados negros macizos). Orden: TL, TR, BR, BL (horario).
export const FIDUCIAL_SIZE = 12;
export const FIDUCIALS = [
  [16, 16],
  [194, 16],
  [194, 281],
  [16, 281],
];

// Marca de orientación: sólo junto a la esquina superior izquierda.
// Permite leer la foto aunque la hoja esté girada 90° o 180°.
export const ORIENT = { x: 34, y: 16, size: 6 };

export const MAX_OPTS = 6;
export const MAX_ITEMS = 80;

const GRID_TOP = 74;
const GRID_BOTTOM = 270;
const GRID_LEFT = 22;
const GRID_RIGHT = 188;
const MAX_ROWS = 21;
const LABEL_W = 11;
const COL_GAP = 7;

// Reparte ítems en columnas. Se inserta una fila de encabezado (letras) al
// comienzo de cada columna y cada vez que cambia el juego de opciones.
function paginate(items, cap) {
  const compat = (a, b) => a.startsWith(b) || b.startsWith(a);
  const cols = [];
  let rows = null, header = '';
  for (let i = 0; i < items.length; i++) {
    const opts = items[i].opts;
    let newHeader = !rows || !compat(header, opts);
    if (rows && rows.length + (newHeader ? 2 : 1) > cap) rows = null;
    if (!rows) {
      rows = [];
      cols.push(rows);
      newHeader = true;
    }
    if (newHeader) {
      // El encabezado muestra el juego más largo de los ítems consecutivos compatibles.
      header = opts;
      for (let j = i + 1; j < items.length && compat(header, items[j].opts); j++) {
        if (items[j].opts.length > header.length) header = items[j].opts;
      }
      rows.push({ header });
    }
    rows.push({ item: i });
  }
  return cols;
}

export function buildLayout(items) {
  if (!items.length) throw new Error('El examen no tiene ítems.');
  let cols;
  for (let n = 1; n <= 4; n++) {
    const est = items.length + n * 2;
    cols = paginate(items, Math.min(MAX_ROWS, Math.ceil(est / n) + 1));
    if (cols.length <= n) break;
  }
  const nCols = cols.length;
  const maxOpts = Math.max(...items.map((it) => it.opts.length));
  const pitchY = (GRID_BOTTOM - GRID_TOP) / Math.max(MAX_ROWS, 1);
  const colW = (GRID_RIGHT - GRID_LEFT - COL_GAP * (nCols - 1)) / nCols;
  const pitchX = Math.min(10, (colW - LABEL_W) / maxOpts);
  const pitch = Math.min(pitchX, pitchY);
  const box = Math.min(5.5, 0.62 * pitch);
  // Semilado de la región analizada: algo mayor que el casillero, para captar
  // círculos dibujados alrededor, sin invadir al vecino.
  const roi = 0.45 * pitch;

  const blockW = nCols * (LABEL_W + maxOpts * pitchX) + (nCols - 1) * COL_GAP;
  const x0 = (A4.w - blockW) / 2;

  const headers = [];
  const questions = new Array(items.length);
  cols.forEach((rows, c) => {
    const colX = x0 + c * (LABEL_W + maxOpts * pitchX + COL_GAP);
    rows.forEach((r, k) => {
      const cy = GRID_TOP + (k + 0.5) * pitchY;
      const cellX = (j) => colX + LABEL_W + (j + 0.5) * pitchX;
      if (r.header) {
        headers.push(...[...r.header].map((ch, j) => ({ letter: ch, x: cellX(j), y: cy })));
      } else {
        const it = items[r.item];
        questions[r.item] = {
          label: it.label,
          labelPos: { x: colX + LABEL_W - 2, y: cy },
          cells: [...it.opts].map((_, j) => ({ x: cellX(j), y: cy })),
        };
      }
    });
  });

  return { box, roi, pitchX, pitchY, headers, questions };
}

// ---------- Formato de texto de la clave ----------
// Una línea por ítem:  etiqueta  opciones  respuesta  [puntos]
//   1     abcde  b   1
//   12.1  abcde  ac  1       (dos respuestas correctas)
//   15a   VF     V   1
//   Carrera  12  -           ('-' = sin clave: se registra pero no puntúa)
// Líneas vacías y las que empiezan con # se ignoran.

export function parseExam(text) {
  const items = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length < 2) { errors.push(`Línea ${n + 1}: faltan las opciones.`); return; }
    const [label, opts, key = '-', pts] = parts;
    if (opts.length < 2 || opts.length > MAX_OPTS || new Set(opts).size !== opts.length) {
      errors.push(`Línea ${n + 1}: opciones "${opts}" inválidas (2 a ${MAX_OPTS} letras distintas).`); return;
    }
    const k = key === '-' ? '' : key;
    const bad = [...k].filter((ch) => !opts.includes(ch));
    if (bad.length) { errors.push(`Línea ${n + 1}: la respuesta "${key}" no está entre las opciones "${opts}".`); return; }
    const points = pts === undefined ? 1 : Number(pts.replace(',', '.'));
    if (!Number.isFinite(points) || points < 0) { errors.push(`Línea ${n + 1}: puntaje "${pts}" inválido.`); return; }
    items.push({ label: label.slice(0, 6), opts, key: k, points });
  });
  if (items.length > MAX_ITEMS) errors.push(`Máximo ${MAX_ITEMS} ítems por hoja.`);
  if (!items.length && !errors.length) errors.push('No hay ítems.');
  return { items, errors };
}

export function examToText(items) {
  return items.map((it) => `${it.label}\t${it.opts}\t${it.key || '-'}\t${it.points}`).join('\n');
}
