import { NES } from "jsnes";
import { createBlitter } from "./bench";
import { applyButtons, type ButtonMask } from "./controls";
import type { AudioPipe } from "./audio";

const STEP_MS = 1000 / 60;
/** Больше четырёх догоняющих шагов за кадр не делаем — иначе спираль отставания. */
const MAX_CATCHUP_STEPS = 4;

export interface EngineStats {
  fps: number;
  frameMs: number;
  worstMs: number;
  droppedSteps: number;
}

export interface Engine {
  nes: NES;
  /** Желаемое состояние кнопок игрока; применяется перед следующим кадром. */
  setButtons(player: 1 | 2, mask: ButtonMask): void;
  stop(): void;
}

/**
 * Игровой цикл хоста: fixed timestep на requestAnimationFrame, звук через
 * AudioPipe, ввод — маски кнопок от локальных и сетевых игроков.
 * Кадры рисуются в canvas — captureStream с него же идёт в трансляцию.
 */
export function startEngine(opts: {
  rom: Uint8Array;
  canvas: HTMLCanvasElement;
  audio?: AudioPipe | null;
  onStats?: (s: EngineStats) => void;
}): Engine {
  const ctx = opts.canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D-контекст недоступен");
  const blit = createBlitter(ctx);
  const audio = opts.audio ?? null;

  let renderThisStep = true;
  const nes = new NES({
    emulateSound: !!audio,
    sampleRate: audio?.sampleRate ?? 44100,
    onFrame: (buffer: Uint32Array) => {
      if (renderThisStep) blit(buffer);
    },
    onAudioSample: audio ? audio.onSample : undefined,
  });
  nes.loadROM(opts.rom);

  // Желаемые и применённые маски кнопок по игрокам.
  const desired: [ButtonMask, ButtonMask] = [0, 0];
  const applied: [ButtonMask, ButtonMask] = [0, 0];

  let raf = 0;
  let last = performance.now();
  let accumulator = 0;
  let framesThisSecond = 0;
  let secondStartedAt = last;
  let frameMsSum = 0;
  let frameMsCount = 0;
  let worstMs = 0;
  let droppedSteps = 0;

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);

    let delta = now - last;
    last = now;
    // Вкладка уходила в фон или был фриз — не пытаемся отыграть весь простой.
    if (delta > 250) delta = STEP_MS;
    accumulator += delta;

    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
      accumulator -= STEP_MS;
      steps++;
      renderThisStep = accumulator < STEP_MS || steps === MAX_CATCHUP_STEPS;

      for (const player of [1, 2] as const) {
        const i = player - 1;
        if (applied[i] !== desired[i]) {
          applyButtons(nes, player, applied[i], desired[i]);
          applied[i] = desired[i];
        }
      }

      const t0 = performance.now();
      nes.frame();
      const dt = performance.now() - t0;
      audio?.flush();

      frameMsSum += dt;
      frameMsCount++;
      if (dt > worstMs) worstMs = dt;
      framesThisSecond++;
    }

    // Не успели догнать — списываем долг, иначе отставание копится лавиной.
    if (accumulator >= STEP_MS) {
      droppedSteps += Math.floor(accumulator / STEP_MS);
      accumulator = 0;
    }

    if (now - secondStartedAt >= 1000) {
      opts.onStats?.({
        fps: (framesThisSecond * 1000) / (now - secondStartedAt),
        frameMs: frameMsCount ? frameMsSum / frameMsCount : 0,
        worstMs,
        droppedSteps,
      });
      framesThisSecond = 0;
      secondStartedAt = now;
      frameMsSum = 0;
      frameMsCount = 0;
      worstMs = 0;
    }
  }

  raf = requestAnimationFrame(loop);

  // Не даём экрану гаснуть посреди игры. Поддерживается не везде — молча пропускаем.
  let wakeLock: WakeLockSentinel | null = null;
  navigator.wakeLock
    ?.request("screen")
    .then((lock) => {
      wakeLock = lock;
    })
    .catch(() => {});

  return {
    nes,
    setButtons(player, mask) {
      desired[player - 1] = mask & 0xff;
    },
    stop() {
      cancelAnimationFrame(raf);
      wakeLock?.release().catch(() => {});
    },
  };
}
