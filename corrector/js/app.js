// Interfaz de la app. Sin dependencias externas, sin red: todo queda en el dispositivo.
import { parseExam, examToText, MAX_ITEMS } from './layout.js';
import { sheetSVG } from './sheet.js';
import { readSheet, OMRError, PX_PER_MM } from './omr.js';
import { readTableSheet } from './table.js';

const $ = (id) => document.getElementById(id);
const STORE_EXAM = 'corrector.v1.exam';
const STORE_RESULTS = 'corrector.v1.results';
const MAX_PHOTO_SIDE = 1600;
const LIVE_SIDE = 1400; // resolución de análisis de la cámara en vivo
const LIVE_CONFIRM = 2; // lecturas idénticas seguidas para aceptar

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
  format: 'table',
  text: examToText(Array.from({ length: 10 }, (_, i) => ({ label: String(i + 1), opts: 'abcd', key: '', points: 1 }))),
  partial: false,
  penalty: 0,
};

let exam = { ...DEFAULT_EXAM, ...load(STORE_EXAM, {}) };
let rows = parseExam(exam.text).items; // filas en el orden de la hoja (incluye las de desarrollo)
let items = rows.filter((r) => !r.skip); // ítems que se corrigen
let results = load(STORE_RESULTS, []);
let current = null; // corrección en curso

// ---------- Pestañas ----------
function showTab(name) {
  if (name !== 'scan') stopLive();
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
  document.querySelectorAll('input[name=format]').forEach((r) => (r.checked = r.value === exam.format));
}

$('gen-btn').addEventListener('click', () => {
  const n = Math.max(1, Math.min(MAX_ITEMS, Number($('gen-n').value) || 1));
  const opts = $('gen-opts').value.trim() || 'abcd';
  $('exam-key').value = examToText(Array.from({ length: n }, (_, i) => ({ label: String(i + 1), opts, key: '', points: 1 })));
});

$('exam-save').addEventListener('click', () => {
  const parsed = parseExam($('exam-key').value);
  const err = $('exam-errors');
  const format = document.querySelector('input[name=format]:checked')?.value || 'table';
  const errors = [...parsed.errors];
  if (format === 'table' && parsed.items.some((it) => it.opts.length > 5)) errors.push('La tabla impresa admite hasta 5 opciones (a–e).');
  if (errors.length) {
    err.textContent = errors.join(' ');
    err.hidden = false;
    $('exam-status').hidden = true;
    return;
  }
  err.hidden = true;
  exam = {
    title: $('exam-title').value.trim(),
    format,
    text: $('exam-key').value,
    partial: $('multi-partial').checked,
    penalty: Math.max(0, Number($('penalty').value) || 0),
  };
  rows = parsed.items;
  items = rows.filter((r) => !r.skip);
  const stored = save(STORE_EXAM, exam);
  const noKey = items.filter((it) => !it.key).length;
  const max = items.reduce((s, it) => s + (it.key ? it.points : 0), 0);
  $('exam-status').textContent =
    `${stored ? 'Guardado' : 'Aplicado (no se pudo guardar en el dispositivo)'}: ${items.length} ítems, máximo ${fmt(max)} puntos` +
    (noKey ? `, ${noKey} sin clave.` : '.');
  $('exam-status').hidden = false;
});

// ---------- 2. Hoja ----------
function renderSheet() {
  $('sheet-table-note').hidden = exam.format !== 'table';
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

// Lee una imagen y la lleva a un modelo común de revisión:
// imagen (gris) + para cada ítem, el polígono de cada opción y lo leído.
function analyze(imageData) {
  if (exam.format === 'table') {
    const out = readTableSheet(imageData, rows);
    const res = out.results.filter((r) => !r.skip);
    return {
      image: out.img,
      quads: res.map((r) => r.quads),
      read: res.map((r) => ({ marked: [...r.marked], status: r.status })),
    };
  }
  const out = readSheet(imageData, items);
  const R = PX_PER_MM, h = out.layout.roi;
  return {
    image: out.rect,
    quads: out.layout.questions.map((q) =>
      q.cells.map((c) => [[(c.x - h) * R, (c.y - h) * R], [(c.x + h) * R, (c.y - h) * R], [(c.x + h) * R, (c.y + h) * R], [(c.x - h) * R, (c.y + h) * R]])
    ),
    read: out.results.map((r) => ({ marked: [...r.marked], status: r.status })),
  };
}

function showReview(a) {
  current = { ...a, answers: a.read.map((r) => [...r.marked]), touched: new Set() };
  $('student-name').value = '';
  $('student-id').value = '';
  $('review').hidden = false;
  drawReview();
  $('review').scrollIntoView({ behavior: 'smooth' });
}

function showError(e) {
  $('scan-error').textContent = e instanceof OMRError ? e.message : `No se pudo procesar la imagen (${e.message}).`;
  $('scan-error').hidden = false;
  if (!(e instanceof OMRError)) console.error(e);
}

function frameData(source, sw, sh, maxSide) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function onPhoto(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  stopLive();
  $('scan-error').hidden = true;
  $('review').hidden = true;
  $('scan-busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // deja pintar "Procesando…"
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const img = frameData(bmp, bmp.width, bmp.height, MAX_PHOTO_SIDE);
    bmp.close?.();
    showReview(analyze(img));
  } catch (e) {
    showError(e);
  } finally {
    $('scan-busy').hidden = true;
  }
}
$('scan-input').addEventListener('change', onPhoto);
$('scan-gallery').addEventListener('change', onPhoto);

// --- Cámara en vivo: analiza cuadros hasta obtener la misma lectura dos veces seguidas.
let live = null;

async function startLive() {
  $('scan-error').hidden = true;
  $('review').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(new OMRError('Este navegador no permite usar la cámara en vivo. Usá «sacar una foto».'));
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const video = $('live-video');
    video.srcObject = stream;
    await video.play();
    live = { stream, last: null, same: 0, timer: 0 };
    $('live').hidden = false;
    $('live-start').hidden = true;
    setStatus('Buscando la tabla…', false);
    live.timer = setTimeout(liveTick, 300);
  } catch (e) {
    showError(new OMRError(`No se pudo abrir la cámara (${e.name === 'NotAllowedError' ? 'permiso denegado' : e.message}).`));
  }
}

function stopLive() {
  if (!live) return;
  clearTimeout(live.timer);
  live.stream.getTracks().forEach((t) => t.stop());
  $('live-video').srcObject = null;
  live = null;
  $('live').hidden = true;
  $('live-start').hidden = false;
}

function setStatus(text, found) {
  $('live-status').textContent = text;
  $('live-status').className = 'live-status' + (found ? ' found' : '');
}

function liveTick() {
  if (!live) return;
  const video = $('live-video');
  if (video.videoWidth) {
    try {
      const a = analyze(frameData(video, video.videoWidth, video.videoHeight, LIVE_SIDE));
      const sig = a.read.map((r) => r.marked.join('') + r.status[0]).join('|');
      live.same = sig === live.last ? live.same + 1 : 1;
      live.last = sig;
      if (live.same >= LIVE_CONFIRM) {
        stopLive();
        showReview(a);
        return;
      }
      setStatus('Tabla detectada · mantené quieto el celular…', true);
    } catch (e) {
      live.same = 0;
      live.last = null;
      setStatus(e instanceof OMRError ? e.message : 'Buscando la tabla…', false);
      if (!(e instanceof OMRError)) console.error(e);
    }
  }
  live.timer = setTimeout(liveTick, 150);
}

$('live-start').addEventListener('click', startLive);
$('live-stop').addEventListener('click', stopLive);
document.addEventListener('visibilitychange', () => document.hidden && stopLive());

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

function poly(ctx, q, grow = 0) {
  const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
  ctx.beginPath();
  q.forEach(([x, y], i) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    const X = x + ((x - cx) / d) * grow, Y = y + ((y - cy) / d) * grow;
    if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
  });
  ctx.closePath();
}

function drawReview() {
  const { image } = current;
  const cv = $('review-canvas');
  cv.width = image.w; cv.height = image.h;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(image.w, image.h);
  for (let i = 0; i < image.g.length; i++) {
    id.data[4 * i] = id.data[4 * i + 1] = id.data[4 * i + 2] = image.g[i];
    id.data[4 * i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const lw = Math.max(2, image.w / 400);

  const list = [];
  items.forEach((it, i) => {
    const quads = current.quads[i], ans = current.answers[i];
    const s = itemScore(it, ans);
    const review = current.read[i].status === 'review' && !current.touched.has(i);
    quads.forEach((q, k) => {
      if (ans.includes(k)) {
        ctx.fillStyle = (s === null ? COLORS.blank : s >= it.points ? COLORS.ok : COLORS.bad) + '66';
        poly(ctx, q);
        ctx.fill();
      }
      if (it.key.includes(it.opts[k])) {
        ctx.strokeStyle = COLORS.key; ctx.lineWidth = lw;
        poly(ctx, q, -lw);
        ctx.stroke();
      }
    });
    if (review) {
      const first = quads[0], last = quads[quads.length - 1];
      ctx.strokeStyle = COLORS.rev; ctx.lineWidth = 2 * lw;
      poly(ctx, [first[0], last[1], last[2], first[3]], lw);
      ctx.stroke();
      list.push(it.label);
    }
  });

  const g = grade(current.answers);
  $('score').textContent = `${fmt(g.score)} / ${fmt(g.max)}`;
  const n = pendingReview();
  $('review-count').textContent = n ? `${n} ítem(s) a revisar: ${list.join(', ')}` : 'Sin ítems pendientes de revisión';
  $('review-count').className = 'review-count' + (n ? ' pending' : '');
}

function inside(q, x, y) {
  let c = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

$('review-canvas').addEventListener('click', (ev) => {
  if (!current) return;
  const cv = ev.currentTarget, r = cv.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * cv.width;
  const y = ((ev.clientY - r.top) / r.height) * cv.height;
  current.quads.forEach((quads, i) => {
    quads.forEach((q, k) => {
      if (!inside(q, x, y)) return;
      const ans = current.answers[i];
      const j = ans.indexOf(k);
      if (j >= 0) ans.splice(j, 1); else ans.push(k);
      ans.sort((a, b) => a - b);
      current.touched.add(i);
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
  let i = 0;
  rows = rows.map((r) => (r.skip ? r : { ...r, key: current.answers[i++].map((k) => r.opts[k]).join('') }));
  items = rows.filter((r) => !r.skip);
  exam.text = examToText(rows);
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
  const rowsOut = results.map((r) => [
    r.name, r.id, fmt(r.score), fmt(r.max), r.max ? fmt((100 * r.score) / r.max) : '', r.edits, r.date.slice(0, 10),
    ...labels.map((l) => r.answers[l] ?? ''),
  ]);
  const csv = '﻿' + [head, ...rowsOut].map((row) => row.map(csvCell).join(';')).join('\r\n');
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
