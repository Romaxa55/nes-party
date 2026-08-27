/**
 * Датасет «учителя» для нейро-бота: скриптовый бот играет детерминированные
 * бои, и каждые 2 кадра пишется строка [наблюдение(236), действие(0-9)].
 * Формат наблюдения бит-в-бит повторяет BattleCityEnv._obs() из
 * ~/nes-rl/battle_city_env.py — на этом датасете сеть предобучается
 * подражанием (behavior cloning), а потом дообучается RL.
 *
 * Запуск: node --import tsx scripts/bot-dataset.mts [боёв] [сек-на-бой]
 * Выход:  ~/nes-rl/dataset/teacher.jsonl (по строке на решение,
 *         {"o": [...236], "a": 0-9, "ep": номер_боя})
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NES } from "jsnes";
import { startBot } from "../src/bot";
import { MASKS, type ButtonMask } from "../src/controls";

const ROM = new Uint8Array(
  fs.readFileSync(new URL("../public/roms/bc.nes", import.meta.url)),
);
const EPISODES = Number(process.argv[2] ?? 40);
const SECONDS = Number(process.argv[3] ?? 120);
const OUT_DIR = path.join(os.homedir(), "nes-rl", "dataset");
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = fs.createWriteStream(path.join(OUT_DIR, "teacher.jsonl"));

const BTN = { A: 0, SELECT: 2, START: 3, UP: 4, LEFT: 6 };
const EMPTY = 0xff;
const MAX_FRAMES = SECONDS * 60;
// Шкала признака времени — всегда 120 с, как max_seconds в BattleCityEnv:
// если бой в датасете другой длины, нормировка всё равно должна совпадать
// со средой и с браузером, иначе датасет и политика разойдутся.
const OBS_MAX_FRAMES = 120 * 60;

/** Действия в том же порядке, что ACTIONS в battle_city_env.py. */
const maskToAction = (m: ButtonMask): number => {
  const fire = (m & MASKS.A) !== 0;
  if (m & MASKS.UP) return fire ? 6 : 1;
  if (m & MASKS.DOWN) return fire ? 7 : 2;
  if (m & MASKS.LEFT) return fire ? 8 : 3;
  if (m & MASKS.RIGHT) return fire ? 9 : 4;
  return fire ? 5 : 0;
};

/** Бит-в-бит порт BattleCityEnv._obs(): 8*5 танки, 8*3 пули, 13x13, 3. */
function obsVector(mem: number[], frame: number): number[] {
  const o: number[] = [];
  const mex = mem[0x91];
  const mey = mem[0x99];
  const meAlive = mex !== EMPTY && mey !== EMPTY;
  for (let s = 0; s < 8; s++) {
    const x = mem[0x90 + s];
    const y = mem[0x98 + s];
    const alive = x !== EMPTY && y !== EMPTY;
    const aim = mem[0xa0 + s] & 3;
    o.push(alive ? 1 : 0);
    o.push(alive ? x / 255 : 0);
    o.push(alive ? y / 255 : 0);
    o.push(alive && meAlive ? (x - mex) / 255 : 0);
    o.push(alive ? aim / 3 : 0);
  }
  for (let s = 0; s < 8; s++) {
    const x = mem[0xb8 + s];
    const y = mem[0xc2 + s];
    const alive = x !== EMPTY && y !== EMPTY;
    o.push(alive ? 1 : 0);
    o.push(alive ? x / 255 : 0);
    o.push(alive ? y / 255 : 0);
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
      o.push(v);
    }
  }
  o.push(mem[0x400 + 26 * 32 + 14] === 0xc8 ? 1 : 0);
  o.push((mem[0xa1] & 3) / 3);
  o.push(frame / OBS_MAX_FRAMES);
  return o;
}

let total = 0;
for (let ep = 0; ep < EPISODES; ep++) {
  const nes = new NES({ emulateSound: false, onFrame: () => {} });
  nes.loadROM(ROM);
  const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) nes.frame();
  };
  const tap = (b: number): void => {
    nes.buttonDown(1, b as 0);
    frames(12);
    nes.buttonUp(1, b as 0);
    frames(20);
  };
  frames(240);
  tap(BTN.START);
  tap(BTN.SELECT);
  tap(BTN.START);
  frames(90);
  tap(BTN.START);
  frames(120 + ep * 3); // сид — как в симуляции

  let lastMask: ButtonMask = 0;
  let applied: ButtonMask = 0;
  const bot = startBot(
    nes,
    (m) => {
      lastMask = m;
      const ch = applied ^ m;
      for (let bit = 0; bit < 8; bit++) {
        if (!(ch & (1 << bit))) continue;
        if (m & (1 << bit)) nes.buttonDown(2, bit as 0);
        else nes.buttonUp(2, bit as 0);
      }
      applied = m;
    },
    { autoTick: false },
  );

  for (let f = 0; f < MAX_FRAMES; f += 2) {
    // наблюдение ДО решения — как видит его python-среда
    const obs = obsVector(mem, f);
    bot.tick();
    out.write(JSON.stringify({ o: obs, a: maskToAction(lastMask), ep }) + "\n");
    total++;
    nes.frame();
    nes.frame();
    // конец боя: орёл пал или уровень пройден
    const botAlive = mem[0x91] !== EMPTY && mem[0x99] !== EMPTY;
    if ((botAlive && mem[0x400 + 26 * 32 + 14] !== 0xc8) || mem[0x85] > 1) {
      break;
    }
  }
  bot.stop();
  if (ep % 5 === 4) console.log(`бой ${ep + 1}/${EPISODES}, строк: ${total}`);
}
out.end();
console.log(`готово: ${total} решений учителя -> ${OUT_DIR}/teacher.jsonl`);
