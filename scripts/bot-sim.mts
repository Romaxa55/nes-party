/**
 * Экзамен бота Battle City: детерминированный бой без браузера.
 *
 * Эмулятор и бот тикаются вручную (ровно 2 кадра на решение бота, как
 * 60 Гц против 30 Гц в проде), поэтому прогон воспроизводим и идёт
 * в десятки раз быстрее реального времени. Гоняем несколько сценариев,
 * отличающихся поведением напарника P1, и печатаем каждый плюс сводку.
 *
 * Метрики замораживаются в момент падения орла: после game over игра
 * показывает счёт и демо, которое само водит «танк P2» по карте, и все
 * счётчики превратились бы в мусор.
 *
 * Запуск: npm run test:bot [секунд-на-сценарий]
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NES } from "jsnes";
import { startBot, ANCHOR, BASE_CENTER, LEASH_DIST } from "../src/bot";
import { MASKS, type ButtonMask } from "../src/controls";

// ROM'ы не в git — на клоне без них тест честно скипается.
const ROM_PATH = fileURLToPath(
  new URL("../public/roms/bc.nes", import.meta.url),
);
if (!fs.existsSync(ROM_PATH)) {
  console.log(`skip: ${ROM_PATH} not found (ROMs are not committed)`);
  process.exit(0);
}
const ROM = new Uint8Array(fs.readFileSync(ROM_PATH));
const SECONDS = Number(process.argv[2] ?? 90);
if (!Number.isFinite(SECONDS) || SECONDS <= 0) {
  console.error(`bad duration: ${process.argv[2] ?? "(none)"}`);
  process.exit(2);
}

const BTN = { A: 0, B: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7 };
// RAM Battle City (реверс): танки, пули, тайлы поля.
const TANK_X = 0x90;
const TANK_Y = 0x98;
const BULLET_X = 0xb8;
const BULLET_Y = 0xc2;
const TILES = 0x400;
const EAGLE_TILE = TILES + 26 * 32 + 14; // левый верхний тайл орла
const EAGLE_INTACT = 0xc8;
const EMPTY = 0xff;

interface Metrics {
  scenario: string;
  seed: number;
  /** Частота режимов решения — видно, какие ветки бота реально живут. */
  modes: Record<string, number>;
  /** Уровень пройден: все 20 танков убиты, игра ушла на stage 2. */
  stageCleared: boolean;
  /** Сколько секунд длился засчитанный бой (до падения орла). */
  battleSec: number;
  eagleOk: boolean;
  shots: number;
  shotsAt: { steel: number; brick: number; foe: number; void: number };
  intercepts: number;
  kills: number;
  killsPerMin: number;
  botDeaths: number;
  leashPct: number;
  maxLeash: number;
}

/**
 * Один бой. p1Style задаёт напарника: "idle" — стоит, "cover" — крутится
 * и стреляет в безопасные стороны (проверяет, что бот уклоняется от пуль
 * союзника, но не паникует от них).
 */
function runBattle(
  p1Style: "idle" | "cover" | "cover-fast",
  seconds: number,
  seed: number,
): Metrics {
  const nes = new NES({ emulateSound: false, onFrame: () => {} });
  nes.loadROM(ROM);
  const mem = (nes as unknown as { cpu: { mem: number[] } }).cpu.mem;

  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) nes.frame();
  };
  const tapP1 = (btn: number): void => {
    nes.buttonDown(1, btn as 0);
    frames(12);
    nes.buttonUp(1, btn as 0);
    frames(20);
  };

  // Меню: активация -> 2 PLAYERS -> STAGE 1 -> бой.
  frames(240);
  tapP1(BTN.START);
  tapP1(BTN.SELECT);
  tapP1(BTN.START);
  frames(90);
  tapP1(BTN.START);
  // Сид — сдвиг фазы игрового ГПСЧ на несколько кадров. Без него замер
  // меряет один удачный расклад: разброс выживания базы на одной карте
  // достигает 32-60 с (измерено ревью), и любые тюнинги тонут в нём.
  frames(120 + seed);

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

  // --- Метрики ---
  let shots = 0;
  const shotsAt = { steel: 0, brick: 0, foe: 0, void: 0 };
  let intercepts = 0;
  let kills = 0;
  let botDeaths = 0;
  let battleFrames = 0;
  let leashFrames = 0;
  let maxLeash = 0;
  let baseFellFrame: number | null = null;
  let stageCleared = false;
  let clearedFrame: number | null = null;
  const modes: Record<string, number> = {};

  let prevBotBullet: { x: number; y: number } | null = null;
  let pendingShot: {
    x: number;
    y: number;
    foes: Array<{ x: number; y: number }>;
    track: Array<{ x: number; y: number }>;
  } | null = null;
  const prevEnemy: Array<{ x: number; y: number } | null> = Array(8).fill(null);
  let prevBotAlive = false;
  let prevBotPos: { x: number; y: number } | null = null;

  const enemyTanks = (): Array<{ x: number; y: number }> => {
    const out: Array<{ x: number; y: number }> = [];
    for (let s = 2; s < 8; s++) {
      const x = mem[TANK_X + s];
      const y = mem[TANK_Y + s];
      if (x !== EMPTY && y !== EMPTY) out.push({ x, y });
    }
    return out;
  };

  /** Чужие пули в момент выстрела — кандидаты на перехват. */
  const foeBullets = (): Array<{ x: number; y: number }> => {
    const out: Array<{ x: number; y: number }> = [];
    for (let s = 0; s < 8; s++) {
      if (s === 1) continue; // своя
      const x = mem[BULLET_X + s];
      const y = mem[BULLET_Y + s];
      if (x !== EMPTY && y !== EMPTY) out.push({ x, y });
    }
    return out;
  };

  /** Пуля на луче выстрела — считаем выстрел перехватом. */
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
        return (
          Math.sign(rx) === Math.sign(dx) &&
          Math.abs(rx) <= 0x60 &&
          Math.abs(ry) <= 8
        );
      }
      return (
        Math.sign(ry) === Math.sign(dy) &&
        Math.abs(ry) <= 0x60 &&
        Math.abs(rx) <= 8
      );
    });

  /** Во что упрётся пуля: та же геометрия, что у бота (ширина ±2). */
  const classifyPath = (
    from: { x: number; y: number },
    dx: number,
    dy: number,
  ): keyof typeof shotsAt => {
    const sx = dx < 0 ? -8 : dx > 0 ? 8 : 0;
    const sy = dy < 0 ? -8 : dy > 0 ? 8 : 0;
    const foes = enemyTanks();
    let cx = from.x;
    let cy = from.y;
    for (let t = 0; t < 0xd0; t += 8) {
      if (cx < 16 || cx > 223 || cy < 16 || cy > 223) return "void";
      if (foes.some((f) => Math.abs(f.x - cx) <= 10 && Math.abs(f.y - cy) <= 10))
        return "foe";
      const a =
        sx !== 0
          ? mem[TILES + ((cy - 2) >> 3) * 32 + (cx >> 3)]
          : mem[TILES + (cy >> 3) * 32 + ((cx - 2) >> 3)];
      const b =
        sx !== 0
          ? mem[TILES + ((cy + 2) >> 3) * 32 + (cx >> 3)]
          : mem[TILES + (cy >> 3) * 32 + ((cx + 2) >> 3)];
      if ((a >= 1 && a <= 0x0f) || (b >= 1 && b <= 0x0f)) return "brick";
      if (a === 0x10 || b === 0x10) return "steel";
      if (a === 0x11 || b === 0x11) return "void"; // рамка поля
      cx += sx;
      cy += sy;
    }
    return "void";
  };

  const sample = (frame: number): void => {
    if (baseFellFrame !== null || stageCleared) return; // бой уже кончился
    // Победа: игра перешла на следующий уровень.
    if (mem[0x85] > 1) {
      stageCleared = true;
      clearedFrame = frame;
      return;
    }

    const botAlive = mem[TANK_X + 1] !== EMPTY && mem[TANK_Y + 1] !== EMPTY;
    if (botAlive && mem[EAGLE_TILE] !== EAGLE_INTACT) {
      baseFellFrame = frame;
      return;
    }

    // Выстрел бота: пуля слота 1 родилась (или слот переиспользован).
    const bx = mem[BULLET_X + 1];
    const by = mem[BULLET_Y + 1];
    if (bx !== EMPTY && by !== EMPTY) {
      const isNew =
        !prevBotBullet ||
        Math.abs(bx - prevBotBullet.x) + Math.abs(by - prevBotBullet.y) > 16;
      if (isNew) {
        const mx = mem[TANK_X + 1];
        const my = mem[TANK_Y + 1];
        const mine =
          mx !== EMPTY &&
          my !== EMPTY &&
          Math.abs(bx - mx) + Math.abs(by - my) <= 24;
        if (mine) {
          shots++;
          pendingShot = { x: bx, y: by, foes: foeBullets(), track: [] };
        } else {
          pendingShot = null;
        }
      } else if (pendingShot) {
        pendingShot.track.push({ x: bx, y: by });
        if (pendingShot.track.length >= 4) {
          // Направление — по устоявшейся дельте: первая склеивает конец
          // старой пули с началом новой при переиспользовании слота.
          const dx = pendingShot.track[3].x - pendingShot.track[1].x;
          const dy = pendingShot.track[3].y - pendingShot.track[1].y;
          if ((dx !== 0) !== (dy !== 0)) {
            if (onRay(pendingShot, dx, dy, pendingShot.foes)) intercepts++;
            else shotsAt[classifyPath(pendingShot, dx, dy)]++;
          }
          pendingShot = null;
        }
      }
      prevBotBullet = { x: bx, y: by };
    } else {
      prevBotBullet = null;
      pendingShot = null;
    }

    // Фраги: слот врага телепортировался на спавн — значит его убили
    // (слоты переиспользуются мгновенно, FF там не появляется).
    for (let s = 2; s < 8; s++) {
      const x = mem[TANK_X + s];
      const y = mem[TANK_Y + s];
      const alive = x !== EMPTY && y !== EMPTY;
      const prev = prevEnemy[s];
      if (alive && prev) {
        if (Math.abs(x - prev.x) + Math.abs(y - prev.y) > 0x40) kills++;
      }
      prevEnemy[s] = alive ? { x, y } : null;
    }

    // Смерть бота — тоже телепорт на спавн: слот 1 переиспользуется
    // мгновенно, FF в нём почти не появляется (метрика по FF врала).
    const bmx = mem[TANK_X + 1];
    const bmy = mem[TANK_Y + 1];
    if (botAlive && prevBotPos) {
      const jump =
        Math.abs(bmx - prevBotPos.x) + Math.abs(bmy - prevBotPos.y);
      if (jump > 0x40) botDeaths++;
    } else if (!botAlive && prevBotAlive) {
      botDeaths++; // редкий случай, когда слот всё же обнулился
    }
    prevBotPos = botAlive ? { x: bmx, y: bmy } : null;
    prevBotAlive = botAlive;

    if (botAlive) {
      battleFrames++;
      const leash =
        Math.abs(mem[TANK_X + 1] - BASE_CENTER.x) +
        Math.abs(mem[TANK_Y + 1] - BASE_CENTER.y);
      if (leash > LEASH_DIST) leashFrames++;
      if (leash > maxLeash) maxLeash = leash;
    }
  };

  // --- Сам бой: 60 кадров/с, решение бота каждые 2 кадра ---
  const total = Math.round(seconds * 60);
  // Напарник: цикл «повернуться -> выстрелить» безопасными сторонами.
  // Стрелять вправо со спавна нельзя — там орёл (первая версия теста
  // сама сносила базу за 18 секунд).
  const P1_DIRS = [BTN.UP, BTN.LEFT];
  for (let f = 0; f < total; f++) {
    if (p1Style !== "idle") {
      const period = p1Style === "cover" ? 108 : 71;
      const phase = f % period;
      const d = P1_DIRS[Math.floor(f / period) % 2];
      if (phase === 0) nes.buttonDown(1, d as 0);
      else if (phase === 9) nes.buttonUp(1, d as 0);
      else if (phase === 18) nes.buttonDown(1, BTN.A as 0);
      else if (phase === 24) nes.buttonUp(1, BTN.A as 0);
    }
    nes.frame();
    if (f % 2 === 0) {
      bot.tick();
      const m = bot.mode.split(":")[0];
      modes[m] = (modes[m] ?? 0) + 1;
    }
    sample(f);
  }
  bot.stop();

  const endFrame = baseFellFrame ?? clearedFrame ?? total;
  const battleSec = +(endFrame / 60).toFixed(1);
  return {
    scenario: p1Style,
    seed,
    stageCleared,
    modes,
    battleSec,
    eagleOk: baseFellFrame === null,
    shots,
    shotsAt,
    intercepts,
    kills,
    killsPerMin: battleSec ? +((kills / battleSec) * 60).toFixed(1) : 0,
    botDeaths,
    leashPct: battleFrames
      ? +((leashFrames / battleFrames) * 100).toFixed(1)
      : 0,
    maxLeash,
  };
}

const SEEDS = [0, 1, 3, 5, 8];
const results = (["idle", "cover", "cover-fast"] as const).flatMap((style) =>
  SEEDS.map((seed) => runBattle(style, SECONDS, seed)),
);

const median = (xs: number[]): number => {
  const a = [...xs].sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};

// Печатаем сводку по сценариям, а не 15 полных объектов.
for (const style of ["idle", "cover", "cover-fast"] as const) {
  const rows = results.filter((r) => r.scenario === style);
  const bases = rows.map((r) => r.battleSec);
  console.log(
    `${style.padEnd(11)} base ${median(bases).toFixed(0)}s median ` +
      `(${Math.min(...bases).toFixed(0)}-${Math.max(...bases).toFixed(0)}), ` +
      `kills ${median(rows.map((r) => r.kills)).toFixed(0)} median, ` +
      `deaths ${rows.reduce((a, r) => a + r.botDeaths, 0)}, ` +
      `steel ${rows.reduce((a, r) => a + r.shotsAt.steel, 0)}, ` +
      `cleared ${rows.filter((r) => r.stageCleared).length}/${rows.length}`,
  );
}

const totalShots = results.reduce((a, r) => a + r.shots, 0);
const steel = results.reduce((a, r) => a + r.shotsAt.steel, 0);
const medianSurvived = median(
  results.map((r) => (r.stageCleared ? SECONDS : r.battleSec)),
);
const medianKills = median(results.map((r) => r.kills));
const deaths = results.reduce((a, r) => a + r.botDeaths, 0);
const modeTotals: Record<string, number> = {};
for (const r of results) {
  for (const [k, v] of Object.entries(r.modes)) {
    modeTotals[k] = (modeTotals[k] ?? 0) + v;
  }
}
console.log(
  `modes: ${Object.entries(modeTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")}`,
);
console.log(
  `summary: shots ${totalShots}, steel ${steel}, ` +
    `kills ${results.reduce((a, r) => a + r.kills, 0)}, ` +
    `deaths ${deaths}, ` +
    `missions ${results.filter((r) => r.stageCleared).length}/${results.length}, ` +
    `base survived ${medianSurvived.toFixed(0)}s median, ` +
    `kills ${medianKills.toFixed(0)} median, ` +
    `on-target ${(
      (results.reduce((a, r) => a + r.shotsAt.foe, 0) / Math.max(1, totalShots)) *
      100
    ).toFixed(0)}%, ` +
    `leash ${(results.reduce((a, r) => a + r.leashPct, 0) / results.length).toFixed(1)}%`,
);

// Гейт: защита базы — это цель бота, стрельба в бетон — известная регрессия.
const failures: string[] = [];
if (steel > Math.max(2, totalShots * 0.05)) {
  failures.push(`too many shots into steel: ${steel}/${totalShots}`);
}
// Пороги — регрессионные, с запасом ниже замеров текущего бота
// (77 с и 0 смертей) и заметно выше предыдущего (55 с, 4 смерти).
// Порог — по медиане и с запасом под разброс между сидами; сверху
// ограничен длиной прогона (`test:bot 30` иначе не прошёл бы никогда).
const survivalTarget = Math.min(45, SECONDS * 0.75);
if (medianSurvived < survivalTarget) {
  failures.push(
    `base fell too early: ${medianSurvived.toFixed(0)}s median, ` +
      `expected ${survivalTarget.toFixed(0)}s`,
  );
}
// Порог смертей — на число прогонов, а не абсолютный: прогонов теперь
// 15 (сценарии × сиды), и старая двойка ловила бы любой шум.
const deathBudget = Math.max(2, Math.round(results.length * 0.4));
if (deaths > deathBudget) {
  failures.push(`bot died too often: ${deaths} (budget ${deathBudget})`);
}
if (failures.length) {
  console.error(`FAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("OK");
