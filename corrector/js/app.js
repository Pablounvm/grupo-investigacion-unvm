// Interfaz de la app. Sin dependencias externas, sin red: todo queda en el dispositivo.
import { parseExam, examToText, MAX_ITEMS } from './layout.js';
import { sheetSVG } from './sheet.js';
import { readSheet, OMRError, PX_PER_MM } from './omr.js';

const $ = (id) => document.getElementById(id);
const STORE_EXAM = 'corrector.v1.exam';
const STORE_RESULTS = 'corrector.v1.results';
const MAX_PHOTO_SIDE = 1600;

// ---------- Almacenamiento local (puede fallar en modo privado) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_EXAM = {
  title: '',
  text: examToText(Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), opts: 'abcd', key: '', points: 1 }))),
  partial: false,
  penalty: 0,
};

let exam = load(STORE_EXAM, DEFAULT_EXAM);
let items = parseExam(exam.text).items;
let results = load(STORE_RESULTS, []);
let current = null; // corrección en curso

// ---------- Pestañas ----------
function showTab(name) {
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (name === 'sheet') renderSheet();
  if (name === 'results') renderResults();
}
document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- 1. Examen ----------
function fillExamForm() {
  $('exam-title').value = exam.title;
  $('exam-key').value = exam.text;
  $('multi-partial').checked = !!exam.partial;
  $('penalty').value = exam.penalty || 0;
}

$('gen-btn').addEventListener('click', () => {
  const n = Math.max(1, Math.min(MAX_ITEMS, Number($('gen-n').value) || 1));
  const opts = $('gen-opts').value.trim() || 'abcd';
  $('exam-key').value = examToText(Array.from({ length: n }, (_, i) => ({ label: String(i + 1), opts, key: '', points: 1 })));
});

$('exam-save').addEventListener('click', () => {
  const parsed = parseExam($('exam-key').value);
  const err = $('exam-errors');
  if (parsed.errors.length) {
    err.textContent = parsed.errors.join(' ');
    err.hidden = false;
    $('exam-status').hidden = true;
    return;
  }
  err.hidden = true;
  const layoutChanged = examToText(parsed.items.map((it) => ({ ...it, key: '', points: 0 }))) !==
    examToText(items.map((it) => ({ ...it, key: '', points: 0 })));
  exam = {
    title: $('exam-title').value.trim(),
    text: $('exam-key').value,
    partial: $('multi-partial').checked,
    penalty: Math.max(0, Number($('penalty').value) || 0),
  };
  items = parsed.items;
  const stored = save(STORE_EXAM, exam);
  const noKey = items.filter((it) => !it.key).length;
  const max = items.reduce((s, it) => s + (it.key ? it.points : 0), 0);
  $('exam-status').textContent =
    `${stored ? 'Guardado' : 'Aplicado (no se pudo guardar en el dispositivo)'}: ${items.length} ítems, máximo ${fmt(max)} puntos` +
    (noKey ? `, ${noKey} sin clave.` : '.') +
    (layoutChanged ? ' La hoja cambió: volvé a imprimirla.' : '');
  $('exam-status').hidden = false;
});

// ---------- 2. Hoja ----------
function renderSheet() {
  const svg = sheetSVG({ title: exam.title, items });
  $('sheet-preview').innerHTML = svg;
  $('print-area').innerHTML = svg;
}
$('sheet-print').addEventListener('click', () => {
  renderSheet();
  window.print();
});
$('sheet-download').addEventListener('click', () => {
  const blob = new Blob([sheetSVG({ title: exam.title, items })], { type: 'image/svg+xml' });
  download(blob, `hoja-${slug(exam.title || 'examen')}.svg`);
});

// ---------- 3. Corregir ----------
async function photoToImageData(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return ctx.getImageData(0, 0, w, h);
}

async function onPhoto(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  $('scan-error').hidden = true;
  $('review').hidden = true;
  $('scan-busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // deja pintar "Procesando…"
  try {
    const img = await photoToImageData(file);
    const out = readSheet(img, items);
    current = {
      rect: out.rect,
      layout: out.layout,
      read: out.results.map((r) => ({ marked: [...r.marked], doubtful: [...r.doubtful], status: r.status })),
      answers: out.results.map((r) => [...r.marked]),
      touched: new Set(),
    };
    $('student-name').value = '';
    $('student-id').value = '';
    $('review').hidden = false;
    drawReview();
    $('review').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    $('scan-error').textContent = e instanceof OMRError ? e.message : `No se pudo procesar la imagen (${e.message}).`;
    $('scan-error').hidden = false;
    if (!(e instanceof OMRError)) console.error(e);
  } finally {
    $('scan-busy').hidden = true;
  }
}
$('scan-input').addEventListener('change', onPhoto);
$('scan-gallery').addEventListener('change', onPhoto);

// Puntaje de un ítem. Devuelve null si el ítem no tiene clave.
function itemScore(it, ans) {
  if (!it.key) return null;
  const key = [...it.key].map((ch) => it.opts.indexOf(ch));
  const hit = ans.filter((a) => key.includes(a)).length;
  const extra = ans.filter((a) => !key.includes(a)).length;
  if (hit === key.length && extra === 0) return it.points;
  if (!ans.length) return 0;
  let pts = 0;
  if (key.length > 1 && exam.partial) pts = Math.max(0, (hit - extra) / key.length) * it.points;
  return pts > 0 ? pts : -(exam.penalty || 0);
}

function grade(answers) {
  let score = 0, max = 0;
  items.forEach((it, i) => {
    const s = itemScore(it, answers[i]);
    if (s === null) return;
    score += s;
    max += it.points;
  });
  return { score: Math.max(0, score), max };
}

function pendingReview() {
  return current.read.filter((r, i) => r.status === 'review' && !current.touched.has(i)).length;
}

const COLORS = { ok: '#1a9850', bad: '#d73027', rev: '#f39c12', key: '#2166ac', blank: '#888' };

function drawReview() {
  const { rect, layout } = current;
  const cv = $('review-canvas');
  cv.width = rect.w; cv.height = rect.h;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(rect.w, rect.h);
  for (let i = 0; i < rect.g.length; i++) {
    id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = rect.g[i];
    id.data[4 * i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const R = PX_PER_MM, b = layout.box * R, h = layout.roi * R;

  const list = [];
  layout.questions.forEach((q, i) => {
    const it = items[i], ans = current.answers[i];
    const s = itemScore(it, ans);
    const review = current.read[i].status === 'review' && !current.touched.has(i);
    q.cells.forEach((c, k) => {
      const x = c.x * R, y = c.y * R;
      if (it.key.includes(it.opts[k])) {
        ctx.strokeStyle = COLORS.key; ctx.lineWidth = 2;
        ctx.strokeRect(x - b / 2 - 3, y - b / 2 - 3, b + 6, b + 6);
      }
      if (ans.includes(k)) {
        ctx.fillStyle = (s === null ? COLORS.blank : s >= it.points ? COLORS.ok : COLORS.bad) + '66';
        ctx.fillRect(x - h, y - h, 2 * h, 2 * h);
      }
    });
    if (review) {
      const first = q.cells[0], last = q.cells[q.cells.length - 1];
      ctx.strokeStyle = COLORS.rev; ctx.lineWidth = 4;
      ctx.strokeRect(first.x * R - h - 3, first.y * R - h - 3, (last.x - first.x) * R + 2 * h + 6, 2 * h + 6);
      list.push(it.label);
    }
  });

  const g = grade(current.answers);
  $('score').textContent = `${fmt(g.score)} / ${fmt(g.max)}`;
  const n = pendingReview();
  $('review-count').textContent = n ? `${n} ítem(s) a revisar: ${list.join(', ')}` : 'Sin ítems pendientes de revisión';
  $('review-count').className = 'review-count' + (n ? ' pending' : '');
}

$('review-canvas').addEventListener('click', (ev) => {
  if (!current) return;
  const cv = ev.currentTarget, r = cv.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * cv.width / PX_PER_MM;
  const y = ((ev.clientY - r.top) / r.height) * cv.height / PX_PER_MM;
  const L = current.layout;
  L.questions.forEach((q, i) => {
    q.cells.forEach((c, k) => {
      if (Math.abs(c.x - x) <= L.roi && Math.abs(c.y - y) <= L.roi) {
        const ans = current.answers[i];
        const j = ans.indexOf(k);
        if (j >= 0) ans.splice(j, 1); else ans.push(k);
        ans.sort((a, b) => a - b);
        current.touched.add(i);
      }
    });
  });
  drawReview();
});

$('save-result').addEventListener('click', () => {
  if (!current) return;
  const n = pendingReview();
  if (n && !confirm(`Quedan ${n} ítem(s) marcados para revisar. ¿Guardar igual?`)) return;
  const g = grade(current.answers);
  results.push({
    name: $('student-name').value.trim() || `Hoja ${results.length + 1}`,
    id: $('student-id').value.trim(),
    score: g.score,
    max: g.max,
    answers: Object.fromEntries(items.map((it, i) => [it.label, current.answers[i].map((k) => it.opts[k]).join('')])),
    edits: [...current.touched].filter((i) => !sameSet(current.answers[i], current.read[i].marked)).length,
    date: new Date().toISOString(),
  });
  if (!save(STORE_RESULTS, results)) alert('Atención: no se pudo guardar en el dispositivo. Exportá el CSV antes de cerrar.');
  current = null;
  $('review').hidden = true;
  $('scan-error').hidden = true;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('use-as-key').addEventListener('click', () => {
  if (!current) return;
  if (!confirm('¿Reemplazar la clave con las marcas de esta hoja?')) return;
  items = items.map((it, i) => ({ ...it, key: current.answers[i].map((k) => it.opts[k]).join('') }));
  exam.text = examToText(items);
  save(STORE_EXAM, exam);
  fillExamForm();
  drawReview();
});

// ---------- 4. Resultados ----------
function renderResults() {
  const body = $('results-body');
  body.replaceChildren(
    ...results.map((r, i) => {
      const tr = document.createElement('tr');
      const cells = [r.name, r.id, `${fmt(r.score)} / ${fmt(r.max)}`, r.max ? `${fmt((100 * r.score) / r.max)} %` : '—', String(r.edits)];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      const td = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'small danger'; del.textContent = '✕';
      del.setAttribute('aria-label', `Borrar ${r.name}`);
      del.addEventListener('click', () => {
        if (!confirm(`¿Borrar el resultado de ${r.name}?`)) return;
        results.splice(i, 1);
        save(STORE_RESULTS, results);
        renderResults();
      });
      td.append(del);
      tr.append(td);
      return tr;
    })
  );
  if (results.length) {
    const p = results.map((r) => (r.max ? r.score / r.max : 0));
    const mean = p.reduce((a, b) => a + b, 0) / p.length;
    $('stats').textContent = `${results.length} hojas · promedio ${fmt(100 * mean)} %`;
  } else {
    $('stats').textContent = 'Todavía no hay hojas corregidas.';
  }
}

// CSV con ; y coma decimal (Excel en español). Se neutralizan fórmulas (=, +, -, @).
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
$('export-csv').addEventListener('click', () => {
  const labels = items.map((it) => it.label);
  const head = ['Estudiante', 'Legajo', 'Puntaje', 'Máximo', 'Porcentaje', 'Correcciones manuales', 'Fecha', ...labels];
  const rows = results.map((r) => [
    r.name, r.id, fmt(r.score), fmt(r.max), r.max ? fmt((100 * r.score) / r.max) : '', r.edits, r.date.slice(0, 10),
    ...labels.map((l) => r.answers[l] ?? ''),
  ]);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `notas-${slug(exam.title || 'examen')}.csv`);
});
$('clear-results').addEventListener('click', () => {
  if (!results.length || !confirm('¿Borrar TODOS los resultados guardados en este dispositivo?')) return;
  results = [];
  save(STORE_RESULTS, results);
  renderResults();
});

// ---------- Utilidades ----------
function fmt(n) {
  return (Math.round(n * 100) / 100).toLocaleString('es-AR');
}
function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'examen';
}
function sameSet(a, b) {
  return a.length === b.length && a.every((v) => b.includes(v));
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

fillExamForm();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
