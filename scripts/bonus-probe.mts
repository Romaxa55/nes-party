/**
 * Реверс позиции бонуса в Battle City: бонус выпадает после убийства
 * мигающего танка (4-й, 11-й, 18-й спавн) и лежит неподвижно. Ищем:
 *  1) в RAM $00-$1EF пары «координатных» байтов, которые появились и
 *     замерли, хотя раньше менялись;
 *  2) в таблице спрайтов PPU статичные спрайты вдали от танков и пуль.
 *
 * Запуск: node --import tsx scripts/bonus-probe.mts [секунд]
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NES } from "jsnes";
import { startBot } from "../src/bot";
import type { ButtonMask } from "../src/controls";

const ROM = new Uint8Array(
  fs.readFileSync(fileURLToPath(new URL("../public/roms/bc.nes", import.meta.url))),
);
const SECONDS = Number(process.argv[2] ?? 180);
const BTN = { SELECT: 2, START: 3 };

const nes = new NES({ emulateSound: false, onFrame: () => {} });
nes.loadROM(ROM);
const anyNes = nes as unknown as {
  cpu: { mem: number[] };
  ppu: { sprX: number[]; sprY: number[]; sprTile: number[] };
};
const mem = anyNes.cpu.mem;
const frames = (n: number) => {
  for (let i = 0; i < n; i++) nes.frame();
};
const tap = (btn: number) => {
  nes.buttonDown(1, btn as 0);
  frames(12);
  nes.buttonUp(1, btn as 0);
  frames(20);
};
frames(240);
tap(BTN.START);
tap(BTN.SELECT);
tap(BTN.START);
frames(90);
tap(BTN.START);
frames(120);

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
const bot = startBot(nes, setButtons, { autoTick: false });

// --- 1) RAM: история изменчивости и замирания -------------------------------
const SCAN = 0x1f0;
const lastVal = new Int32Array(SCAN).fill(-1);
const stableFor = new Int32Array(SCAN);
const everChanged = new Uint8Array(SCAN);
const reported = new Set<number>();

// --- 2) Спрайты: статичные, не совпадающие с танками/пулями -----------------
const sprStable = new Map<string, { frames: number; tile: number }>();

const tanks = (): Array<{ x: number; y: number }> => {
  const out: Array<{ x: number; y: number }> = [];
  for (let s = 0; s < 8; s++) {
    const x = mem[0x90 + s];
    const y = mem[0x98 + s];
    if (x !== 0xff && y !== 0xff) out.push({ x, y });
  }
  return out;
};

const total = SECONDS * 60;
for (let f = 0; f < total; f++) {
  nes.frame();
  if (f % 2 === 0) bot.tick();

  for (let a = 0; a < SCAN; a++) {
    const v = mem[a];
    if (v === lastVal[a]) {
      stableFor[a]++;
    } else {
      if (lastVal[a] !== -1) everChanged[a] = 1;
      lastVal[a] = v;
      stableFor[a] = 0;
    }
  }
  // Кандидат: байт менялся раньше, теперь замер на 3 секунды со значением
  // в диапазоне поля.
  if (f % 30 === 0) {
    for (let a = 0; a < SCAN; a++) {
      if (reported.has(a)) continue;
      const v = lastVal[a];
      if (everChanged[a] && stableFor[a] === 180 && v >= 16 && v <= 223) {
        reported.add(a);
        console.log(
          `RAM  f=${f} (${(f / 60).toFixed(0)}s) $${a
            .toString(16)
            .padStart(3, "0")} замер на ${v} (0x${v.toString(16)})`,
        );
      }
    }
    // Спрайты: 64 записи; статичный ≥2с и не на танке — кандидат в бонус.
    const tk = tanks();
    for (let i = 0; i < 64; i++) {
      const sx = anyNes.ppu.sprX[i];
      const sy = anyNes.ppu.sprY[i];
      const tile = anyNes.ppu.sprTile[i];
      if (sy >= 224 || sy === 0) continue; // спрятанные спрайты
      const key = `${i}:${sx}:${sy}`;
      const prev = sprStable.get(key);
      if (prev) {
        prev.frames += 30;
        const nearTank = tk.some(
          (t) => Math.abs(t.x - sx) < 20 && Math.abs(t.y - sy) < 20,
        );
        if (prev.frames === 120 && !nearTank) {
          console.log(
            `SPR  f=${f} (${(f / 60).toFixed(0)}s) спрайт#${i} tile=0x${tile
              .toString(16)
              .padStart(2, "0")} статичен на (${sx},${sy})`,
          );
        }
      } else {
        sprStable.clear(); // интересует только текущая стабильность
        sprStable.set(key, { frames: 0, tile });
      }
    }
  }
}
console.log("готово");
