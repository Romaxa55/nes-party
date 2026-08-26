import type { NES } from "jsnes";
import { MASKS, type ButtonMask } from "./controls";

/**
 * Бот для Battle City: играет на слоте P2, читая память консоли напрямую.
 *
 * Карта RAM снята реверсом на официальном дампе (Namcot Collection) и
 * сverified живым вводом: массив X-координат танков в $90-$97, Y — в
 * $98-$9F; слот 0 — P1, слот 1 — P2, слоты 2-7 — враги; 0xFF — слот пуст.
 *
 * Железные правила безопасности: бот НИКОГДА не стреляет, если на линии
 * огня союзник (P1) или зона базы — пуля по орлу означает game over,
 * пуля по напарнику — заморозку.
 */

const X0 = 0x90;
const Y0 = 0x98;
const EMPTY = 0xff;

// Зона орла: центр нижнего ряда поля (эмпирически по стартовым позициям:
// P1 спавн x=0x58, P2 x=0x98, база между ними).
const BASE = { x1: 0x68, x2: 0x90, y1: 0xc8, y2: 0xe4 };

/** Насколько «на одной линии» должны быть танки, чтобы стрелять. */
const AIM_TOLERANCE = 6;
/** Радиус союзника, в который стрелять нельзя. */
const ALLY_RADIUS = 12;

interface Tank {
  x: number;
  y: number;
}

type Dir = "UP" | "DOWN" | "LEFT" | "RIGHT";

const DIR_MASK: Record<Dir, ButtonMask> = {
  UP: MASKS.UP,
  DOWN: MASKS.DOWN,
  LEFT: MASKS.LEFT,
  RIGHT: MASKS.RIGHT,
};

export interface Bot {
  /** Приостановить (живой игрок занял слот) — кнопки отпускаются. */
  pause(): void;
  resume(): void;
  stop(): void;
  readonly paused: boolean;
}

export function startBot(
  nes: NES,
  setButtons: (mask: ButtonMask) => void,
): Bot {
  const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;

  let paused = false;
  let dir: Dir = "UP";
  let fireCooldown = 0;
  // Анти-застревание: если позиция почти не меняется — сменить направление.
  let lastX = -1;
  let lastY = -1;
  let stuckTicks = 0;

  const read = (slot: number): Tank | null => {
    const x = mem[X0 + slot];
    const y = mem[Y0 + slot];
    if (x === EMPTY || y === EMPTY) return null;
    return { x, y };
  };

  const inBaseLine = (from: Tank, d: Dir): boolean => {
    // Пересекает ли луч выстрела прямоугольник базы.
    switch (d) {
      case "UP":
        return from.x >= BASE.x1 && from.x <= BASE.x2 && from.y >= BASE.y1;
      case "DOWN":
        return from.x >= BASE.x1 && from.x <= BASE.x2 && from.y <= BASE.y2;
      case "LEFT":
        return from.y >= BASE.y1 && from.y <= BASE.y2 && from.x >= BASE.x1;
      case "RIGHT":
        return from.y >= BASE.y1 && from.y <= BASE.y2 && from.x <= BASE.x2;
    }
  };

  const onFireLine = (from: Tank, target: Tank, d: Dir): boolean => {
    switch (d) {
      case "UP":
        return Math.abs(target.x - from.x) <= ALLY_RADIUS && target.y < from.y;
      case "DOWN":
        return Math.abs(target.x - from.x) <= ALLY_RADIUS && target.y > from.y;
      case "LEFT":
        return Math.abs(target.y - from.y) <= ALLY_RADIUS && target.x < from.x;
      case "RIGHT":
        return Math.abs(target.y - from.y) <= ALLY_RADIUS && target.x > from.x;
    }
  };

  const randomDir = (): Dir => {
    const dirs: Dir[] = ["UP", "DOWN", "LEFT", "RIGHT"];
    return dirs[Math.floor(Math.random() * dirs.length)];
  };

  const tick = (): void => {
    if (paused) return;

    const me = read(1); // P2
    if (!me) {
      setButtons(0); // ждём респауна
      return;
    }
    const ally = read(0); // P1
    const enemies: Tank[] = [];
    for (let s = 2; s < 8; s++) {
      const e = read(s);
      if (e) enemies.push(e);
    }

    // Анти-застревание.
    if (Math.abs(me.x - lastX) < 2 && Math.abs(me.y - lastY) < 2) {
      stuckTicks++;
    } else {
      stuckTicks = 0;
    }
    lastX = me.x;
    lastY = me.y;

    let mask: ButtonMask = 0;

    if (enemies.length === 0) {
      // Врагов нет — патрулируем верхнюю половину, от базы подальше.
      dir = me.y > 0x60 ? "UP" : stuckTicks > 6 ? randomDir() : dir;
      mask = DIR_MASK[dir];
    } else {
      // Ближайший враг.
      let target = enemies[0];
      let best = Infinity;
      for (const e of enemies) {
        const d = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
        if (d < best) {
          best = d;
          target = e;
        }
      }
      const dx = target.x - me.x;
      const dy = target.y - me.y;

      // Если почти на одной оси — довернуть на цель, иначе сокращать
      // большую дельту.
      if (Math.abs(dx) <= AIM_TOLERANCE) {
        dir = dy < 0 ? "UP" : "DOWN";
      } else if (Math.abs(dy) <= AIM_TOLERANCE) {
        dir = dx < 0 ? "LEFT" : "RIGHT";
      } else if (Math.abs(dx) > Math.abs(dy)) {
        dir = dx < 0 ? "LEFT" : "RIGHT";
      } else {
        dir = dy < 0 ? "UP" : "DOWN";
      }
      if (stuckTicks > 6) {
        dir = randomDir();
        stuckTicks = 0;
      }
      mask = DIR_MASK[dir];

      // Стрельба: цель на линии, и на этой линии НЕТ союзника и НЕТ базы.
      const aligned = onFireLine(me, target, dir);
      const allyInDanger = ally !== null && onFireLine(me, ally, dir);
      const baseInDanger = inBaseLine(me, dir);
      if (aligned && !allyInDanger && !baseInDanger && fireCooldown <= 0) {
        mask |= MASKS.A;
        fireCooldown = 4; // не заливать очередью
      }
    }

    if (fireCooldown > 0) fireCooldown--;
    setButtons(mask & 0xff);
  };

  const timer = setInterval(tick, 66); // ~15 решений в секунду

  return {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
      setButtons(0);
    },
    resume() {
      paused = false;
    },
    stop() {
      clearInterval(timer);
      setButtons(0);
    },
  };
}
