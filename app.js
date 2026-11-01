'use strict';
/* 모든 처리는 메모리 안에서만 이뤄집니다. 이미지 데이터를 fetch/XHR/storage에 넘기는 코드는 없습니다. */

const MAX_PIXELS = 16_000_000; // iOS 캔버스 한도 내로 유지
const PRECISE_MAX_PIXELS = 1_048_576;
const MODEL_LABEL = { general: '일반 모델', portrait: '인물 모델', matte: '정밀 보정 모델' };
const MODEL_SIZE = { general: '44MB', portrait: '7MB', matte: '27MB' };

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

function workSize(width, height) {
  const scale = Math.min(1, Math.sqrt(PRECISE_MAX_PIXELS / (width * height)));
  let w = Math.max(1, Math.floor(width * scale));
  let h = Math.max(1, Math.floor(height * scale));
  if (w * h > PRECISE_MAX_PIXELS) {
    if (w >= h) w = Math.max(1, Math.floor(PRECISE_MAX_PIXELS / h));
    else h = Math.max(1, Math.floor(PRECISE_MAX_PIXELS / w));
  }
  return [w, h];
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

function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const top = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
      const bottom = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
      out[y * dw + x] = top * (1 - wy) + bottom * wy;
    }
  }
  return out;
}

function integralImage(binary, w, h) {
  const stride = w + 1;
  const integral = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const rowOffset = (y + 1) * stride, aboveOffset = y * stride;
    for (let x = 0; x < w; x++) {
      row += binary[y * w + x];
      integral[rowOffset + x + 1] = integral[aboveOffset + x + 1] + row;
    }
  }
  return integral;
}

function rectSum(integral, stride, x0, y0, x1, y1) {
  return integral[y1 * stride + x1] - integral[y0 * stride + x1]
    - integral[y1 * stride + x0] + integral[y0 * stride + x0];
}

function makeTrimap(alpha, w, h) {
  const n = w * h;
  const binary = new Uint8Array(n);
  const soft = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    binary[i] = alpha[i] > 0.5 ? 1 : 0;
    soft[i] = alpha[i] > 0.03 && alpha[i] < 0.97 ? 1 : 0;
  }
  const binaryIntegral = integralImage(binary, w, h);
  const softIntegral = integralImage(soft, w, h);
  const r = Math.max(6, Math.round(0.02 * Math.min(w, h)));
  const softR = Math.floor(r / 2);
  const windowArea = (2 * r + 1) ** 2;
  const trimap = new Float32Array(n);
  trimap.fill(0.5);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const count = rectSum(binaryIntegral, w + 1, x0, y0, x1, y1);
      if (x0 === x - r && x1 === x + r + 1 && y0 === y - r && y1 === y + r + 1 && count === windowArea) {
        trimap[i] = 1;
      } else if (count === 0) {
        trimap[i] = 0;
      }
      const sx0 = Math.max(0, x - softR), sx1 = Math.min(w, x + softR + 1);
      const sy0 = Math.max(0, y - softR), sy1 = Math.min(h, y + softR + 1);
      if (rectSum(softIntegral, w + 1, sx0, sy0, sx1, sy1) > 0) trimap[i] = 0.5;
    }
  }
  return trimap;
}

async function refineAlpha(src, baseAlpha, baseWidth, baseHeight) {
  const [w, h] = workSize(src.width, src.height);
  const work = makeCanvas(w, h);
  const workCtx = work.getContext('2d', { willReadFrequently: true });
  workCtx.imageSmoothingQuality = 'high';
  workCtx.drawImage(src, 0, 0, w, h);
  const pixels = workCtx.getImageData(0, 0, w, h).data;
  const alpha = resizeBilinear(baseAlpha, baseWidth, baseHeight, w, h);
  const trimap = makeTrimap(alpha, w, h);
  const paddedWidth = Math.ceil(w / 32) * 32;
  const paddedHeight = Math.ceil(h / 32) * 32;
  const plane = paddedWidth * paddedHeight;
  const input = new Float32Array(plane * 4);
  for (let y = 0; y < paddedHeight; y++) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < paddedWidth; x++) {
      const sx = Math.min(x, w - 1);
      const srcI = (sy * w + sx) * 4;
      const dstI = y * paddedWidth + x;
      input[dstI] = (pixels[srcI] / 255 - 0.5) / 0.5;
      input[plane + dstI] = (pixels[srcI + 1] / 255 - 0.5) / 0.5;
      input[2 * plane + dstI] = (pixels[srcI + 2] / 255 - 0.5) / 0.5;
      input[3 * plane + dstI] = trimap[sy * w + sx];
    }
  }
  work.width = work.height = 0;
  const result = await callWorker({
    type: 'run', model: 'matte', data: input, channels: 4, width: paddedWidth, height: paddedHeight,
  }, [input.buffer]);
  const output = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      output[i] = trimap[i] === 1 ? 1 : trimap[i] === 0 ? 0 : Math.max(0, Math.min(1, result.alpha[y * paddedWidth + x]));
    }
  }
  alpha.fill(0);
  trimap.fill(0);
  return { alpha: output, width: w, height: h };
}

function boxBlur(data, w, h, radius, channels = 1) {
  const n = w * h;
  const horizontal = new Float32Array(n * channels);
  const output = new Float32Array(n * channels);
  const left = Math.floor((radius - 1) / 2);
  const right = radius - left - 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < channels; c++) {
      const row = y * w * channels + c;
      let sum = data[row] * (left + 1);
      const validRight = Math.min(right, w - 1);
      for (let x = 1; x <= validRight; x++) sum += data[row + x * channels];
      if (right > validRight) sum += data[row + validRight * channels] * (right - validRight);
      horizontal[row] = sum / radius;
      for (let x = 1; x < w; x++) {
        const remove = Math.max(0, Math.min(w - 1, x - left - 1));
        const add = Math.max(0, Math.min(w - 1, x + right));
        sum += data[row + add * channels] - data[row + remove * channels];
        horizontal[row + x * channels] = sum / radius;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < channels; c++) {
      const col = x * channels + c;
      let sum = horizontal[col] * (left + 1);
      const validBottom = Math.min(right, h - 1);
      for (let y = 1; y <= validBottom; y++) sum += horizontal[y * w * channels + col];
      if (right > validBottom) sum += horizontal[validBottom * w * channels + col] * (right - validBottom);
      output[col] = sum / radius;
      for (let y = 1; y < h; y++) {
        const remove = Math.max(0, Math.min(h - 1, y - left - 1));
        const add = Math.max(0, Math.min(h - 1, y + right));
        sum += horizontal[add * w * channels + col] - horizontal[remove * w * channels + col];
        output[y * w * channels + col] = sum / radius;
      }
    }
  }
  return output;
}

function thresholdAlpha(alpha) {
  const strength = Number($('#refine').value) / 100;
  const lo = 0.5 * strength, hi = 1 - 0.3 * strength, k = 1 / (hi - lo);
  const output = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) output[i] = Math.max(0, Math.min(1, (alpha[i] - lo) * k));
  return output;
}

function estimateForeground(image, alpha, w, h) {
  const n = w * h;
  const radius1 = Math.max(15, Math.round(90 * Math.min(w, h) / 1024));
  const alphaBlur1 = boxBlur(alpha, w, h, radius1);
  const weightedForeground = new Float32Array(n * 3);
  const weightedBackground = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = alpha[i], p = i * 4, q = i * 3;
    for (let c = 0; c < 3; c++) {
      const value = image[p + c] / 255;
      weightedForeground[q + c] = value * a;
      weightedBackground[q + c] = value * (1 - a);
    }
  }
  const blurredForeground = boxBlur(weightedForeground, w, h, radius1, 3);
  const blurredBackground = boxBlur(weightedBackground, w, h, radius1, 3);
  weightedForeground.fill(0);
  weightedBackground.fill(0);
  const foreground1 = new Float32Array(n * 3);
  const background1 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = alpha[i], ba = alphaBlur1[i], q = i * 3, p = i * 4;
    for (let c = 0; c < 3; c++) {
      const bf = blurredForeground[q + c] / (ba + 1e-5);
      const bb = blurredBackground[q + c] / (1 - ba + 1e-5);
      const value = image[p + c] / 255;
      foreground1[q + c] = Math.max(0, Math.min(1, bf + a * (value - a * bf - (1 - a) * bb)));
      background1[q + c] = bb;
    }
  }
  alphaBlur1.fill(0);
  blurredForeground.fill(0);
  blurredBackground.fill(0);

  const radius2 = 6;
  const alphaBlur2 = boxBlur(alpha, w, h, radius2);
  for (let i = 0; i < n; i++) {
    const a = alpha[i], q = i * 3;
    for (let c = 0; c < 3; c++) {
      weightedForeground[q + c] = foreground1[q + c] * a;
      weightedBackground[q + c] = background1[q + c] * (1 - a);
    }
  }
  const blurredForeground2 = boxBlur(weightedForeground, w, h, radius2, 3);
  const blurredBackground2 = boxBlur(weightedBackground, w, h, radius2, 3);
  weightedForeground.fill(0);
  weightedBackground.fill(0);
  foreground1.fill(0);
  background1.fill(0);
  const foreground2 = new Float32Array(n * 3);
  const background2 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ba = alphaBlur2[i], q = i * 3;
    for (let c = 0; c < 3; c++) {
      foreground2[q + c] = blurredForeground2[q + c] / (ba + 1e-5);
      background2[q + c] = blurredBackground2[q + c] / (1 - ba + 1e-5);
    }
  }
  alphaBlur2.fill(0);
  blurredForeground2.fill(0);
  blurredBackground2.fill(0);
  return { foreground: foreground2, background: background2 };
}

function applyMask(src, alpha, mw, mh) {
  if ($('#precise').checked) {
    const workAlpha = thresholdAlpha(alpha);
    const [w, h] = workSize(src.width, src.height);
    const work = makeCanvas(w, h);
    const workCtx = work.getContext('2d', { willReadFrequently: true });
    workCtx.imageSmoothingQuality = 'high';
    workCtx.drawImage(src, 0, 0, w, h);
    const workPixels = workCtx.getImageData(0, 0, w, h);
    const workImage = workPixels.data;
    const workMask = resizeBilinear(workAlpha, mw, mh, w, h);
    const { foreground, background } = estimateForeground(workImage, workMask, w, h);
    work.width = work.height = 0;

    const sourceCtx = src.getContext('2d', { willReadFrequently: true });
    const source = sourceCtx.getImageData(0, 0, src.width, src.height);
    const pixels = source.data;
    for (let y = 0; y < src.height; y++) {
      const wy = Math.max(0, (y + 0.5) * h / src.height - 0.5);
      const y0 = Math.floor(wy), y1 = Math.min(h - 1, y0 + 1), fy = wy - y0;
      for (let x = 0; x < src.width; x++) {
        const wx = Math.max(0, (x + 0.5) * w / src.width - 0.5);
        const x0 = Math.floor(wx), x1 = Math.min(w - 1, x0 + 1), fx = wx - x0;
        const p = y * src.width + x, i = p * 4;
        const a00 = workMask[y0 * w + x0], a10 = workMask[y0 * w + x1];
        const a01 = workMask[y1 * w + x0], a11 = workMask[y1 * w + x1];
        const a = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
        if (a <= 0) {
          pixels[i + 3] = 0;
          continue;
        }
        if (a >= 1) {
          pixels[i + 3] = 255;
          continue;
        }
        const b00 = y0 * w + x0;
        const b10 = y0 * w + x1, b01 = y1 * w + x0, b11 = y1 * w + x1;
        for (let c = 0; c < 3; c++) {
          const q00 = b00 * 3 + c, q10 = b10 * 3 + c, q01 = b01 * 3 + c, q11 = b11 * 3 + c;
          const bf0 = foreground[q00] * (1 - fx) + foreground[q10] * fx;
          const bf1 = foreground[q01] * (1 - fx) + foreground[q11] * fx;
          const bb0 = background[q00] * (1 - fx) + background[q10] * fx;
          const bb1 = background[q01] * (1 - fx) + background[q11] * fx;
          const bf = bf0 * (1 - fy) + bf1 * fy, bb = bb0 * (1 - fy) + bb1 * fy;
          const value = pixels[i + c] / 255;
          pixels[i + c] = 255 * Math.max(0, Math.min(1, bf + a * (value - a * bf - (1 - a) * bb)));
        }
        pixels[i + 3] = 255 * a;
      }
    }
    const out = makeCanvas(src.width, src.height);
    out.getContext('2d').putImageData(source, 0, 0);
    workPixels.data.fill(0);
    workMask.fill(0);
    workAlpha.fill(0);
    foreground.fill(0);
    background.fill(0);
    return out;
  }

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
  el.querySelector('.edit').addEventListener('click', () => openEditor(item));
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
  for (const b of item.el.querySelectorAll('.save,.share,.edit,.redo')) b.disabled = busy || (!item.result && !b.classList.contains('redo'));
}

function enqueue(item) {
  setBusy(item, true, '대기 중');
  queue = queue.then(() => process(item)).catch(() => {});
}

async function process(item) {
  if (!items.has(item)) return;
  const model = currentModel();
  const precise = $('#precise').checked;
  item.el.classList.remove('error');
  try {
    setBusy(item, true, '처리 중…');
    if (!item.source) item.source = await decode(item.file);
    const t0 = performance.now();
    const tensor = toTensor(item.source, model);
    const r = await callWorker({ type: 'run', model, data: tensor.data, width: tensor.width, height: tensor.height }, [tensor.data.buffer]);
    loadedModels.add(model);
    if (!items.has(item)) return;
    const mask = precise ? await refineAlpha(item.source, r.alpha, r.width, r.height) : r;
    if (!items.has(item)) return;
    item.mask = mask;
    if (precise) loadedModels.add('matte');
    hideStatus();
    await render(item);
    item.el.classList.add('done');
    item.el.querySelector('.cmp').value = 0;
    item.stage.style.setProperty('--pos', '0%');
    setBusy(item, false, `${MODEL_LABEL[model]}${precise ? ' + 정밀 보정' : ''} · ${((performance.now() - t0) / 1000).toFixed(1)}초`);
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

/* ---------- editor ---------- */

const editorDialog = $('#editor');
const editorCanvas = $('#editorCanvas');
const editorHint = $('#editorHint');
const editorBusy = $('#editorBusy');
const editorUndo = $('#editorUndo');
const editorToolHints = {
  rerun: '머리카락이나 어두운 부분이 날아간 곳을 문지르세요. 그 부분만 크게 잘라 AI가 다시 봅니다.',
  erase: '남은 배경을 문질러 지웁니다.',
  restore: '잘못 지워진 부분을 문질러 원본에서 되살립니다.',
  pan: '드래그로 이동합니다. 확대는 휠이나 두 손가락으로 할 수 있어요.',
};
let editorState = null;

function editorTool() {
  return editorDialog.querySelector('input[name=tool]:checked').value;
}

function showEditorHint(text, error = false) {
  editorHint.textContent = text;
  editorHint.classList.toggle('error', error);
}

function updateEditorControls() {
  if (!editorState) return;
  const disabled = editorState.busy || editorState.applying;
  for (const control of editorDialog.querySelectorAll('input,button')) control.disabled = disabled;
  editorUndo.disabled = disabled || editorState.undo.length === 0;
  $('#editorApply').disabled = disabled;
  $('#editorCancel').disabled = disabled;
  editorBusy.hidden = !editorState.busy;
}

function updateEditorComposite(state, x, y, w, h) {
  for (let row = y; row < y + h; row++) {
    let i = row * state.width + x;
    for (let col = 0; col < w; col++, i++) state.composite.data[i * 4 + 3] = Math.round(state.alpha[i] * 255);
  }
  state.resultContext.putImageData(state.composite, 0, 0, x, y, w, h);
}

function pushEditorUndo(state, diff) {
  state.undo.push(diff);
  if (state.undo.length > 30) {
    const removed = state.undo.shift();
    removed.prev.fill(0);
  }
  updateEditorControls();
}

function updateEditorBackground() {
  const workspace = $('#editorWorkspace');
  const bg = currentBg();
  workspace.classList.toggle('solid', bg !== 'transparent');
  workspace.style.backgroundColor = bg === 'transparent' ? '' : bg;
}

function openEditor(item) {
  if (editorDialog.open || !item.source || !item.mask || !item.result) return;
  const [width, height] = workSize(item.source.width, item.source.height);
  const alpha = resizeBilinear(item.mask.alpha, item.mask.width, item.mask.height, width, height);
  const sourceCanvas = makeCanvas(width, height);
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.imageSmoothingQuality = 'high';
  sourceContext.drawImage(item.source, 0, 0, width, height);
  const source = sourceContext.getImageData(0, 0, width, height);
  const resultCanvas = makeCanvas(width, height);
  const resultContext = resultCanvas.getContext('2d', { willReadFrequently: true });
  const composite = resultContext.createImageData(width, height);
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4;
    composite.data[p] = source.data[p];
    composite.data[p + 1] = source.data[p + 1];
    composite.data[p + 2] = source.data[p + 2];
    composite.data[p + 3] = Math.round(alpha[i] * 255);
  }
  resultContext.putImageData(composite, 0, 0);
  const highlightCanvas = makeCanvas(width, height);
  const highlightContext = highlightCanvas.getContext('2d');
  editorState = {
    item, width, height, alpha, source, sourceCanvas, resultCanvas, resultContext, composite,
    highlightCanvas, highlightContext, undo: [], pointers: new Map(), stroke: null, pinch: null,
    panPointer: null, cursor: null, scale: 0, fitScale: 0, offsetX: 0, offsetY: 0,
    busy: false, dpr: 0,
  };
  editorDialog.querySelector('input[name=tool][value=rerun]').checked = true;
  $('#brushSize').value = 40;
  $('#brushValue').value = '40px';
  $('#editorOverlay').checked = false;
  showEditorHint(editorToolHints.rerun);
  updateEditorControls();
  updateEditorBackground();
  editorDialog.showModal();
  requestAnimationFrame(() => resizeEditorCanvas(true));
}

function disposeEditor(state) {
  if (state.alpha && !state.keepAlpha) state.alpha.fill(0);
  if (state.composite) state.composite.data.fill(0);
  if (state.source) state.source.data.fill(0);
  if (state.stroke?.mask) state.stroke.mask.fill(0);
  if (state.stroke?.before) state.stroke.before.clear();
  for (const diff of state.undo) diff.prev.fill(0);
  state.undo.length = 0;
  for (const canvas of [state.sourceCanvas, state.resultCanvas, state.highlightCanvas, editorCanvas]) {
    canvas.width = canvas.height = 0;
  }
  state.item = state.source = state.alpha = state.composite = null;
}

function closeEditor() {
  if (editorDialog.open) editorDialog.close();
  else if (editorState) {
    disposeEditor(editorState);
    editorState = null;
  }
}

async function applyEditor() {
  const state = editorState;
  if (!state || state.busy || state.applying) return;
  const previousMask = state.item.mask;
  state.item.mask = { alpha: state.alpha, width: state.width, height: state.height };
  state.applying = true;
  updateEditorControls();
  try {
    await render(state.item);
    state.keepAlpha = true;
    editorDialog.close();
  } catch (err) {
    state.item.mask = previousMask;
    try { await render(state.item); } catch {}
    state.applying = false;
    showEditorHint(`적용 실패: ${err.message}`, true);
    updateEditorControls();
  }
}

function resizeEditorCanvas(refit = false) {
  if (!editorState) return;
  const state = editorState;
  const rect = editorCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
  if (editorCanvas.width !== pixelWidth || editorCanvas.height !== pixelHeight) {
    editorCanvas.width = pixelWidth;
    editorCanvas.height = pixelHeight;
  }
  state.dpr = dpr;
  if (refit || !state.scale) {
    state.fitScale = Math.min(rect.width / state.width, rect.height / state.height);
    state.scale = state.fitScale;
    state.offsetX = (rect.width - state.width * state.scale) / 2;
    state.offsetY = (rect.height - state.height * state.scale) / 2;
  }
  drawEditor();
}

function drawEditor() {
  if (!editorState) return;
  const state = editorState;
  const ctx = editorCanvas.getContext('2d');
  const dpr = state.dpr || window.devicePixelRatio || 1;
  const width = editorCanvas.width / dpr, height = editorCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(dpr * state.scale, 0, 0, dpr * state.scale, dpr * state.offsetX, dpr * state.offsetY);
  if ($('#editorOverlay').checked) {
    ctx.globalAlpha = 0.35;
    ctx.drawImage(state.sourceCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }
  ctx.drawImage(state.resultCanvas, 0, 0);
  if (state.stroke?.tool === 'rerun') ctx.drawImage(state.highlightCanvas, 0, 0);
  if (state.cursor && !state.busy) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = Number($('#brushSize').value);
    ctx.beginPath();
    ctx.arc(state.cursor.x, state.cursor.y, size / 2, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = editorTool() === 'rerun' ? '#537aff' : '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(state.cursor.x, state.cursor.y, size / 2 + 1, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.stroke();
  }
}

function editorPoint(event) {
  const rect = editorCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function imagePoint(state, point) {
  return { x: (point.x - state.offsetX) / state.scale, y: (point.y - state.offsetY) / state.scale };
}

function includeStrokeBounds(stroke, x0, y0, x1, y1) {
  if (stroke.x0 == null) {
    stroke.x0 = x0; stroke.y0 = y0; stroke.x1 = x1; stroke.y1 = y1;
    return;
  }
  stroke.x0 = Math.min(stroke.x0, x0);
  stroke.y0 = Math.min(stroke.y0, y0);
  stroke.x1 = Math.max(stroke.x1, x1);
  stroke.y1 = Math.max(stroke.y1, y1);
}

function paintEditorStamp(state, stroke, x, y) {
  if (x < 0 || y < 0 || x >= state.width || y >= state.height) return;
  const radius = stroke.radius;
  const x0 = Math.max(0, Math.floor(x - radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const x1 = Math.min(state.width, Math.ceil(x + radius) + 1);
  const y1 = Math.min(state.height, Math.ceil(y + radius) + 1);
  const radius2 = radius * radius;
  let dirty = false;
  for (let py = y0; py < y1; py++) {
    const dy = py + 0.5 - y;
    for (let px = x0; px < x1; px++) {
      const dx = px + 0.5 - x;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) continue;
      const index = py * state.width + px;
      if (stroke.tool === 'rerun') {
        stroke.mask[index] = 1;
        continue;
      }
      const k = distance <= radius * 0.7 ? 1 : (radius - distance) / (radius * 0.3);
      const oldAlpha = state.alpha[index];
      const newAlpha = stroke.tool === 'erase' ? Math.min(oldAlpha, 1 - k) : Math.max(oldAlpha, k);
      if (newAlpha === oldAlpha) continue;
      if (!stroke.before.has(index)) stroke.before.set(index, oldAlpha);
      state.alpha[index] = newAlpha;
      state.composite.data[index * 4 + 3] = Math.round(newAlpha * 255);
      dirty = true;
    }
  }
  includeStrokeBounds(stroke, x0, y0, x1, y1);
  if (dirty) state.resultContext.putImageData(state.composite, 0, 0, x0, y0, x1 - x0, y1 - y0);
  if (stroke.tool === 'rerun') {
    const ctx = state.highlightContext;
    ctx.fillStyle = 'rgba(80,120,255,.35)';
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function stampEditorLine(state, stroke, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const spacing = Math.max(0.5, stroke.radius / 4);
  const steps = Math.max(1, Math.ceil(distance / spacing));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    paintEditorStamp(state, stroke, from.x + dx * t, from.y + dy * t);
  }
  stroke.last = to;
}

function editorDiffFromStroke(state, stroke) {
  if (!stroke.before.size || stroke.x0 == null) return null;
  const x = stroke.x0, y = stroke.y0, w = stroke.x1 - stroke.x0, h = stroke.y1 - stroke.y0;
  const prev = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const start = (y + row) * state.width + x;
    prev.set(state.alpha.subarray(start, start + w), row * w);
  }
  for (const [index, value] of stroke.before) {
    const px = index % state.width, py = Math.floor(index / state.width);
    prev[(py - y) * w + px - x] = value;
  }
  return { x, y, w, h, prev };
}

function rollbackEditorStroke(state) {
  const stroke = state.stroke;
  if (!stroke) return;
  if (stroke.tool !== 'rerun' && stroke.before.size && stroke.x0 != null) {
    for (const [index, value] of stroke.before) {
      state.alpha[index] = value;
      state.composite.data[index * 4 + 3] = Math.round(value * 255);
    }
    state.resultContext.putImageData(state.composite, 0, 0, stroke.x0, stroke.y0, stroke.x1 - stroke.x0, stroke.y1 - stroke.y0);
  }
  if (stroke.mask) stroke.mask.fill(0);
  stroke.before.clear();
  state.highlightContext.clearRect(0, 0, state.width, state.height);
  state.stroke = null;
  drawEditor();
}

function finishEditorStroke(state, stroke) {
  if (stroke.tool !== 'rerun') {
    const diff = editorDiffFromStroke(state, stroke);
    if (diff) pushEditorUndo(state, diff);
    state.stroke = null;
    drawEditor();
    return;
  }
  state.stroke = null;
  void runEditorRerun(state, stroke);
}

function clampEditorZoom(state, scale) {
  return Math.max(state.fitScale * 0.5, Math.min(state.fitScale * 16, scale));
}

function setupEditorPinch(state) {
  const points = [...state.pointers.values()];
  if (points.length < 2) return;
  const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
  const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  state.pinch = {
    distance: Math.max(1, Math.hypot(dx, dy)), scale: state.scale, midpoint,
    worldX: (midpoint.x - state.offsetX) / state.scale,
    worldY: (midpoint.y - state.offsetY) / state.scale,
  };
}

editorCanvas.addEventListener('pointerdown', (event) => {
  if (!editorState || editorState.busy) return;
  const state = editorState;
  const point = editorPoint(event);
  state.cursor = point;
  state.pointers.set(event.pointerId, point);
  try { editorCanvas.setPointerCapture(event.pointerId); } catch {}
  if (state.pointers.size >= 2) {
    if (state.stroke) rollbackEditorStroke(state);
    state.panPointer = null;
    setupEditorPinch(state);
    drawEditor();
    event.preventDefault();
    return;
  }
  if (editorTool() === 'pan' || (event.pointerType === 'mouse' && event.button === 1)) {
    state.panPointer = event.pointerId;
    state.panLast = point;
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  const image = imagePoint(state, point);
  if (image.x < 0 || image.y < 0 || image.x >= state.width || image.y >= state.height) return;
  const radius = Number($('#brushSize').value) / 2 / state.scale;
  const tool = editorTool();
  state.stroke = {
    tool, radius, last: image, before: new Map(),
    mask: tool === 'rerun' ? new Uint8Array(state.width * state.height) : null,
    x0: null, y0: null, x1: null, y1: null,
  };
  state.strokePointer = event.pointerId;
  paintEditorStamp(state, state.stroke, image.x, image.y);
  drawEditor();
  event.preventDefault();
});

editorCanvas.addEventListener('pointermove', (event) => {
  if (!editorState) return;
  const state = editorState;
  const point = editorPoint(event);
  state.cursor = point;
  if (state.pointers.has(event.pointerId)) state.pointers.set(event.pointerId, point);
  if (state.pinch && state.pointers.size >= 2) {
    const points = [...state.pointers.values()];
    const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
    const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    state.scale = clampEditorZoom(state, state.pinch.scale * Math.hypot(dx, dy) / state.pinch.distance);
    state.offsetX = midpoint.x - state.pinch.worldX * state.scale;
    state.offsetY = midpoint.y - state.pinch.worldY * state.scale;
    drawEditor();
  } else if (state.panPointer === event.pointerId) {
    state.offsetX += point.x - state.panLast.x;
    state.offsetY += point.y - state.panLast.y;
    state.panLast = point;
    drawEditor();
  } else if (state.stroke && state.strokePointer === event.pointerId) {
    stampEditorLine(state, state.stroke, state.stroke.last, imagePoint(state, point));
    drawEditor();
  } else {
    drawEditor();
  }
});

function releaseEditorPointer(event, cancelled = false) {
  if (!editorState) return;
  const state = editorState;
  if (state.stroke && state.strokePointer === event.pointerId) {
    const stroke = state.stroke;
    if (cancelled) rollbackEditorStroke(state);
    else finishEditorStroke(state, stroke);
  }
  state.pointers.delete(event.pointerId);
  if (state.pointers.size < 2) state.pinch = null;
  if (state.panPointer === event.pointerId) state.panPointer = null;
  if (editorCanvas.hasPointerCapture(event.pointerId)) editorCanvas.releasePointerCapture(event.pointerId);
  if (!state.pointers.size && event.pointerType !== 'mouse') state.cursor = null;
  drawEditor();
}

editorCanvas.addEventListener('pointerup', (event) => releaseEditorPointer(event));
editorCanvas.addEventListener('pointercancel', (event) => releaseEditorPointer(event, true));
editorCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
editorCanvas.addEventListener('wheel', (event) => {
  if (!editorState) return;
  const state = editorState;
  const point = editorPoint(event);
  const world = imagePoint(state, point);
  state.scale = clampEditorZoom(state, state.scale * Math.exp(-event.deltaY * 0.001));
  state.offsetX = point.x - world.x * state.scale;
  state.offsetY = point.y - world.y * state.scale;
  drawEditor();
  event.preventDefault();
}, { passive: false });

editorDialog.querySelectorAll('input[name=tool]').forEach((radio) => radio.addEventListener('change', () => {
  showEditorHint(editorToolHints[editorTool()]);
  drawEditor();
}));
$('#brushSize').addEventListener('input', (event) => {
  $('#brushValue').value = `${event.target.value}px`;
  drawEditor();
});
$('#editorOverlay').addEventListener('change', drawEditor);
editorUndo.addEventListener('click', () => {
  if (!editorState || editorState.busy) return;
  const state = editorState;
  const diff = state.undo.pop();
  if (!diff) return;
  for (let row = 0; row < diff.h; row++) {
    const dest = (diff.y + row) * state.width + diff.x;
    const src = row * diff.w;
    state.alpha.set(diff.prev.subarray(src, src + diff.w), dest);
    for (let col = 0; col < diff.w; col++) state.composite.data[(dest + col) * 4 + 3] = Math.round(diff.prev[src + col] * 255);
  }
  state.resultContext.putImageData(state.composite, 0, 0, diff.x, diff.y, diff.w, diff.h);
  diff.prev.fill(0);
  updateEditorControls();
  drawEditor();
});
$('#editorCancel').addEventListener('click', closeEditor);
$('#editorApply').addEventListener('click', () => { void applyEditor(); });
editorDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!editorState?.busy && !editorState?.applying) closeEditor();
});
editorDialog.addEventListener('close', () => {
  if (editorState) {
    disposeEditor(editorState);
    editorState = null;
  }
});
window.addEventListener('resize', () => resizeEditorCanvas(true));

async function runEditorRerun(state, stroke) {
  if (!stroke || stroke.x0 == null) return;
  const radius = stroke.radius;
  const paddingX = Math.max(radius, (stroke.x1 - stroke.x0) * 0.2);
  const paddingY = Math.max(radius, (stroke.y1 - stroke.y0) * 0.2);
  const x = Math.max(0, Math.floor(stroke.x0 - paddingX));
  const y = Math.max(0, Math.floor(stroke.y0 - paddingY));
  const x2 = Math.min(state.width, Math.ceil(stroke.x1 + paddingX));
  const y2 = Math.min(state.height, Math.ceil(stroke.y1 + paddingY));
  const width = x2 - x, height = y2 - y;
  const contextWidth = Math.min(state.width, Math.max(width * 2, Math.round(state.width * 0.6)));
  const contextHeight = Math.min(state.height, Math.max(height * 2, Math.round(state.height * 0.6)));
  const contextX = Math.max(0, Math.min(state.width - contextWidth, Math.round(x + (width - contextWidth) / 2)));
  const contextY = Math.max(0, Math.min(state.height - contextHeight, Math.round(y + (height - contextHeight) / 2)));
  const source = state.item.source;
  const contextX2 = contextX + contextWidth, contextY2 = contextY + contextHeight;
  const sourceX = Math.max(0, Math.floor(contextX * source.width / state.width));
  const sourceY = Math.max(0, Math.floor(contextY * source.height / state.height));
  const sourceX2 = Math.min(source.width, Math.ceil(contextX2 * source.width / state.width));
  const sourceY2 = Math.min(source.height, Math.ceil(contextY2 * source.height / state.height));
  const sourceWidth = sourceX2 - sourceX, sourceHeight = sourceY2 - sourceY;
  const scale = Math.min(4, 1024 / Math.max(sourceWidth, sourceHeight));
  const crop = makeCanvas(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)));
  const cropContext = crop.getContext('2d', { willReadFrequently: true });
  cropContext.imageSmoothingQuality = 'high';
  cropContext.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height);
  const selection = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const maskOffset = (y + row) * state.width + x;
    for (let col = 0; col < width; col++) selection[row * width + col] = stroke.mask[maskOffset + col];
  }
  const previous = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    const start = (y + row) * state.width + x;
    previous.set(state.alpha.subarray(start, start + width), row * width);
  }
  const diff = { x, y, w: width, h: height, prev: previous };
  stroke.mask.fill(0);
  state.busy = true;
  updateEditorControls();
  showEditorHint('다시 보는 중…');
  const started = performance.now();
  let alphaResult = null;
  let contextAlpha = null;
  let newAlpha = null;
  try {
    const model = currentModel();
    const tensor = toTensor(crop, model);
    const result = await callWorker({ type: 'run', model, data: tensor.data, width: tensor.width, height: tensor.height }, [tensor.data.buffer]);
    loadedModels.add(model);
    let refined = result;
    if ($('#precise').checked) {
      refined = await refineAlpha(crop, result.alpha, result.width, result.height);
      loadedModels.add('matte');
    }
    alphaResult = refined.alpha;
    contextAlpha = resizeBilinear(alphaResult, refined.width, refined.height, contextWidth, contextHeight);
    newAlpha = new Float32Array(width * height);
    const contextOffsetX = x - contextX, contextOffsetY = y - contextY;
    for (let row = 0; row < height; row++) {
      const start = (contextOffsetY + row) * contextWidth + contextOffsetX;
      newAlpha.set(contextAlpha.subarray(start, start + width), row * width);
    }
    const blurRadius = Math.max(2, Math.round(radius / 3));
    const weights = boxBlur(selection, width, height, blurRadius);
    let changed = false;
    for (let i = 0; i < previous.length; i++) {
      const weight = Math.max(0, Math.min(1, weights[i]));
      const next = weight * newAlpha[i] + (1 - weight) * previous[i];
      if (Math.abs(next - previous[i]) > 1e-7) changed = true;
      state.alpha[(y + Math.floor(i / width)) * state.width + x + (i % width)] = next;
      state.composite.data[((y + Math.floor(i / width)) * state.width + x + (i % width)) * 4 + 3] = Math.round(next * 255);
    }
    state.resultContext.putImageData(state.composite, 0, 0, x, y, width, height);
    if (changed) pushEditorUndo(state, diff);
    else diff.prev.fill(0);
    showEditorHint(`다시 보기를 마쳤습니다 · ${((performance.now() - started) / 1000).toFixed(1)}초`);
    hideStatus();
    drawEditor();
  } catch (err) {
    console.error(err);
    hideStatus();
    showEditorHint(`다시 보기 실패: ${err.message}`, true);
  } finally {
    crop.width = crop.height = 0;
    selection.fill(0);
    if (editorState === state) {
      state.busy = false;
      state.highlightContext.clearRect(0, 0, state.width, state.height);
      updateEditorControls();
      drawEditor();
    }
    if (alphaResult) alphaResult.fill(0);
    if (contextAlpha) contextAlpha.fill(0);
    if (newAlpha) newAlpha.fill(0);
  }
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
$('#precise').addEventListener('change', () => {
  for (const item of items) if (item.source) enqueue(item);
});
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
