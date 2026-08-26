/**
 * Регрессионный тест Four Score на 4P-хаке Battle City (без браузера).
 *
 * Загружает public/roms/bc4.nes, включает боевой enableFourScore, проходит
 * меню (SELECT -> START -> START = режим 4 PLAYERS) и проверяет, что зажатое
 * направление у P3 и P4 монотонно двигает их координаты в RAM ($c0-$d8 —
 * зона танков этого хака; карта отличается от оригинала).
 *
 * Запуск: node --import tsx scripts/fourscore-test.mts
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NES } from "jsnes";
import { enableFourScore } from "../src/fourscore";

// ROM'ы не в git (см. .gitignore) — на клоне без них тест честно скипается.
const ROM_PATH = fileURLToPath(
  new URL("../public/roms/bc4.nes", import.meta.url),
);
if (!fs.existsSync(ROM_PATH)) {
  console.log(`skip: ${ROM_PATH} not found (ROMs are not committed)`);
  process.exit(0);
}
const ROM = new Uint8Array(fs.readFileSync(ROM_PATH));
const BTN = { SELECT: 2, START: 3, DOWN: 5, RIGHT: 7 };

const nes = new NES({ emulateSound: false, onFrame: () => {} });
nes.loadROM(ROM);
enableFourScore(nes);
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

// Титул -> курсор на 4 PLAYERS -> STAGE 1 -> бой -> спавн игроков.
frames(400);
tap(BTN.SELECT);
tap(BTN.START);
frames(120);
tap(BTN.START);
frames(360);

/** Зажимает кнопку у игрока и ищет монотонно меняющиеся байты танковой зоны. */
function moves(player: 3 | 4, btn: number): boolean {
  const snaps: number[][] = [];
  nes.buttonDown(player as 1, btn as 0);
  for (let s = 0; s < 6; s++) {
    frames(12);
    snaps.push(mem.slice(0xc0, 0xd8));
  }
  nes.buttonUp(player as 1, btn as 0);
  frames(30);
  for (let a = 0; a < snaps[0].length; a++) {
    let ups = 0;
    for (let s = 1; s < snaps.length; s++) {
      const d = (snaps[s][a] - snaps[s - 1][a] + 256) & 0xff;
      if (d >= 1 && d <= 16) ups++;
    }
    if (ups >= 4) return true;
  }
  return false;
}

let failed = false;
for (const p of [3, 4] as const) {
  // Два направления: если танк упёрся в стену по одной оси, выручит вторая.
  const ok = moves(p, BTN.RIGHT) || moves(p, BTN.DOWN);
  console.log(`P${p} input reaches the game: ${ok ? "OK" : "FAIL"}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
