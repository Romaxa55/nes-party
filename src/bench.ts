import { NES, Controller } from "jsnes";

export const SCREEN_W = 256;
export const SCREEN_H = 240;

/** Бюджет одного кадра при 60 Гц, мс. */
export const FRAME_BUDGET_MS = 1000 / 60;

const WARMUP_FRAMES = 180;
const MEASURE_FRAMES = 600;
const CHUNK_FRAMES = 30;

export interface Timing {
  frames: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface StageResult extends Timing {
  id: string;
  label: string;
  note: string;
}

export interface StateResult {
  saveMs: number;
  loadMs: number;
  bytes: number;
}

export interface BenchReport {
  stages: StageResult[];
  state: StateResult;
  device: DeviceInfo;
}

export interface DeviceInfo {
  ua: string;
  cores: number | null;
  memoryGb: number | null;
  dpr: number;
  screen: string;
}

/** Единый формат чисел: до 10 мс важны сотые, дальше хватает десятых. */
export function ms(v: number): string {
  return v < 10 ? v.toFixed(2) : v.toFixed(1);
}

function summarize(times: number[]): Timing {
  const sorted = Float64Array.from(times);
  sorted.sort();
  let sum = 0;
  for (const t of times) sum += t;
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    frames: times.length,
    avg: sum / times.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

export function collectDeviceInfo(): DeviceInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    ua: navigator.userAgent,
    cores: nav.hardwareConcurrency ?? null,
    memoryGb: nav.deviceMemory ?? null,
    dpr: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
  };
}

/**
 * Пишет кадр jsnes в ImageData. jsnes отдаёт Uint32Array в формате 0x00BBGGRR,
 * canvas ждёт RGBA — не хватает только альфы, поэтому достаточно OR с 0xFF000000
 * (на little-endian, то есть на всём, что нас интересует).
 */
export function createBlitter(ctx: CanvasRenderingContext2D) {
  const imageData = ctx.createImageData(SCREEN_W, SCREEN_H);
  const buf = new ArrayBuffer(imageData.data.length);
  const buf8 = new Uint8ClampedArray(buf);
  const buf32 = new Uint32Array(buf);

  return (frameBuffer: Uint32Array) => {
    for (let i = 0; i < SCREEN_W * SCREEN_H; i++) {
      buf32[i] = 0xff000000 | frameBuffer[i];
    }
    imageData.data.set(buf8);
    ctx.putImageData(imageData, 0, 0);
  };
}

const yieldToBrowser = () => new Promise((r) => setTimeout(r, 0));

interface StageSpec {
  id: string;
  label: string;
  note: string;
  sound: boolean;
  render: boolean;
}

const STAGES: StageSpec[] = [
  {
    id: "core",
    label: "Core",
    note: "bare CPU and PPU — also the cost of one resimulation step under rollback",
    sound: false,
    render: false,
  },
  {
    id: "sound",
    label: "+ audio",
    note: "difference with the previous row is the APU emulation cost",
    sound: true,
    render: false,
  },
  {
    id: "render",
    label: "+ render",
    note: "difference with the first row is frame conversion and putImageData",
    sound: false,
    render: true,
  },
  {
    id: "full",
    label: "Full cycle",
    note: "what actually happens in-game — the headline number",
    sound: true,
    render: true,
  },
];

/**
 * Прогоняет игру, периодически нажимая Start и A, чтобы проскочить титульный
 * экран и попасть в геймплей — на статичном логотипе PPU рисует заметно меньше,
 * и замер вышел бы оптимистичнее реальности.
 */
function nudgeInput(nes: NES, frameIndex: number): void {
  const phase = frameIndex % 80;
  if (phase === 0) nes.buttonDown(1, Controller.BUTTON_START);
  else if (phase === 4) nes.buttonUp(1, Controller.BUTTON_START);
  else if (phase === 40) nes.buttonDown(1, Controller.BUTTON_A);
  else if (phase === 44) nes.buttonUp(1, Controller.BUTTON_A);
}

export interface ProgressUpdate {
  stageIndex: number;
  stageCount: number;
  stageLabel: string;
  done: number;
  total: number;
}

async function runStage(
  rom: Uint8Array,
  spec: StageSpec,
  blit: ((b: Uint32Array) => void) | null,
  onProgress: (done: number, total: number) => void,
): Promise<StageResult> {
  // Аккумулятор, который читается после прогона: не даёт движку выбросить
  // колбэки как мёртвый код и исказить замер.
  let sink = 0;

  const nes = new NES({
    emulateSound: spec.sound,
    sampleRate: 44100,
    onFrame:
      spec.render && blit
        ? blit
        : (buffer: Uint32Array) => {
            sink += buffer[0];
          },
    onAudioSample: spec.sound
      ? (left: number, right: number) => {
          sink += left + right;
        }
      : undefined,
  });

  nes.loadROM(rom);

  for (let i = 0; i < WARMUP_FRAMES; i++) {
    nudgeInput(nes, i);
    nes.frame();
    if (i % CHUNK_FRAMES === CHUNK_FRAMES - 1) await yieldToBrowser();
  }

  const times: number[] = new Array(MEASURE_FRAMES);
  for (let i = 0; i < MEASURE_FRAMES; i++) {
    nudgeInput(nes, WARMUP_FRAMES + i);
    const t0 = performance.now();
    nes.frame();
    times[i] = performance.now() - t0;

    if (i % CHUNK_FRAMES === CHUNK_FRAMES - 1) {
      onProgress(i + 1, MEASURE_FRAMES);
      await yieldToBrowser();
    }
  }

  if (sink === Number.MAX_VALUE) console.log("unreachable", sink);

  return { id: spec.id, label: spec.label, note: spec.note, ...summarize(times) };
}

/**
 * Меряет save/load состояния — от этого зависит, реален ли роллбэк.
 * jsnes сериализует состояние в объект через toJSON, romData в него не входит.
 */
async function measureState(rom: Uint8Array): Promise<StateResult> {
  let sink = 0;
  const nes = new NES({
    emulateSound: false,
    onFrame: (buffer: Uint32Array) => {
      sink += buffer[0];
    },
  });
  nes.loadROM(rom);
  for (let i = 0; i < 240; i++) {
    nudgeInput(nes, i);
    nes.frame();
  }
  await yieldToBrowser();

  const ROUNDS = 30;
  const snapshots: ReturnType<NES["toJSON"]>[] = [];

  const tSave = performance.now();
  for (let i = 0; i < ROUNDS; i++) snapshots.push(nes.toJSON());
  const saveMs = (performance.now() - tSave) / ROUNDS;

  await yieldToBrowser();

  const tLoad = performance.now();
  for (let i = 0; i < ROUNDS; i++) nes.fromJSON(snapshots[i]);
  const loadMs = (performance.now() - tLoad) / ROUNDS;

  // Размер меряем через JSON — это верхняя оценка: в бою состояние
  // ушло бы по сети в упакованном бинарном виде и весило меньше.
  const bytes = new TextEncoder().encode(JSON.stringify(snapshots[0])).length;

  if (sink === Number.MAX_VALUE) console.log("unreachable", sink);

  return { saveMs, loadMs, bytes };
}

export async function runBenchmark(
  rom: Uint8Array,
  ctx: CanvasRenderingContext2D,
  onProgress: (u: ProgressUpdate) => void,
): Promise<BenchReport> {
  const blit = createBlitter(ctx);
  const stages: StageResult[] = [];

  for (let s = 0; s < STAGES.length; s++) {
    const spec = STAGES[s];
    onProgress({
      stageIndex: s,
      stageCount: STAGES.length,
      stageLabel: spec.label,
      done: 0,
      total: MEASURE_FRAMES,
    });
    const result = await runStage(rom, spec, blit, (done, total) =>
      onProgress({
        stageIndex: s,
        stageCount: STAGES.length,
        stageLabel: spec.label,
        done,
        total,
      }),
    );
    stages.push(result);
  }

  const state = await measureState(rom);
  return { stages, state, device: collectDeviceInfo() };
}

export type Grade = "great" | "good" | "tight" | "fail";

export interface Verdict {
  grade: Grade;
  title: string;
  body: string;
  rollbackNote: string;
}

export function judge(report: BenchReport): Verdict {
  const full = report.stages.find((s) => s.id === "full")!;
  const core = report.stages.find((s) => s.id === "core")!;
  const load = full.p95;

  // Худший случай кадра с роллбэком: восстановить состояние, пересимулировать
  // 7 кадров голым ядром, затем отрисовать один настоящий кадр.
  const renderCost = Math.max(
    0,
    report.stages.find((s) => s.id === "full")!.avg -
      report.stages.find((s) => s.id === "sound")!.avg,
  );
  const rollbackWorst =
    report.state.loadMs + 7 * core.avg + renderCost + report.state.saveMs;

  // При роллбэке снимок снимается КАЖДЫЙ кадр — иначе откатываться некуда.
  // Поэтому дорогой toJSON закрывает тему раньше любой другой арифметики.
  const snapshotKb = Math.round(report.state.bytes / 1024);
  const saveShare = (report.state.saveMs / FRAME_BUDGET_MS) * 100;

  let rollbackNote: string;
  if (report.state.saveMs > 2 || report.state.bytes > 200_000) {
    rollbackNote =
      `Rollback cannot be built on this core, and emulation speed is not the reason. ` +
      `A state snapshot weighs ${snapshotKb} KB and takes ${ms(report.state.saveMs)} ms, ` +
      `and rollback needs one every frame — ${saveShare.toFixed(0)}% of the budget burned ` +
      `before the game itself. jsnes drags expanded tile caches into the snapshot even ` +
      `though the real NES state is a few kilobytes. Netplay should be delay-based; ` +
      `rollback becomes possible only after rewriting state into a flat ArrayBuffer.`;
  } else if (rollbackWorst < FRAME_BUDGET_MS) {
    rollbackNote =
      `Rollback looks feasible: a ${snapshotKb} KB snapshot in ${ms(report.state.saveMs)} ms, ` +
      `worst-case frame with a 7-step rollback is about ${ms(rollbackWorst)} ms ` +
      `within the ${FRAME_BUDGET_MS.toFixed(1)} ms budget.`;
  } else {
    rollbackNote =
      `Rollback does not fit the budget: worst-case frame with a 7-step rollback is ` +
      `about ${ms(rollbackWorst)} ms against ${FRAME_BUDGET_MS.toFixed(1)} ms. ` +
      `Netplay should be delay-based instead.`;
  }

  if (load <= 4) {
    return {
      grade: "great",
      title: "Great — plenty of headroom",
      body: `The full cycle takes ${full.avg.toFixed(2)} ms on average and ${full.p95.toFixed(2)} ms at p95 within a ${FRAME_BUDGET_MS.toFixed(1)} ms budget. The JS core is more than enough, no WASM needed.`,
      rollbackNote,
    };
  }
  if (load <= 8) {
    return {
      grade: "good",
      title: "Good — solid 60 fps",
      body: `The full cycle takes ${full.avg.toFixed(2)} ms on average and ${full.p95.toFixed(2)} ms at p95 within a ${FRAME_BUDGET_MS.toFixed(1)} ms budget. The core fits; the rest of the budget goes to networking and compositing.`,
      rollbackNote,
    };
  }
  if (load <= 13) {
    return {
      grade: "tight",
      title: "Tight — it works, with no headroom",
      body: `The full cycle takes ${full.avg.toFixed(2)} ms on average and ${full.p95.toFixed(2)} ms at p95 within a ${FRAME_BUDGET_MS.toFixed(1)} ms budget. This device is better as a client than as the emulation host.`,
      rollbackNote,
    };
  }
  return {
    grade: "fail",
    title: "Not enough — a WASM core is needed",
    body: `The full cycle takes ${full.avg.toFixed(2)} ms on average and ${full.p95.toFixed(2)} ms at p95, while the whole budget is ${FRAME_BUDGET_MS.toFixed(1)} ms. jsnes cannot reach 60 fps on this device — switch to a libretro WASM core.`,
    rollbackNote,
  };
}
