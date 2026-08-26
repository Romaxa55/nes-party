/**
 * Видеозапись тестового боя бота: та же детерминированная симуляция, что в
 * bot-sim.mts, но каждый кадр уходит в ffmpeg и получается mp4 с отладочной
 * разметкой — чтобы смотреть глазами и находить недочёты поведения.
 *
 * Разметка:
 *  - рамка вокруг бота, цвет = режим решения:
 *    зелёный — пост/дом, жёлтый — снайп/доворот, красный — уклонение/перехват,
 *    оранжевый — уходит с чужого прицела, голубой — перекрывает прорыв,
 *    фиолетовый — ведёт цель;
 *  - белый пунктир — куда смотрит ствол бота;
 *  - красный пунктир — вражеский ствол, направленный в сторону бота.
 *
 * Запуск: npm run replay:bot [-- сценарий сид секунд]
 *   сценарий: idle | cover | cover-fast | all (по умолчанию all)
 *   сид: число (по умолчанию 0), секунды: по умолчанию 60
 * Файлы: replays/<сценарий>-s<сид>.mp4
 */
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NES } from "jsnes";
import { startBot } from "../src/bot";
import type { ButtonMask } from "../src/controls";

const ROM_PATH = fileURLToPath(
  new URL("../public/roms/bc.nes", import.meta.url),
);
if (!fs.existsSync(ROM_PATH)) {
  console.error(`нет ${ROM_PATH} — ромы не в git`);
  process.exit(2);
}
const ROM = new Uint8Array(fs.readFileSync(ROM_PATH));
const OUT_DIR = fileURLToPath(new URL("../replays", import.meta.url));
fs.mkdirSync(OUT_DIR, { recursive: true });

type Scenario = "idle" | "cover" | "cover-fast";
const scenarioArg = process.argv[2] ?? "all";
const seed = Number(process.argv[3] ?? 0);
const seconds = Number(process.argv[4] ?? 60);
if (!Number.isFinite(seed) || !Number.isFinite(seconds) || seconds <= 0) {
  console.error("использование: bot-replay.mts [сценарий|all] [сид] [секунды]");
  process.exit(2);
}

const BTN = { A: 0, SELECT: 2, START: 3, UP: 4, LEFT: 6 };
const W = 256;
const H = 240;

/** Цвет рамки по режиму решения бота. */
const MODE_COLOR: Array<[RegExp, [number, number, number]]> = [
  [/^dodge|^intercept/, [255, 60, 60]],
  [/^unaim/, [255, 160, 40]],
  [/^snap|^aiming/, [255, 240, 60]],
  [/^guard/, [80, 200, 255]],
  [/^hunt/, [220, 100, 255]],
  [/^post|^home/, [90, 255, 90]],
];
const colorOf = (mode: string): [number, number, number] => {
  for (const [re, c] of MODE_COLOR) if (re.test(mode)) return c;
  return [180, 180, 180];
};

const DIRS: Array<[number, number]> = [
  [0, -1], // UP
  [-1, 0], // LEFT
  [0, 1], // DOWN
  [1, 0], // RIGHT
];

function putPx(rgb: Uint8Array, x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  rgb[i] = c[0];
  rgb[i + 1] = c[1];
  rgb[i + 2] = c[2];
}

function rect(rgb: Uint8Array, cx: number, cy: number, r: number, c: [number, number, number]): void {
  for (let d = -r; d <= r; d++) {
    putPx(rgb, cx + d, cy - r, c);
    putPx(rgb, cx + d, cy + r, c);
    putPx(rgb, cx - r, cy + d, c);
    putPx(rgb, cx + r, cy + d, c);
  }
}

/** Длина полёта пули из точки в направлении: до кирпича/бетона/края поля. */
function shotLength(mem: number[], x: number, y: number, dir: number): number {
  const [dx, dy] = DIRS[dir];
  for (let t = 10; t < 0xd8; t += 2) {
    const cx = x + dx * t;
    const cy = y + dy * t;
    if (cx < 16 || cx > 223 || cy < 16 || cy > 223) return t;
    const tile = mem[0x400 + (cy >> 3) * 32 + (cx >> 3)];
    if ((tile >= 1 && tile <= 0x11) || tile >= 0xc8) return t;
  }
  return 0xd8;
}

function ray(
  rgb: Uint8Array,
  x: number,
  y: number,
  dir: number,
  len: number,
  c: [number, number, number],
  step = 3,
): void {
  const [dx, dy] = DIRS[dir];
  for (let t = 10; t < len; t += step) {
    putPx(rgb, x + dx * t, y + dy * t, c);
  }
}

async function record(style: Scenario): Promise<void> {
  const out = `${OUT_DIR}/${style}-s${seed}.mp4`;
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${W}x${H}`, "-framerate", "60", "-i", "-",
    "-vf", "scale=768:720:flags=neighbor",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
    out,
  ]);
  ff.stderr.pipe(process.stderr);

  let frame: Uint32Array | null = null;
  const nes = new NES({
    emulateSound: false,
    onFrame: (b: Uint32Array) => {
      frame = b;
    },
  });
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
  // Тот же путь в бой, что и в bot-sim.mts, включая сид.
  frames(240);
  tapP1(BTN.START);
  tapP1(BTN.SELECT);
  tapP1(BTN.START);
  frames(90);
  tapP1(BTN.START);
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

  const rgb = new Uint8Array(W * H * 3);
  const write = (buf: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      ff.stdin.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  const P1_DIRS = [BTN.UP, BTN.LEFT];
  const total = Math.round(seconds * 60);
  for (let f = 0; f < total; f++) {
    if (style !== "idle") {
      const period = style === "cover" ? 108 : 71;
      const phase = f % period;
      const d = P1_DIRS[Math.floor(f / period) % 2];
      if (phase === 0) nes.buttonDown(1, d as 0);
      else if (phase === 9) nes.buttonUp(1, d as 0);
      else if (phase === 18) nes.buttonDown(1, BTN.A as 0);
      else if (phase === 24) nes.buttonUp(1, BTN.A as 0);
    }
    nes.frame();
    if (f % 2 === 0) bot.tick();
    if (!frame) continue;

    // Кадр эмулятора: младший байт — R (проверено классификатором тайлов).
    const src: Uint32Array = frame;
    for (let i = 0; i < W * H; i++) {
      const p = src[i];
      rgb[i * 3] = p & 0xff;
      rgb[i * 3 + 1] = (p >> 8) & 0xff;
      rgb[i * 3 + 2] = (p >> 16) & 0xff;
    }

    const bx = mem[0x91];
    const by = mem[0x99];
    if (bx !== 0xff && by !== 0xff) {
      rect(rgb, bx, by, 10, colorOf(bot.mode));
      // Ствол бота — до места, куда реально долетит пуля.
      const bd = mem[0xa1] & 3;
      ray(rgb, bx, by, bd, shotLength(mem, bx, by, bd), [255, 255, 255], 2);
    }
    for (let s = 2; s < 8; s++) {
      const ex = mem[0x90 + s];
      const ey = mem[0x98 + s];
      if (ex === 0xff || ey === 0xff) continue;
      const d = mem[0xa0 + s] & 3;
      const len = shotLength(mem, ex, ey, d);
      // Луч, ведущий в коридор бота, — плотный; остальные — редкие точки.
      const [ddx, ddy] = DIRS[d];
      const along = ddx !== 0 ? (bx - ex) * ddx : (by - ey) * ddy;
      const across = ddx !== 0 ? Math.abs(by - ey) : Math.abs(bx - ex);
      const atBot = along > 0 && along <= len && across <= 14;
      ray(rgb, ex, ey, d, len, [255, 70, 70], atBot ? 2 : 6);
    }

    await write(rgb);
  }
  bot.stop();
  ff.stdin.end();
  await new Promise((resolve) => ff.on("close", resolve));
  console.log(`записано: ${out}`);
}

const styles: Scenario[] =
  scenarioArg === "all"
    ? ["idle", "cover", "cover-fast"]
    : [scenarioArg as Scenario];
for (const style of styles) {
  await record(style);
}
