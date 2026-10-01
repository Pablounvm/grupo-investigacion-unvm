// Banco de pruebas: genera N hojas simuladas, las "fotografía" y mide el error del lector.
// Uso: node tests/synthetic.test.js [nHojas] [semilla]
import { readSheet, OMRError } from '../js/omr.js';
import { rng, makeFilledSheet, photograph, randomItems } from './synth.js';

const N = Number(process.argv[2] || 30);
const seed = Number(process.argv[3] || 12345);
const R = rng(seed);

const t = { items: 0, autoOk: 0, flagged: 0, silent: 0, sheetsFailed: 0 };
const why = { doble: 0, tenue: 0, desliz: 0, normal: 0 };
const kind = (tr) => (tr.marks.length > 1 ? 'doble' : tr.faint ? 'tenue' : tr.stray ? 'desliz' : 'normal');
const errors = [];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

for (let s = 0; s < N; s++) {
  const items = randomItems(R);
  const { paper, truth } = makeFilledSheet(R, items);
  const photo = photograph(paper, R);
  let res;
  try {
    res = readSheet(photo, items).results;
  } catch (e) {
    if (!(e instanceof OMRError)) throw e;
    t.sheetsFailed++;
    errors.push(`hoja ${s}: ${e.message}`);
    continue;
  }
  truth.forEach((tr, i) => {
    const r = res[i];
    t.items++;
    if (r.status === 'review') {
      t.flagged++; why[kind(tr)]++;
      if (process.env.VERBOSE && kind(tr) === 'normal') console.log(`revisar ${tr.style}: marcadas=${r.marked} dudosas=${r.doubtful} real=${tr.marks} Δ=${r.delta.map((d) => d.toFixed(4))} borde=${r.band.map((d) => d.toFixed(3))}`);
    }
    else if (same([...r.marked].sort(), tr.marks)) t.autoOk++;
    else {
      t.silent++;
      errors.push(`hoja ${s} ítem ${r.label} (${items[i].opts}): real=${JSON.stringify(tr)} leído=${r.status} ${JSON.stringify(r.marked)} Δ=${r.delta.map((d) => d.toFixed(4)).join(',')}`);
    }
  });
}

const pct = (x) => ((100 * x) / Math.max(1, t.items)).toFixed(2) + ' %';
console.log(`Hojas: ${N} (no leídas: ${t.sheetsFailed})  Ítems: ${t.items}`);
console.log(`  Leídos bien, sin intervención : ${t.autoOk} (${pct(t.autoOk)})`);
console.log(`  Marcados "a revisar"          : ${t.flagged} (${pct(t.flagged)})`);
console.log(`    por causa (simulada): ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  Errores silenciosos           : ${t.silent} (${pct(t.silent)})`);
if (errors.length) console.log(errors.slice(0, 30).join('\n'));

const ok = t.sheetsFailed === 0 && t.silent / Math.max(1, t.items) < 0.005;
process.exit(ok ? 0 : 1);
