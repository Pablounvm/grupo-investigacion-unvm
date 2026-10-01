// Genera la hoja de respuestas imprimible como SVG en milímetros reales.
// La clave NUNCA se imprime: la hoja sólo depende de etiquetas y opciones.
import { A4, FIDUCIALS, FIDUCIAL_SIZE, ORIENT, buildLayout } from './layout.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const f = (n) => Math.round(n * 100) / 100;

export function sheetSVG({ title = '', items }) {
  const L = buildLayout(items);
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${A4.w}mm" height="${A4.h}mm" viewBox="0 0 ${A4.w} ${A4.h}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${A4.w}" height="${A4.h}" fill="#fff"/>`
  );

  const s = FIDUCIAL_SIZE;
  for (const [x, y] of FIDUCIALS) {
    out.push(`<rect x="${x - s / 2}" y="${y - s / 2}" width="${s}" height="${s}" fill="#000"/>`);
  }
  const o = ORIENT.size;
  out.push(`<rect x="${ORIENT.x - o / 2}" y="${ORIENT.y - o / 2}" width="${o}" height="${o}" fill="#000"/>`);

  // Encabezado: fuera de la franja de las marcas (y < 23) y de la grilla (y > 72).
  const t = title.trim() || 'Examen';
  out.push(
    `<text x="105" y="28" font-size="5.5" font-weight="bold" text-anchor="middle">${esc(t.slice(0, 50))}</text>`,
    `<text x="105" y="33" font-size="3" text-anchor="middle" fill="#444">Hoja de respuestas · ${items.length} ítems</text>`,
    `<text x="30" y="41" font-size="4">Apellido y nombre:</text>`,
    `<line x1="64" y1="41.6" x2="180" y2="41.6" stroke="#000" stroke-width="0.25"/>`,
    `<text x="30" y="49" font-size="4">Legajo / DNI:</text>`,
    `<line x1="55" y1="49.6" x2="110" y2="49.6" stroke="#000" stroke-width="0.25"/>`,
    `<text x="118" y="49" font-size="4">Fecha:</text>`,
    `<line x1="131" y1="49.6" x2="180" y2="49.6" stroke="#000" stroke-width="0.25"/>`,
    `<text x="30" y="58" font-size="3.1" fill="#333">Marcá con una cruz (X) o un círculo DENTRO del casillero elegido, con birome o lapicera oscura.</text>`,
    `<text x="30" y="62.5" font-size="3.1" fill="#333">No escribas fuera de los casilleros ni sobre los cuadrados negros. No dobles la hoja.</text>`,
    `<text x="30" y="67" font-size="3.1" fill="#333">Si te equivocás, avisá al docente: dos marcas en un mismo ítem se revisan a mano.</text>`
  );

  for (const h of L.headers) {
    out.push(`<text x="${f(h.x)}" y="${f(h.y + 1.3)}" font-size="3.6" font-weight="bold" text-anchor="middle">${esc(h.letter)}</text>`);
  }

  const b = L.box;
  for (const q of L.questions) {
    out.push(`<text x="${f(q.labelPos.x)}" y="${f(q.labelPos.y + 1.2)}" font-size="3.4" text-anchor="end">${esc(q.label)}</text>`);
    for (const c of q.cells) {
      out.push(
        `<rect x="${f(c.x - b / 2)}" y="${f(c.y - b / 2)}" width="${f(b)}" height="${f(b)}" fill="none" stroke="#000" stroke-width="0.3"/>`
      );
    }
  }

  out.push(`<text x="105" y="290" font-size="2.6" text-anchor="middle" fill="#666">Corrector de grillas · no doblar · imprimir al 100 % o «ajustar a página»</text>`);
  out.push('</svg>');
  return out.join('\n');
}
