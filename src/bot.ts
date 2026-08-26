import type { NES } from "jsnes";
import { MASKS, type ButtonMask } from "./controls";

/**
 * Бот для Battle City: играет на слоте P2, читая память консоли напрямую.
 *
 * Карта RAM снята реверсом на официальном дампе (Namcot Collection) и
 * проверена живым вводом: X танков $90-$97, Y $98-$9F (слот 0 — P1,
 * слот 1 — P2, слоты 2-7 — враги, 0xFF — пусто); пули в тех же слотах:
 * X $B8+слот, Y $C2+слот. Координаты — центр танка в экранных пикселях.
 *
 * Поле: тайлы 8px в $400+, stride 32, индекс (y>>3)*32+(x>>3); поле
 * занимает тайлы 2-27 по обеим осям. Значения: $0F кирпич (пуля грызёт),
 * $10 сталь (глушит пулю), $11 рамка/панель, $C8-$CB орёл, прочее
 * (вода/лёд/лес) пуле не мешает.
 *
 * Железные правила: бот НИКОГДА не стреляет, если на линии огня союзник
 * или зона базы. Тик 30 Гц — реакции на пулю в упор хватает.
 */

const X0 = 0x90;
const Y0 = 0x98;
const BX0 = 0xb8;
const BY0 = 0xc2;
const EMPTY = 0xff;
const TILE_BASE = 0x400;
const T_BRICK = 0x0f;
const T_STEEL = 0x10;
const T_BORDER = 0x11;

const BASE = { x1: 0x68, x2: 0x90, y1: 0xc8, y2: 0xe4 };
const BASE_CENTER = { x: 0x7c, y: 0xd8 };

const TICK_MS = 33; // 30 решений в секунду
const AIM_TOLERANCE = 6;
/** Прицел оппортуниста: враг «на линии» для мгновенного доворота. */
const SNAP_TOLERANCE = 10;
/** В упор допуск шире: пуля широкая, а «проезжающий вплотную» не прощается. */
const SNAP_TOLERANCE_NEAR = 13;
const SNAP_NEAR_DIST = 0x40;
/** Дальность снайперского рефлекса. */
const SNAP_RANGE = 0x78;
const ALLY_RADIUS = 12;
/** Враг ближе этого — самозащита важнее охраны базы. */
const SELF_DEFENSE_DIST = 0x30;
/** Пост обороны: чуть выше и правее орла (наша спавн-сторона). */
const ANCHOR = { x: 0x98, y: 0xb0 };
/** «Поводок»: дальше этого от базы в погоню не уходим. */
const LEASH_DIST = 0x70;
/** Возврат с гистерезисом: домой до этой глубины, иначе пинг-понг на границе. */
const LEASH_RESET = 0x40;
/** Цели дальше этого от орла не выбираются вовсе — защитник, не охотник. */
const ENGAGE_RADIUS = 0x70;
/** Прорыв: враг в нижней зоне И близко к орлу (Manhattan). Раньше вся
 *  нижняя половина поля считалась прорывом — враги там есть почти всегда,
 *  поводок не включался, и бот вечно гонялся по всей карте. */
const BREACH_Y = 0x88;
const BREACH_RADIUS = 0x60;

interface Tank {
  x: number;
  y: number;
}

interface Enemy extends Tank {
  slot: number;
}

interface Bullet extends Tank {
  dx: number;
  dy: number;
  /** Пуля игрока-союзника: морозит, но не убивает — паника не нужна. */
  friendly: boolean;
}

type Dir = "UP" | "DOWN" | "LEFT" | "RIGHT";

const DIR_MASK: Record<Dir, ButtonMask> = {
  UP: MASKS.UP,
  DOWN: MASKS.DOWN,
  LEFT: MASKS.LEFT,
  RIGHT: MASKS.RIGHT,
};

export interface Bot {
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
  /** Гистерезис направления — против дёрганья (в тиках 30 Гц). */
  let dirLock = 0;
  let sideToggle = false;
  let blastTried = false;
  let lastX = -1;
  let lastY = -1;
  let stuckTicks = 0;
  /** Выбранное уклонение держится, пока угроза не пройдёт — без дребезга. */
  let dodgeDir: Dir | null = null;
  /** Лок цели: не перескакивать между врагами каждый тик. */
  let targetSlot = -1;
  let targetTicks = 0;
  /** Возврат на пост: включается за поводком, отпускает только у орла. */
  let returning = false;

  const read = (slot: number): Tank | null => {
    const x = mem[X0 + slot];
    const y = mem[Y0 + slot];
    if (x === EMPTY || y === EMPTY) return null;
    return { x, y };
  };

  const prevBullets: Array<Tank | null> = Array(8).fill(null);
  const readBullets = (): Bullet[] => {
    const out: Bullet[] = [];
    // Слот 0 — пуля P1: она тоже опасна (замораживает союзника), полевой
    // случай «зареспаунился и убил бота» — бот её просто не видел.
    // Слот 1 — своя пуля, её пропускаем.
    for (let s = 0; s < 8; s++) {
      if (s === 1) continue;
      const x = mem[BX0 + s];
      const y = mem[BY0 + s];
      if (x === EMPTY || y === EMPTY) {
        prevBullets[s] = null;
        continue;
      }
      const prev = prevBullets[s];
      if (prev) {
        const dx = x - prev.x;
        const dy = y - prev.y;
        // Слот переиспользуется без промежуточного FF: склейка конца старой
        // пули с началом новой даёт мусорный вектор — отбрасываем сэмпл.
        if (Math.abs(dx) <= 24 && Math.abs(dy) <= 24) {
          out.push({ x, y, dx, dy, friendly: s === 0 });
        }
      }
      prevBullets[s] = { x, y };
    }
    return out;
  };

  /**
   * Первая преграда на линии выстрела: сталь — пуля погибнет без пользы;
   * кирпич (включая прогрызенные четвертинки $01-$0E) — выстрел полезен;
   * рамка поля ($11 и выход за границы) — пусто до края. Неизвестные
   * значения тайлов считаются пустотой: на экзотических стадиях бот
   * безопасно откатывается к старому поведению. Пуля шире точки, поэтому
   * на стыке тайлов смотрим обе стороны линии; кирпич приоритетнее стали —
   * пуля выгрызает свою половину стыка.
   */
  const firstObstacle = (
    from: Tank,
    d: Dir,
    dist: number,
  ): { kind: "steel" | "brick" | "border"; dist: number } | null => {
    const sx = d === "LEFT" ? -8 : d === "RIGHT" ? 8 : 0;
    const sy = d === "UP" ? -8 : d === "DOWN" ? 8 : 0;
    // старт от кромки корпуса (центр ±8) плюс полшага
    let x = from.x + sx * 1.5;
    let y = from.y + sy * 1.5;
    for (let travelled = 12; travelled < dist; travelled += 8) {
      if (x < 16 || x > 223 || y < 16 || y > 223) {
        return { kind: "border", dist: travelled };
      }
      const a =
        sx !== 0
          ? mem[TILE_BASE + ((y - 2) >> 3) * 32 + (x >> 3)]
          : mem[TILE_BASE + (y >> 3) * 32 + ((x - 2) >> 3)];
      const b =
        sx !== 0
          ? mem[TILE_BASE + ((y + 2) >> 3) * 32 + (x >> 3)]
          : mem[TILE_BASE + (y >> 3) * 32 + ((x + 2) >> 3)];
      const brick =
        (a >= 1 && a <= T_BRICK) || (b >= 1 && b <= T_BRICK);
      if (brick) return { kind: "brick", dist: travelled };
      if (a === T_STEEL || b === T_STEEL) {
        return { kind: "steel", dist: travelled };
      }
      if (a === T_BORDER || b === T_BORDER) {
        return { kind: "border", dist: travelled };
      }
      x += sx;
      y += sy;
    }
    return null;
  };

  /** Выстрел в направлении d бесполезен: первым на пути стоит бетон/рамка. */
  const wastedShot = (from: Tank, d: Dir, dist: number): boolean => {
    const hit = firstObstacle(from, d, dist);
    if (!hit) return false;
    // Рамка блокирует только в упор: дальний «пустой» выстрел безвреден,
    // а враги как цели в карте тайлов не видны.
    if (hit.kind === "border") return hit.dist <= 0x20;
    return hit.kind === "steel";
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

  const safeFire = (me: Tank, ally: Tank | null, d: Dir): boolean =>
    !(ally && onFireLine(me, ally, d)) && !inBaseLine(me, d);

  const perpendicular = (d: Dir): Dir => {
    sideToggle = !sideToggle;
    if (d === "UP" || d === "DOWN") return sideToggle ? "LEFT" : "RIGHT";
    return sideToggle ? "UP" : "DOWN";
  };

  const tick = (): void => {
    if (paused) return;

    const me = read(1);
    if (!me) {
      setButtons(0);
      dodgeDir = null;
      targetSlot = -1;
      return;
    }
    const ally = read(0);
    const enemies: Enemy[] = [];
    for (let s = 2; s < 8; s++) {
      const e = read(s);
      if (e) enemies.push({ ...e, slot: s });
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
    if (dirLock > 0) dirLock--;
    if (targetTicks > 0) targetTicks--;

    // --- Угроза важнее атаки: летящая в нас пуля --------------------------
    // Дружеская (P1) лишь морозит: реагируем только в упор, иначе бот
    // вечно уклоняется от союзника вместо боя («мимо проезжают — не видит»).
    let threat: Bullet | null = null;
    for (const b of readBullets()) {
      const range = b.friendly ? 0x28 : 0x58;
      const closingX = (b.dx > 0 && b.x < me.x) || (b.dx < 0 && b.x > me.x);
      const closingY = (b.dy > 0 && b.y < me.y) || (b.dy < 0 && b.y > me.y);
      if (
        b.dx !== 0 && closingX &&
        Math.abs(b.y - me.y) <= 12 && Math.abs(b.x - me.x) <= range
      ) {
        threat = b;
        break;
      }
      if (
        b.dy !== 0 && closingY &&
        Math.abs(b.x - me.x) <= 12 && Math.abs(b.y - me.y) <= range
      ) {
        threat = b;
        break;
      }
    }

    if (threat) {
      // Перехват встречной пули своей (по ТЕКУЩЕМУ направлению ствола).
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

      if (intercept) {
        // Ствол уже смотрит навстречу — стреляем, НЕ поворачивая: нажатое
        // направление разворачивает танк до выстрела, и «перехватная» пуля
        // улетала вбок по уклонению. Уклонимся со следующего тика.
        fireCooldown = 8;
        setButtons((DIR_MASK[head] | MASKS.A) & 0xff);
        return;
      }

      // Уклонение выбирается ОДИН раз на угрозу и держится до её конца —
      // пересчёт каждый тик давал дребезг на границе линии.
      if (!dodgeDir) {
        dodgeDir =
          threat.dx !== 0
            ? me.y <= threat.y
              ? "UP"
              : "DOWN"
            : me.x <= threat.x
              ? "LEFT"
              : "RIGHT";
      }
      dir = dodgeDir;
      setButtons(DIR_MASK[dir] & 0xff);
      return;
    }
    dodgeDir = null;

    let fire = false;

    // Далеко от орла и прорыва нет — приоритет «домой». Считается ДО
    // снайперского рефлекса: раньше рефлекс перехватывал каждый тик
    // (наверху всегда кто-то на линии), бот застревал в карусели
    // довортов у чужого спавна, а базу сносили (полевой отчёт).
    const myLeash =
      Math.abs(me.x - BASE_CENTER.x) + Math.abs(me.y - BASE_CENTER.y);
    const isBreach = (e: Enemy): boolean =>
      e.y >= BREACH_Y &&
      Math.abs(e.x - BASE_CENTER.x) + Math.abs(e.y - BASE_CENTER.y) <=
        BREACH_RADIUS;
    const breachNow = enemies.some(isBreach);
    if (myLeash > LEASH_DIST) returning = true;
    else if (myLeash <= LEASH_RESET) returning = false;
    const homeSick = !breachNow && returning;
    const towardsBase = (d: Dir): boolean =>
      d === "DOWN"
        ? me.y < BASE_CENTER.y
        : d === "UP"
          ? me.y > BASE_CENTER.y
          : d === "LEFT"
            ? me.x > BASE_CENTER.x
            : me.x < BASE_CENTER.x;

    // --- Снайперский рефлекс: любой враг на нашей линии — мгновенный
    // доворот и выстрел, поверх текущих планов. Это «мочить проезжающих»:
    // навигация к далёкой цели не должна прощать подставившегося рядом.
    // За поводком рефлекс урезан: только в упор или попутно дороге домой.
    if (enemies.length > 0) {
      let snap: { d: Dir; dist: number } | null = null;
      for (const e of enemies) {
        const ddx = e.x - me.x;
        const ddy = e.y - me.y;
        const tolV =
          Math.abs(ddy) <= SNAP_NEAR_DIST ? SNAP_TOLERANCE_NEAR : SNAP_TOLERANCE;
        const tolH =
          Math.abs(ddx) <= SNAP_NEAR_DIST ? SNAP_TOLERANCE_NEAR : SNAP_TOLERANCE;
        if (Math.abs(ddx) <= tolV && Math.abs(ddy) <= SNAP_RANGE) {
          const d: Dir = ddy < 0 ? "UP" : "DOWN";
          if (
            (!snap || Math.abs(ddy) < snap.dist) &&
            (!homeSick ||
              Math.abs(ddy) <= SELF_DEFENSE_DIST ||
              towardsBase(d)) &&
            safeFire(me, ally, d) &&
            firstObstacle(me, d, Math.abs(ddy))?.kind !== "steel"
          ) {
            snap = { d, dist: Math.abs(ddy) };
          }
        } else if (Math.abs(ddy) <= tolH && Math.abs(ddx) <= SNAP_RANGE) {
          const d: Dir = ddx < 0 ? "LEFT" : "RIGHT";
          if (
            (!snap || Math.abs(ddx) < snap.dist) &&
            (!homeSick ||
              Math.abs(ddx) <= SELF_DEFENSE_DIST ||
              towardsBase(d)) &&
            safeFire(me, ally, d) &&
            firstObstacle(me, d, Math.abs(ddx))?.kind !== "steel"
          ) {
            snap = { d, dist: Math.abs(ddx) };
          }
        }
      }
      if (snap) {
        dir = snap.d;
        dirLock = 3;
        const shoot = fireCooldown <= 0;
        if (shoot) fireCooldown = 6;
        setButtons((DIR_MASK[dir] | (shoot ? MASKS.A : 0)) & 0xff);
        return;
      }
    }

    if (enemies.length === 0) {
      // Без врагов — на пост обороны у орла, а не в погоню наверх.
      if (Math.abs(me.x - ANCHOR.x) > 8) dir = me.x < ANCHOR.x ? "RIGHT" : "LEFT";
      else if (Math.abs(me.y - ANCHOR.y) > 8) dir = me.y < ANCHOR.y ? "DOWN" : "UP";
      if (stuckTicks > 10) {
        if (
          !blastTried &&
          safeFire(me, ally, dir) &&
          !wastedShot(me, dir, 0x40)
        ) {
          blastTried = true;
          stuckTicks = 6;
          fire = true;
        } else {
          dir = perpendicular(dir);
          stuckTicks = 0;
          blastTried = false;
        }
      }
    } else {
      // --- Выбор цели -----------------------------------------------------
      // Защитник, не охотник: в погоню годятся только враги в радиусе от
      // орла — иначе бот уезжал на чужой спавн, а базу сносили.
      // 0) Прорыв: враг у самой базы — бросаем всё на него.
      // 1) Враг в упор — самозащита немедленно (любой, без радиуса).
      // 2) Иначе держим залоченную цель, пока она жива и в радиусе.
      // 3) Иначе — враг в радиусе, ближайший к базе, с поправкой на нас.
      let target: Enemy | null = null;
      let breacher: Enemy | null = null;
      let breachBest = Infinity;
      let closest: Enemy | null = null;
      let closestDist = Infinity;
      const toBaseOf = (e: Enemy): number =>
        Math.abs(e.x - BASE_CENTER.x) + Math.abs(e.y - BASE_CENTER.y);
      for (const e of enemies) {
        const d = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
        if (d < closestDist) {
          closestDist = d;
          closest = e;
        }
        if (isBreach(e)) {
          const toBase = toBaseOf(e);
          if (toBase < breachBest) {
            breachBest = toBase;
            breacher = e;
          }
        }
      }
      if (breacher) {
        target = breacher;
        targetSlot = breacher.slot;
        targetTicks = 20;
      } else if (!homeSick && closest && closestDist <= SELF_DEFENSE_DIST) {
        // Самозащита — отбиться, не преследовать: на пути домой стрельбу
        // в упор даёт снайперский рефлекс, а погоня за отъезжающим врагом
        // утаскивала бота хвостом через всю карту.
        target = closest;
      } else if (targetTicks > 0) {
        target =
          enemies.find(
            (e) => e.slot === targetSlot && toBaseOf(e) <= ENGAGE_RADIUS,
          ) ?? null;
      }
      if (!target) {
        let best = Infinity;
        for (const e of enemies) {
          const toBase = toBaseOf(e);
          if (toBase > ENGAGE_RADIUS) continue; // не наша зона
          const toMe = Math.abs(e.x - me.x) + Math.abs(e.y - me.y);
          const score = toBase * 2 + toMe;
          if (score < best) {
            best = score;
            target = e;
          }
        }
        if (target) {
          targetSlot = target.slot;
          targetTicks = 20; // ~0.7 c держим выбор
        }
      }

      // «Поводок»: далеко от орла без прорыва — возвращаемся на пост,
      // погоня наверх оставляет базу без прикрытия (проверено: game over).
      if (homeSick) {
        target = null; // цель игнорируем — идём домой
      }

      if (!target) {
        if (Math.abs(me.x - ANCHOR.x) > 8)
          dir = me.x < ANCHOR.x ? "RIGHT" : "LEFT";
        else if (Math.abs(me.y - ANCHOR.y) > 8)
          dir = me.y < ANCHOR.y ? "DOWN" : "UP";
        if (stuckTicks > 10) {
          // Дорогу домой прогрызаем: раньше бот только объезжал и мог
          // кружить в лабиринте, пока базу сносили.
          if (
            !blastTried &&
            safeFire(me, ally, dir) &&
            !wastedShot(me, dir, 0x40)
          ) {
            blastTried = true;
            stuckTicks = 6; // дать пуле долететь, не поворачивая
            fire = true;
          } else {
            dir = perpendicular(dir);
            dirLock = 8;
            stuckTicks = 0;
            blastTried = false;
          }
        }
        if (fire) fireCooldown = 6;
        setButtons((DIR_MASK[dir] | (fire ? MASKS.A : 0)) & 0xff);
        return;
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

      if (aligned) {
        dir = want;
        dirLock = 0;
      } else if (dirLock <= 0 && want !== dir) {
        dir = want;
        dirLock = 6; // ~0.2 с — не дёргаться
      }

      if (stuckTicks > 10) {
        // Упёрлись в сталь/рамку — пробивать бесполезно, сразу в объезд.
        if (
          !blastTried &&
          safeFire(me, ally, dir) &&
          !wastedShot(me, dir, 0x40)
        ) {
          blastTried = true;
          stuckTicks = 6; // дать пуле долететь, не поворачивая
          fire = true;
        } else {
          dir = perpendicular(dir);
          dirLock = 8;
          stuckTicks = 0;
          blastTried = false;
        }
      }

      // Доктрина огня: стрелять почти постоянно, когда линия безопасна, —
      // как играют люди: пули прогрызают кирпич и ловят врагов; идеальное
      // выравнивание — редкость в лабиринте, ждать его = не стрелять вовсе.
      // Кроме случая, когда первым на линии стоит бетон: там пуля гибнет
      // впустую (полевой отчёт «стреляет в бетон»).
      // Скан режем по ближайшему врагу на линии ствола: враг ближе стали —
      // цель поражаема, стена за его спиной не повод молчать.
      let scanDist = 0xd0;
      for (const e of enemies) {
        if (dir === "UP" || dir === "DOWN") {
          if (
            Math.abs(e.x - me.x) <= SNAP_TOLERANCE &&
            (dir === "UP" ? e.y < me.y : e.y > me.y)
          ) {
            scanDist = Math.min(scanDist, Math.abs(e.y - me.y));
          }
        } else if (
          Math.abs(e.y - me.y) <= SNAP_TOLERANCE &&
          (dir === "LEFT" ? e.x < me.x : e.x > me.x)
        ) {
          scanDist = Math.min(scanDist, Math.abs(e.x - me.x));
        }
      }
      if (
        safeFire(me, ally, dir) &&
        fireCooldown <= 0 &&
        !wastedShot(me, dir, scanDist)
      ) {
        fire = true;
      }
    }

    if (fire) fireCooldown = 6;
    setButtons((DIR_MASK[dir] | (fire ? MASKS.A : 0)) & 0xff);
  };

  const timer = setInterval(tick, TICK_MS);

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
