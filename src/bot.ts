import type { NES } from "jsnes";
import { MASKS, type ButtonMask } from "./controls";

/**
 * Бот для Battle City: играет на слоте P2, читая память консоли напрямую.
 *
 * Карта RAM снята реверсом на официальном дампе (Namcot Collection) и
 * проверена живым вводом: массив X-координат танков в $90-$97, Y — в
 * $98-$9F; слот 0 — P1, слот 1 — P2, слоты 2-7 — враги; 0xFF — слот пуст.
 *
 * Железные правила безопасности: бот НИКОГДА не стреляет, если на линии
 * огня союзник (P1) или зона базы — пуля по орлу означает game over,
 * пуля по напарнику — заморозку.
 *
 * Тактика: защита базы прежде всего (цель — враг, ближайший к орлу),
 * гистерезис направления (не дёргается), при застревании простреливает
 * кирпич перед собой (если безопасно) и объезжает перпендикуляром.
 */

const X0 = 0x90;
const Y0 = 0x98;
// Пули — те же слоты, что танки (0=P1, 1=P2, 2-7 враги); реверс подтверждён:
// выстрел P2 оживил $B9/$C3, вражеские снаряды летают в слотах 2-7.
const BX0 = 0xb8;
const BY0 = 0xc2;
const EMPTY = 0xff;

// Зона орла: центр нижнего ряда поля (эмпирически по стартовым позициям:
// P1 спавн x=0x58, P2 x=0x98, база между ними).
const BASE = { x1: 0x68, x2: 0x90, y1: 0xc8, y2: 0xe4 };
const BASE_CENTER = { x: 0x7c, y: 0xd8 };

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
  /** Не менять направление N тиков после поворота — против дёрганья. */
  let dirLock = 0;
  /** Чередование стороны объезда, чтобы не биться в один угол. */
  let sideToggle = false;
  /** Одна попытка прострелить препятствие перед объездом. */
  let blastTried = false;
  let lastX = -1;
  let lastY = -1;
  let stuckTicks = 0;

  const read = (slot: number): Tank | null => {
    const x = mem[X0 + slot];
    const y = mem[Y0 + slot];
    if (x === EMPTY || y === EMPTY) return null;
    return { x, y };
  };

  // Вражеские пули с вектором движения: направление выводится трекингом
  // между тиками (за 66 мс снаряд проходит ~8px — надёжно различимо).
  interface Bullet extends Tank {
    dx: number;
    dy: number;
  }
  const prevBullets: Array<Tank | null> = Array(8).fill(null);
  const readBullets = (): Bullet[] => {
    const out: Bullet[] = [];
    for (let s = 2; s < 8; s++) {
      const x = mem[BX0 + s];
      const y = mem[BY0 + s];
      if (x === EMPTY || y === EMPTY) {
        prevBullets[s] = null;
        continue;
      }
      const prev = prevBullets[s];
      if (prev) out.push({ x, y, dx: x - prev.x, dy: y - prev.y });
      prevBullets[s] = { x, y };
    }
    return out;
  };

  const inBaseLine = (from: Tank, d: Dir): boolean => {
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

  /** Можно ли стрелять в направлении d: ни союзника, ни базы на линии. */
  const safeFire = (me: Tank, ally: Tank | null, d: Dir): boolean =>
    !(ally && onFireLine(me, ally, d)) && !inBaseLine(me, d);

  const perpendicular = (d: Dir): Dir => {
    sideToggle = !sideToggle;
    if (d === "UP" || d === "DOWN") return sideToggle ? "LEFT" : "RIGHT";
    return sideToggle ? "UP" : "DOWN";
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

    if (Math.abs(me.x - lastX) < 2 && Math.abs(me.y - lastY) < 2) {
      stuckTicks++;
    } else {
      stuckTicks = 0;
      blastTried = false;
    }
    lastX = me.x;
    lastY = me.y;

    if (fireCooldown > 0) fireCooldown--;

    // Угроза важнее атаки: пуля, летящая к нам по оси с малым поперечным
    // отклонением и в пределах опасной дистанции.
    let threat: Bullet | null = null;
    for (const b of readBullets()) {
      const closingX = (b.dx > 0 && b.x < me.x) || (b.dx < 0 && b.x > me.x);
      const closingY = (b.dy > 0 && b.y < me.y) || (b.dy < 0 && b.y > me.y);
      if (b.dx !== 0 && closingX && Math.abs(b.y - me.y) <= 10 &&
          Math.abs(b.x - me.x) <= 0x48) {
        threat = b;
        break;
      }
      if (b.dy !== 0 && closingY && Math.abs(b.x - me.x) <= 10 &&
          Math.abs(b.y - me.y) <= 0x48) {
        threat = b;
        break;
      }
    }
    if (threat) {
      // Перехват: если ствол уже смотрит навстречу — стреляем (снаряды в
      // Battle City взаимно уничтожаются), продолжая уходить с линии.
      const head: Dir =
        threat.dx !== 0
          ? threat.dx > 0
            ? "LEFT"
            : "RIGHT"
          : threat.dy > 0
            ? "UP"
            : "DOWN";
      const intercept =
        dir === head && safeFire(me, ally, dir) && fireCooldown <= 0;
      // Уклонение: перпендикулярно оси полёта, расширяя разрыв с линией.
      dir =
        threat.dx !== 0
          ? me.y <= threat.y
            ? "UP"
            : "DOWN"
          : me.x <= threat.x
            ? "LEFT"
            : "RIGHT";
      dirLock = 2;
      if (intercept) fireCooldown = 4;
      setButtons((DIR_MASK[dir] | (intercept ? MASKS.A : 0)) & 0xff);
      return;
    }

    let fire = false;

    if (enemies.length === 0) {
      // Патруль: держимся верхней половины, подальше от базы.
      if (me.y > 0x60) dir = "UP";
      if (stuckTicks > 5) {
        dir = perpendicular(dir);
        stuckTicks = 0;
      }
    } else {
      // Цель: защита орла важнее погони — враг, ближайший к базе,
      // с поправкой на расстояние до нас.
      let target = enemies[0];
      let best = Infinity;
      for (const e of enemies) {
        const toBase =
          Math.abs(e.x - BASE_CENTER.x) + Math.abs(e.y - BASE_CENTER.y);
        const toMe = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
        const score = toBase * 2 + toMe;
        if (score < best) {
          best = score;
          target = e;
        }
      }
      const dx = target.x - me.x;
      const dy = target.y - me.y;

      let want: Dir;
      const aligned =
        Math.abs(dx) <= AIM_TOLERANCE || Math.abs(dy) <= AIM_TOLERANCE;
      if (Math.abs(dx) <= AIM_TOLERANCE) want = dy < 0 ? "UP" : "DOWN";
      else if (Math.abs(dy) <= AIM_TOLERANCE) want = dx < 0 ? "LEFT" : "RIGHT";
      else if (Math.abs(dx) > Math.abs(dy)) want = dx < 0 ? "LEFT" : "RIGHT";
      else want = dy < 0 ? "UP" : "DOWN";

      // Цель на мушке — доворот мгновенный; иначе гистерезис против дёрганья.
      if (aligned) {
        dir = want;
        dirLock = 0;
      } else if (dirLock > 0) {
        dirLock--;
      } else if (want !== dir) {
        dir = want;
        dirLock = 3;
      }

      // Застряли: одна попытка прострелить кирпич по курсу (безопасно ли!),
      // затем объезд перпендикуляром — чередуя сторону.
      if (stuckTicks > 5) {
        if (!blastTried && safeFire(me, ally, dir)) {
          blastTried = true;
          stuckTicks = 3; // дать пуле долететь, не поворачивая
          fire = true;
        } else {
          dir = perpendicular(dir);
          dirLock = 4;
          stuckTicks = 0;
          blastTried = false;
        }
      }

      // Боевая стрельба: цель на линии и линия чистая.
      if (
        onFireLine(me, target, dir) &&
        safeFire(me, ally, dir) &&
        fireCooldown <= 0
      ) {
        fire = true;
      }
    }

    if (fire) fireCooldown = 4; // не заливать очередью

    setButtons((DIR_MASK[dir] | (fire ? MASKS.A : 0)) & 0xff);
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
