import { NES } from "jsnes";
import { createBlitter } from "./bench";
import { applyButtons, type ButtonMask } from "./controls";
import { enableFourScore } from "./fourscore";
import type { AudioPipe } from "./audio";

const STEP_MS = 1000 / 60;
/** Больше четырёх догоняющих шагов за кадр не делаем — иначе спираль отставания. */
const MAX_CATCHUP_STEPS = 4;
/** Дельта больше этого — вкладка была в фоне или фриз; долг не отыгрываем. */
const FREEZE_RESET_MS = 250;

export interface EngineStats {
  fps: number;
  frameMs: number;
  worstMs: number;
  droppedSteps: number;
}

export interface Engine {
  nes: NES;
  /** Желаемое состояние кнопок игрока; применяется перед следующим кадром. */
  setButtons(player: 1 | 2 | 3 | 4, mask: ButtonMask): void;
  stop(): void;
}

/**
 * Игровой цикл хоста: fixed timestep на requestAnimationFrame, звук через
 * AudioPipe, ввод — маски кнопок от локальных и сетевых игроков.
 * Кадры рисуются в canvas — captureStream с него же идёт в трансляцию.
 *
 * Может бросить прямо из вызова: loadROM падает на неподдерживаемом маппере.
 */
export function startEngine(opts: {
  rom: Uint8Array;
  canvas: HTMLCanvasElement;
  audio?: AudioPipe | null;
  /** Game Genie коды (например, бесконечные жизни) — применяются к рому. */
  ggCodes?: string[];
  /**
   * RAM-фризы: значения, прописываемые в память каждый кадр (классический
   * «замороженный» чит). Надёжнее Game Genie: не зависит от версии дампа.
   */
  ramPatches?: Array<{ a: number; v: number }>;
  /** Four Score: четыре контроллера (для 4-player ромхаков). */
  players4?: boolean;
  onStats?: (s: EngineStats) => void;
  /** Эмулятор упал во время игры; цикл уже остановлен. */
  onError?: (err: Error) => void;
}): Engine {
  const ctx = opts.canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas context unavailable");
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
  if (opts.players4) enableFourScore(nes); // после loadROM: маппер пересоздан

  if (opts.ggCodes?.length) {
    for (const code of opts.ggCodes) {
      try {
        nes.gameGenie.addCode(code.trim().toUpperCase());
      } catch {
        // кривой код — молча пропускаем, остальные работают
      }
    }
    nes.gameGenie.setEnabled(true);
  }

  // Желаемые и применённые маски кнопок по игрокам (до четырёх).
  const playerCount = opts.players4 ? 4 : 2;
  const desired: ButtonMask[] = [0, 0, 0, 0];
  const applied: ButtonMask[] = [0, 0, 0, 0];

  let raf = 0;
  let stopped = false;
  let wakeLock: WakeLockSentinel | null = null;
  let last = performance.now();
  let accumulator = 0;
  let framesThisSecond = 0;
  let secondStartedAt = last;
  let frameMsSum = 0;
  let frameMsCount = 0;
  let worstMs = 0;
  let droppedSteps = 0;

  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    wakeLock?.release().catch(() => {});
  }

  function loop(now: number): void {
    if (stopped) return;
    raf = requestAnimationFrame(loop);

    let delta = now - last;
    last = now;
    if (delta > FREEZE_RESET_MS) delta = STEP_MS;
    accumulator += delta;

    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
      accumulator -= STEP_MS;
      steps++;
      renderThisStep = accumulator < STEP_MS || steps === MAX_CATCHUP_STEPS;

      for (let player = 1; player <= playerCount; player++) {
        const i = player - 1;
        if (applied[i] !== desired[i]) {
          applyButtons(nes, player as 1, applied[i], desired[i]);
          applied[i] = desired[i];
        }
      }

      if (opts.ramPatches?.length) {
        const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;
        for (const p of opts.ramPatches) mem[p.a & 0x7ff] = p.v & 0xff;
      }

      const t0 = performance.now();
      try {
        nes.frame();
      } catch (err) {
        // jsnes выставляет crashed навсегда — крутить цикл дальше нет смысла.
        shutdown();
        opts.onError?.(err as Error);
        return;
      }
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
  navigator.wakeLock
    ?.request("screen")
    .then((lock) => {
      if (stopped) lock.release().catch(() => {});
      else wakeLock = lock;
    })
    .catch(() => {});

  return {
    nes,
    setButtons(player, mask) {
      desired[player - 1] = mask & 0xff;
    },
    stop: shutdown,
  };
}
