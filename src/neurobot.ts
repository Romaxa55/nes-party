import type { NES } from "jsnes";
import { MASKS, type ButtonMask } from "./controls";
import type { Bot } from "./bot";

/**
 * Нейро-бот: политика, обученная RL в ~/nes-rl, играет за P2.
 * Сеть — MLP 472→256→256→10, веса приходят JSON'ом (base64-float32) и
 * считаются прямо здесь: ~190k умножений на решение при 30 Гц — копейки,
 * зато без onnxruntime и wasm в бандле.
 *
 * Наблюдение бит-в-бит повторяет BattleCityEnv._obs() (python) и
 * scripts/bot-dataset.mts: танки 8×5, пули 8×3, карта 13×13, орёл/ствол/
 * время; стек из двух последних кадров — сеть видит скорости.
 */

const EMPTY = 0xff;
const MAX_FRAMES = 120 * 60;
/** Действия в порядке ACTIONS из battle_city_env.py. */
const ACTION_MASKS: ButtonMask[] = [
  0,
  MASKS.UP,
  MASKS.DOWN,
  MASKS.LEFT,
  MASKS.RIGHT,
  MASKS.A,
  MASKS.UP | MASKS.A,
  MASKS.DOWN | MASKS.A,
  MASKS.LEFT | MASKS.A,
  MASKS.RIGHT | MASKS.A,
];

interface Layer {
  shape: number[];
  data: string;
}
interface PolicyJson {
  checkpoint: string;
  obs: number;
  actions: number;
  layers: Layer[];
}

function decode(l: Layer): Float32Array {
  const raw = atob(l.data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  // numpy.tobytes() в export_json.py пишет little-endian (нативный порядок
  // всех наших машин); Float32Array читает в порядке платформы браузера —
  // на BE-платформе вышел бы мусор, но таких целей у нас нет.
  return new Float32Array(bytes.buffer);
}

/** y = W·x + b, затем ReLU (для скрытых слоёв). */
function dense(
  x: Float32Array,
  w: Float32Array,
  b: Float32Array,
  rows: number,
  cols: number,
  relu: boolean,
): Float32Array {
  const y = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let acc = b[r];
    const off = r * cols;
    for (let c = 0; c < cols; c++) acc += w[off + c] * x[c];
    y[r] = relu && acc < 0 ? 0 : acc;
  }
  return y;
}

export async function loadNeuroBot(
  nes: NES,
  setButtons: (mask: ButtonMask) => void,
  modelUrl: string,
): Promise<Bot> {
  const res = await fetch(modelUrl, { credentials: "omit" });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const spec = (await res.json()) as PolicyJson;
  // Валидация до запуска таймера: битый/усечённый JSON должен уронить этот
  // промис (его ловит host-page), а не dense() внутри setInterval 30 раз/с.
  if (
    !Array.isArray(spec.layers) ||
    spec.layers.length !== 6 ||
    !Number.isInteger(spec.obs) ||
    spec.obs % 2 !== 0 ||
    !Number.isInteger(spec.actions) ||
    spec.actions !== ACTION_MASKS.length
  )
    throw new Error("model JSON malformed");
  const [w1, b1, w2, b2, w3, b3] = spec.layers.map(decode);
  const h1 = spec.layers[0].shape[0];
  const h2 = spec.layers[2].shape[0];
  const nObs = spec.obs;
  if (
    w1.length !== h1 * nObs ||
    b1.length !== h1 ||
    w2.length !== h2 * h1 ||
    b2.length !== h2 ||
    w3.length !== spec.actions * h2 ||
    b3.length !== spec.actions
  )
    throw new Error("model weight shapes mismatch");

  const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;

  const single = nObs / 2; // стек из двух кадров
  const hist: Float32Array[] = [];
  let frame = 0;
  let paused = true;
  let mode = "neuro";

  const obsNow = (): Float32Array => {
    const o = new Float32Array(single);
    let i = 0;
    const mex = mem[0x91];
    const mey = mem[0x99];
    const meAlive = mex !== EMPTY && mey !== EMPTY;
    for (let s = 0; s < 8; s++) {
      const x = mem[0x90 + s];
      const y = mem[0x98 + s];
      const alive = x !== EMPTY && y !== EMPTY;
      o[i++] = alive ? 1 : 0;
      o[i++] = alive ? x / 255 : 0;
      o[i++] = alive ? y / 255 : 0;
      o[i++] = alive && meAlive ? (x - mex) / 255 : 0;
      o[i++] = alive ? (mem[0xa0 + s] & 3) / 3 : 0;
    }
    for (let s = 0; s < 8; s++) {
      const x = mem[0xb8 + s];
      const y = mem[0xc2 + s];
      const alive = x !== EMPTY && y !== EMPTY;
      o[i++] = alive ? 1 : 0;
      o[i++] = alive ? x / 255 : 0;
      o[i++] = alive ? y / 255 : 0;
    }
    for (let ty = 0; ty < 13; ty++) {
      for (let tx = 0; tx < 13; tx++) {
        let v = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const t = mem[0x400 + (2 + ty * 2 + dy) * 32 + 2 + tx * 2 + dx];
            if (t === 0x10 || t === 0x11) v = Math.max(v, 1);
            else if (t >= 1 && t <= 0x0f) v = Math.max(v, 0.5);
          }
        }
        o[i++] = v;
      }
    }
    o[i++] = mem[0x400 + 26 * 32 + 14] === 0xc8 ? 1 : 0;
    o[i++] = (mem[0xa1] & 3) / 3;
    o[i++] = Math.min(1, frame / MAX_FRAMES);
    return o;
  };

  const tick = (): void => {
    if (paused) return;
    frame += 2;
    const fresh = obsNow();
    hist.push(fresh);
    if (hist.length > 2) hist.shift();
    while (hist.length < 2) hist.unshift(fresh);
    const x = new Float32Array(nObs);
    x.set(hist[0], 0);
    x.set(hist[1], single);

    const l1 = dense(x, w1, b1, h1, nObs, true);
    const l2 = dense(l1, w2, b2, h2, h1, true);
    const logits = dense(l2, w3, b3, spec.actions, h2, false);

    // Сэмплируем из softmax — так сеть играла на обучении; жёсткий argmax
    // у недоученной политики вырождается в одно действие.
    let maxL = -Infinity;
    for (const v of logits) maxL = Math.max(maxL, v);
    let sum = 0;
    const p = new Float32Array(spec.actions);
    for (let a = 0; a < spec.actions; a++) {
      p[a] = Math.exp(logits[a] - maxL);
      sum += p[a];
    }
    let r = Math.random() * sum;
    // Фолбэк — последнее действие: если из-за округления r не исчерпался,
    // виноват хвост распределения, а не действие 0 («ничего не делать»).
    let action = spec.actions - 1;
    for (let a = 0; a < spec.actions; a++) {
      r -= p[a];
      if (r <= 0) {
        action = a;
        break;
      }
    }
    setButtons(ACTION_MASKS[action]);
  };

  const timer = setInterval(tick, 33);
  console.info(`neurobot: ${spec.checkpoint} загружен`);

  return {
    get paused() {
      return paused;
    },
    get mode() {
      return mode;
    },
    pause() {
      paused = true;
      setButtons(0);
    },
    resume() {
      paused = false;
      frame = 0;
      hist.length = 0;
      mode = `neuro:${spec.checkpoint.replace(/^ppo_bc_|\.zip$/g, "")}`;
    },
    stop() {
      clearInterval(timer);
      setButtons(0);
    },
    tick,
  };
}
