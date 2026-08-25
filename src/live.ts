import { startEngine, type EngineStats } from "./engine";
import { attachKeyboard, attachTouchpad, InputAggregator } from "./controls";

export type LiveStats = EngineStats;

export interface LiveSession {
  stop: () => void;
}

/**
 * Живой режим бенчмарка: тот же движок, что у хоста, но без звука —
 * его стоимость измеряется отдельной строкой автозамера.
 */
export function startLive(opts: {
  rom: Uint8Array;
  canvas: HTMLCanvasElement;
  pad: HTMLElement;
  onStats: (s: LiveStats) => void;
}): LiveSession {
  const engine = startEngine({
    rom: opts.rom,
    canvas: opts.canvas,
    audio: null,
    onStats: opts.onStats,
  });

  const inputs = new InputAggregator((mask) => engine.setButtons(1, mask));
  const detachTouch = attachTouchpad(opts.pad, (m) => inputs.set("touch", m));
  const detachKeys = attachKeyboard((m) => inputs.set("kb", m));

  return {
    stop() {
      detachTouch();
      detachKeys();
      engine.stop();
    },
  };
}
