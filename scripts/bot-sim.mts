/**
 * Симуляция боя бота в реальном времени (оригинальный bc.nes, 2P-режим,
 * P1 стоит AFK, бот играет P2). Метрики: выстрелы, выстрелы в бетон
 * (не должно быть после фикса), фраги (телепорт слота врага = переспавн),
 * смерти бота, судьба базы.
 *
 * Запуск: node --import tsx scripts/bot-sim.mts [секунд]
 */
import * as fs from "node:fs";
import { NES } from "jsnes";
import { startBot } from "../src/bot";
import { MASKS, type ButtonMask } from "../src/controls";

const ROM = new Uint8Array(fs.readFileSync("public/roms/bc.nes"));
const SECONDS = Number(process.argv[2] ?? 90);
const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };

const nes = new NES({ emulateSound: false, onFrame: () => {} });
nes.loadROM(ROM);
const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;

const frames = (n: number) => {
  for (let i = 0; i < n; i++) nes.frame();
};
const tap = (btn: number) => {
  nes.buttonDown(1, btn as 0);
  frames(12);
  nes.buttonUp(1, btn as 0);
  frames(20);
};

// Меню: активация -> 2 PLAYERS -> STAGE 1 -> бой.
frames(240);
tap(BTN.START);
tap(BTN.SELECT);
tap(BTN.START);
frames(90);
tap(BTN.START);
frames(120);

// Ввод бота: маска -> buttonDown/Up на P2.
let applied: ButtonMask = 0;
const setButtons = (mask: ButtonMask): void => {
  const changed = applied ^ mask;
  for (let bit = 0; bit < 8; bit++) {
    if (!(changed & (1 << bit))) continue;
    if (mask & (1 << bit)) nes.buttonDown(2, bit as 0);
    else nes.buttonUp(2, bit as 0);
  }
  applied = mask;
};

const bot = startBot(nes, setButtons);

// --- Метрики ---------------------------------------------------------------
let shots = 0;
const kinds = { steel: 0, brick: 0, foe: 0, void: 0 };
let kills = 0;
let botDeaths = 0;
let prevBotBullet: { x: number; y: number } | null = null;
const prevEnemy: Array<{ x: number; y: number } | null> = Array(8).fill(null);
let prevBotAlive = false;

/** Классификация траектории: во что пуля упрётся первым делом. */
const classifyPath = (
  from: { x: number; y: number },
  dx: number,
  dy: number,
): "steel" | "brick" | "foe" | "void" => {
  const sx = dx < 0 ? -8 : dx > 0 ? 8 : 0;
  const sy = dy < 0 ? -8 : dy > 0 ? 8 : 0;
  const foes: Array<{ x: number; y: number }> = [];
  for (let s = 2; s < 8; s++) {
    const x = mem[0x90 + s];
    const y = mem[0x98 + s];
    if (x !== 0xff && y !== 0xff) foes.push({ x, y });
  }
  let cx = from.x + sx;
  let cy = from.y + sy;
  for (let t = 8; t < 0xd0; t += 8) {
    if (cx < 16 || cx > 223 || cy < 16 || cy > 223) return "void";
    if (foes.some((f) => Math.abs(f.x - cx) <= 10 && Math.abs(f.y - cy) <= 10))
      return "foe";
    const tile = mem[0x400 + (cy >> 3) * 32 + (cx >> 3)];
    if (tile === 0x10 || tile === 0x11) return "steel";
    if (tile >= 1 && tile <= 0x0f) return "brick";
    cx += sx;
    cy += sy;
  }
  return "void";
};
let pendingShot: {
  x: number;
  y: number;
  foes: Array<{ x: number; y: number }>;
} | null = null;
let intercepts = 0;
let farShots = 0;

/** Вражеские пули в момент выстрела — кандидаты на перехват. */
const foeBullets = (): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  for (let s = 0; s < 8; s++) {
    if (s === 1) continue;
    const x = mem[0xb8 + s];
    const y = mem[0xc2 + s];
    if (x !== 0xff && y !== 0xff) out.push({ x, y });
  }
  return out;
};

/** Пуля на луче выстрела ближе 0x60 — считаем выстрел перехватом. */
const onRay = (
  from: { x: number; y: number },
  dx: number,
  dy: number,
  foes: Array<{ x: number; y: number }>,
): boolean =>
  foes.some((f) => {
    const rx = f.x - from.x;
    const ry = f.y - from.y;
    if (dx !== 0) {
      return Math.sign(rx) === Math.sign(dx) && Math.abs(rx) <= 0x60 && Math.abs(ry) <= 8;
    }
    return Math.sign(ry) === Math.sign(dy) && Math.abs(ry) <= 0x60 && Math.abs(rx) <= 8;
  });

const sample = (): void => {
  // Выстрел бота: пуля слота 1 (пуля P2) появилась ИЛИ телепортировалась
  // назад к танку — при непрерывном огне слот не успевает освобождаться.
  const bx = mem[0xb8 + 1];
  const by = mem[0xc2 + 1];
  const bulletAlive = bx !== 0xff && by !== 0xff;
  if (bulletAlive) {
    const isNew =
      !prevBotBullet ||
      Math.abs(bx - prevBotBullet.x) + Math.abs(by - prevBotBullet.y) > 16;
    if (isNew) {
      // Пуля, родившаяся не у нашего танка, — чужая (слот делится?).
      const mx = mem[0x91];
      const my = mem[0x99];
      const near =
        mx !== 0xff &&
        my !== 0xff &&
        Math.abs(bx - mx) + Math.abs(by - my) <= 24;
      if (!near) {
        farShots++;
        pendingShot = null;
      } else {
        shots++;
        // направление узнаем по дельте на следующем кадре
        pendingShot = { x: bx, y: by, foes: foeBullets() };
      }
    } else if (pendingShot) {
      const dx = bx - pendingShot.x;
      const dy = by - pendingShot.y;
      if (dx !== 0 || dy !== 0) {
        if (onRay(pendingShot, dx, dy, pendingShot.foes)) intercepts++;
        else kinds[classifyPath(pendingShot, dx, dy)]++;
        pendingShot = null;
      }
    }
    prevBotBullet = { x: bx, y: by };
  } else {
    prevBotBullet = null;
    pendingShot = null;
  }

  // фраги: телепорт слота врага (переспавн после смерти)
  for (let s = 2; s < 8; s++) {
    const x = mem[0x90 + s];
    const y = mem[0x98 + s];
    const alive = x !== 0xff && y !== 0xff;
    const prev = prevEnemy[s];
    if (alive && prev) {
      const jump = Math.abs(x - prev.x) + Math.abs(y - prev.y);
      if (jump > 0x40) kills++;
    }
    prevEnemy[s] = alive ? { x, y } : null;
  }

  // смерти бота
  const botAlive = mem[0x91] !== 0xff && mem[0x99] !== 0xff;
  if (!botAlive && prevBotAlive) botDeaths++;
  prevBotAlive = botAlive;
};

const gameTimer = setInterval(() => {
  nes.frame();
  sample();
}, 16);

setTimeout(() => {
  clearInterval(gameTimer);
  bot.stop();
  const eagleOk = mem[0x400 + 26 * 32 + 14] === 0xc8;
  console.log(
    JSON.stringify(
      {
        seconds: SECONDS,
        shots,
        farShots,
        intercepts,
        shotsAt: kinds,
        kills,
        killsPerMin: +(kills / (SECONDS / 60)).toFixed(1),
        botDeaths,
        eagleOk,
      },
      null,
      2,
    ),
  );
  process.exit(kinds.steel > Math.max(2, shots * 0.05) ? 1 : 0);
}, SECONDS * 1000);
