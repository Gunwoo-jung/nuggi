'use strict';
/* 모든 처리는 메모리 안에서만 이뤄집니다. 이미지 데이터를 fetch/XHR/storage에 넘기는 코드는 없습니다. */

const MAX_PIXELS = 16_000_000; // iOS 캔버스 한도 내로 유지
const MODEL_LABEL = { general: '일반 모델', portrait: '인물 모델' };
const MODEL_SIZE = { general: '44MB', portrait: '7MB' };

const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const tpl = $('#itemTpl');
const fileInput = $('#file');
const drop = $('#drop');

const worker = new Worker('worker.js');
const pending = new Map();
let nextId = 1;
const loadedModels = new Set();

worker.onmessage = ({ data: msg }) => {
  if (msg.type === 'progress') {
    if (!loadedModels.has(msg.model)) showStatus(`${MODEL_LABEL[msg.model]} 불러오는 중 (${MODEL_SIZE[msg.model]}, 처음 한 번만)`, msg.value);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'error') p.reject(new Error(msg.message));
  else p.resolve(msg);
};

function callWorker(payload, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload }, transfer);
  });
}

function showStatus(text, value) {
  $('#status').hidden = false;
  $('#statusText').textContent = text;
  const bar = $('#statusBar');
  if (value == null) bar.removeAttribute('value'); else bar.value = value;
}
function hideStatus() { $('#status').hidden = true; }

const currentModel = () => document.querySelector('input[name=model]:checked').value;
function currentBg() {
  const v = document.querySelector('input[name=bg]:checked').value;
  return v === 'custom' ? $('#bgColor').value : v;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function decode(file) {
  // <img>는 모든 브라우저에서 EXIF 회전을 적용해 화면에 보이는 방향 그대로 디코딩한다
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function inputSize(model, w, h) {
  if (model === 'general') return [1024, 1024];
  const r32 = (v) => Math.max(32, Math.round(v / 32) * 32);
  let s = 512 / Math.min(w, h);
  const long = Math.max(w, h) * s;
  if (long > 1536) s *= 1536 / long;
  return [r32(w * s), r32(h * s)];
}

function toTensor(src, model) {
  const [w, h] = inputSize(model, src.width, src.height);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const out = new Float32Array(3 * n);
  const norm = model === 'general' ? (v) => v / 255 : (v) => v / 127.5 - 1;
  for (let i = 0; i < n; i++) {
    out[i] = norm(px[i * 4]);
    out[n + i] = norm(px[i * 4 + 1]);
    out[2 * n + i] = norm(px[i * 4 + 2]);
  }
  c.width = c.height = 0;
  return { data: out, width: w, height: h };
}

function applyMask(src, alpha, mw, mh) {
  // 잔여물 제거: 약한 알파(배경 잔여물)는 0으로, 거의 불투명한 부분은 255로 당김
  const s = Number($('#refine').value) / 100;
  const lo = 0.5 * s, hi = 1 - 0.3 * s, k = 1 / (hi - lo);
  const mask = new ImageData(mw, mh);
  for (let i = 0; i < alpha.length; i++) {
    const a = (alpha[i] - lo) * k;
    mask.data[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
  }
  const mc = makeCanvas(mw, mh);
  mc.getContext('2d').putImageData(mask, 0, 0);
  const out = makeCanvas(src.width, src.height);
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mc, 0, 0, src.width, src.height);
  mc.width = mc.height = 0;
  return out;
}

function canvasToBlob(c) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG 변환 실패'))), 'image/png'));
}

async function exportBlob(item) {
  const bg = currentBg();
  if (bg === 'transparent') return canvasToBlob(item.result);
  const c = makeCanvas(item.result.width, item.result.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(item.result, 0, 0);
  const b = await canvasToBlob(c);
  c.width = c.height = 0;
  return b;
}

/* ---------- items ---------- */

const items = new Set();
let queue = Promise.resolve();

function outName(name) {
  return (name.replace(/\.[^.]+$/, '') || 'image') + '-nukki.png';
}

function setUrl(img, blob) {
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = blob ? URL.createObjectURL(blob) : '';
}

function applyBgTo(item) {
  const bg = currentBg();
  item.stage.classList.toggle('solid', bg !== 'transparent');
  item.stage.style.backgroundColor = bg === 'transparent' ? '' : bg;
}

function updateCount() {
  $('#listHead').hidden = items.size === 0;
  $('#count').textContent = `${items.size}장`;
}

async function addFile(file) {
  if (!file.type.startsWith('image/')) return;
  const el = tpl.content.firstElementChild.cloneNode(true);
  const item = {
    el, file, name: file.name || 'image',
    stage: el.querySelector('.stage'),
    orig: el.querySelector('.orig'),
    res: el.querySelector('.res'),
    state: el.querySelector('.state'),
    source: null, result: null,
  };
  el.querySelector('.name').textContent = item.name;
  items.add(item);
  listEl.prepend(el);
  updateCount();
  applyBgTo(item);

  el.querySelector('.cmp').addEventListener('input', (e) => item.stage.style.setProperty('--pos', e.target.value + '%'));
  el.querySelector('.save').addEventListener('click', () => save(item));
  el.querySelector('.share').addEventListener('click', () => share(item));
  el.querySelector('.redo').addEventListener('click', () => enqueue(item));
  el.querySelector('.remove').addEventListener('click', () => removeItem(item));

  item.orig.addEventListener('load', () => {
    const { naturalWidth: w, naturalHeight: h } = item.orig;
    if (w && h) item.stage.style.aspectRatio = `${w} / ${h}`;
  }, { once: true });
  setUrl(item.orig, file);
  enqueue(item);
}

function setBusy(item, busy, text) {
  item.el.classList.toggle('busy', busy);
  item.state.textContent = text;
  for (const b of item.el.querySelectorAll('.save,.share,.redo')) b.disabled = busy || (!item.result && !b.classList.contains('redo'));
}

function enqueue(item) {
  setBusy(item, true, '대기 중');
  queue = queue.then(() => process(item)).catch(() => {});
}

async function process(item) {
  if (!items.has(item)) return;
  const model = currentModel();
  item.el.classList.remove('error');
  try {
    setBusy(item, true, '처리 중…');
    if (!item.source) item.source = await decode(item.file);
    const t0 = performance.now();
    const tensor = toTensor(item.source, model);
    const r = await callWorker({ type: 'run', model, data: tensor.data, width: tensor.width, height: tensor.height }, [tensor.data.buffer]);
    loadedModels.add(model);
    hideStatus();
    if (!items.has(item)) return;
    item.mask = r;
    await render(item);
    item.el.classList.add('done');
    item.el.querySelector('.cmp').value = 0;
    item.stage.style.setProperty('--pos', '0%');
    setBusy(item, false, `${MODEL_LABEL[model]} · ${((performance.now() - t0) / 1000).toFixed(1)}초`);
    const share = item.el.querySelector('.share');
    share.hidden = !canShareFiles();
  } catch (err) {
    console.error(err);
    hideStatus();
    item.el.classList.add('error');
    setBusy(item, false, '실패: ' + err.message);
  }
}

async function render(item) {
  if (item.result) item.result.width = item.result.height = 0;
  item.result = applyMask(item.source, item.mask.alpha, item.mask.width, item.mask.height);
  setUrl(item.res, await canvasToBlob(item.result));
}

function removeItem(item) {
  items.delete(item);
  setUrl(item.orig, null);
  setUrl(item.res, null);
  for (const c of [item.source, item.result]) if (c) c.width = c.height = 0;
  item.source = item.result = item.file = item.mask = null;
  item.el.remove();
  updateCount();
}

async function save(item) {
  const blob = await exportBlob(item);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = outName(item.name);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function canShareFiles() {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });
  } catch { return false; }
}

async function share(item) {
  const blob = await exportBlob(item);
  const file = new File([blob], outName(item.name), { type: 'image/png' });
  try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') save(item); }
}

/* ---------- input wiring ---------- */

function addFiles(files) { for (const f of files) addFile(f); }

fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== drop && !drop.contains(e.target)) addFiles(e.dataTransfer.files); });
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) addFiles(files);
});

document.querySelectorAll('input[name=bg]').forEach((r) => r.addEventListener('change', () => items.forEach(applyBgTo)));
$('#bgColor').addEventListener('input', () => {
  document.querySelector('input[name=bg][value=custom]').checked = true;
  items.forEach(applyBgTo);
});
$('#bgColor').addEventListener('click', () => {
  document.querySelector('input[name=bg][value=custom]').checked = true;
  items.forEach(applyBgTo);
});
let refineTimer;
function setRefine(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  $('#refine').value = v;
  $('#refineNum').value = v;
  for (const r of document.querySelectorAll('input[name=refineP]')) r.checked = Number(r.value) === v;
  clearTimeout(refineTimer);
  refineTimer = setTimeout(() => {
    for (const item of items) if (item.mask && !item.el.classList.contains('busy')) render(item);
  }, 120);
}
$('#refine').addEventListener('input', (e) => setRefine(e.target.value));
$('#refineNum').addEventListener('change', (e) => setRefine(e.target.value));
$('#refineNum').addEventListener('input', (e) => { if (e.target.value !== '' && e.target.validity.valid) setRefine(e.target.value); });
for (const r of document.querySelectorAll('input[name=refineP]')) r.addEventListener('change', () => setRefine(r.value));
$('#clearAll').addEventListener('click', () => [...items].forEach(removeItem));

/* ---------- offline support ---------- */

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // 서비스 워커가 격리 헤더를 붙이도록 최초 1회만 새로고침 (이미지를 넣기 전일 때만)
  navigator.serviceWorker.ready.then(() => {
    if (!window.crossOriginIsolated && items.size === 0 && !sessionStorage.getItem('coi-reload')) {
      sessionStorage.setItem('coi-reload', '1');
      location.reload();
    }
  });
}
function updateOffline() {
  $('#offline').textContent = navigator.onLine ? '' : '오프라인 상태 · 정상 동작 중';
}
window.addEventListener('online', updateOffline);
window.addEventListener('offline', updateOffline);
updateOffline();
