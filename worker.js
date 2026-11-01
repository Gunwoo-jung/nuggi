/* Runs the segmentation models off the main thread. Only receives pixel tensors; never touches the network except to load its own model files from the same origin. */
importScripts('vendor/ort.wasm.min.js');

const base = new URL('./', self.location.href).href;
ort.env.wasm.wasmPaths = base + 'vendor/';
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, self.navigator.hardwareConcurrency || 4)
  : 1;

const MODELS = {
  general: { url: 'models/ormbg.onnx', input: 'pixel_values' },
  portrait: { url: 'models/modnet.onnx', input: 'input' },
  matte: { url: 'models/vitmatte.onnx', input: 'pixel_values' },
};

const sessions = {};

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`모델 파일을 불러오지 못했습니다 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) onProgress(Math.min(1, loaded / total));
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function getSession(name) {
  if (!sessions[name]) {
    sessions[name] = (async () => {
      const bytes = await fetchWithProgress(MODELS[name].url, (value) =>
        postMessage({ type: 'progress', model: name, value }));
      postMessage({ type: 'progress', model: name, value: 1 });
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch((err) => { delete sessions[name]; throw err; });
  }
  return sessions[name];
}

self.onmessage = async ({ data: msg }) => {
  const { id, type, model } = msg;
  try {
    if (type === 'load') {
      await getSession(model);
      postMessage({ id, type: 'loaded', model });
      return;
    }
    if (type === 'run') {
      const session = await getSession(model);
      const input = new ort.Tensor('float32', msg.data, [1, msg.channels || 3, msg.height, msg.width]);
      const results = await session.run({ [MODELS[model].input]: input });
      const output = results[session.outputNames[0]];
      const [, , h, w] = output.dims;
      const alpha = output.data;
      input.dispose?.();
      postMessage({ id, type: 'result', alpha, width: w, height: h }, [alpha.buffer]);
    }
  } catch (err) {
    postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
