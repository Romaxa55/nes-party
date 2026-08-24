import { NES, Controller } from "jsnes";
import { createBlitter, SCREEN_W, SCREEN_H } from "./bench";

const STEP_MS = 1000 / 60;
/** Больше четырёх догоняющих шагов за кадр не делаем — иначе спираль отставания. */
const MAX_CATCHUP_STEPS = 4;

const BUTTON_BY_NAME: Record<string, number> = {
  A: Controller.BUTTON_A,
  B: Controller.BUTTON_B,
  SELECT: Controller.BUTTON_SELECT,
  START: Controller.BUTTON_START,
  UP: Controller.BUTTON_UP,
  DOWN: Controller.BUTTON_DOWN,
  LEFT: Controller.BUTTON_LEFT,
  RIGHT: Controller.BUTTON_RIGHT,
};

const KEYBOARD_MAP: Record<string, string> = {
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  KeyW: "UP",
  KeyS: "DOWN",
  KeyA: "LEFT",
  KeyD: "RIGHT",
  KeyK: "A",
  KeyJ: "B",
  KeyX: "A",
  KeyZ: "B",
  Enter: "START",
  ShiftRight: "SELECT",
  ShiftLeft: "SELECT",
};

export interface LiveStats {
  fps: number;
  frameMs: number;
  worstMs: number;
  droppedSteps: number;
}

export interface LiveSession {
  stop: () => void;
}

/**
 * Запускает эмулятор в реальном времени с тач-управлением.
 * В отличие от автозамера здесь видно реальный достижимый FPS: сюда входит
 * не только эмуляция, но и композитинг браузера, троттлинг и всё остальное.
 *
 * Звук намеренно выключен — его стоимость измеряется отдельной строкой
 * в автозамере, а звуковой конвейер появится на следующем этапе проекта.
 */
export function startLive(opts: {
  rom: Uint8Array;
  canvas: HTMLCanvasElement;
  pad: HTMLElement;
  onStats: (s: LiveStats) => void;
}): LiveSession {
  const ctx = opts.canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D-контекст недоступен");
  const blit = createBlitter(ctx);

  let renderThisStep = true;
  const nes = new NES({
    emulateSound: false,
    onFrame: (buffer: Uint32Array) => {
      if (renderThisStep) blit(buffer);
    },
  });
  nes.loadROM(opts.rom);

  // --- ввод -------------------------------------------------------------

  // Какие кнопки держит каждый палец. Состояние NES — объединение по всем.
  const pointers = new Map<number, Set<string>>();
  const heldByKeyboard = new Set<string>();
  const currentlyDown = new Set<string>();

  function recomputeButtons(): void {
    const wanted = new Set<string>(heldByKeyboard);
    for (const names of pointers.values()) {
      for (const n of names) wanted.add(n);
    }
    for (const name of wanted) {
      if (!currentlyDown.has(name)) {
        nes.buttonDown(1, BUTTON_BY_NAME[name] as 0);
        currentlyDown.add(name);
      }
    }
    for (const name of [...currentlyDown]) {
      if (!wanted.has(name)) {
        nes.buttonUp(1, BUTTON_BY_NAME[name] as 0);
        currentlyDown.delete(name);
      }
    }
  }

  /**
   * Кнопки определяем по координате пальца, а не по цели события: так палец
   * можно проводить между зонами D-pad, не отрывая, и диагонали работают.
   */
  function namesAtPoint(x: number, y: number): Set<string> {
    const found = new Set<string>();
    for (const el of document.elementsFromPoint(x, y)) {
      const attr = (el as HTMLElement).dataset?.button;
      if (attr) {
        for (const name of attr.split(",")) found.add(name.trim());
        break;
      }
    }
    return found;
  }

  function onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    pointers.set(e.pointerId, namesAtPoint(e.clientX, e.clientY));
    recomputeButtons();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.set(e.pointerId, namesAtPoint(e.clientX, e.clientY));
    recomputeButtons();
  }

  function onPointerUp(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return;
    recomputeButtons();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const name = KEYBOARD_MAP[e.code];
    if (!name) return;
    e.preventDefault();
    heldByKeyboard.add(name);
    recomputeButtons();
  }

  function onKeyUp(e: KeyboardEvent): void {
    const name = KEYBOARD_MAP[e.code];
    if (!name) return;
    e.preventDefault();
    heldByKeyboard.delete(name);
    recomputeButtons();
  }

  opts.pad.addEventListener("pointerdown", onPointerDown);
  opts.pad.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // --- игровой цикл -----------------------------------------------------

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

      const t0 = performance.now();
      nes.frame();
      const dt = performance.now() - t0;

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
      opts.onStats({
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
    stop() {
      cancelAnimationFrame(raf);
      opts.pad.removeEventListener("pointerdown", onPointerDown);
      opts.pad.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      wakeLock?.release().catch(() => {});
      ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    },
  };
}
