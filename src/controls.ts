import { NES, Controller } from "jsnes";

/**
 * Состояние геймпада — один байт, бит i соответствует кнопке i
 * в нумерации jsnes: A=0, B=1, SELECT=2, START=3, UP=4, DOWN=5, LEFT=6, RIGHT=7.
 * Байт удобно слать по сети и сравнивать на изменение.
 */
export type ButtonMask = number;

const BIT_BY_NAME: Record<string, number> = {
  A: 1 << Controller.BUTTON_A,
  B: 1 << Controller.BUTTON_B,
  SELECT: 1 << Controller.BUTTON_SELECT,
  START: 1 << Controller.BUTTON_START,
  UP: 1 << Controller.BUTTON_UP,
  DOWN: 1 << Controller.BUTTON_DOWN,
  LEFT: 1 << Controller.BUTTON_LEFT,
  RIGHT: 1 << Controller.BUTTON_RIGHT,
};

/** Битовые маски кнопок для сборки состояния вручную (виртуальный стик). */
export const MASKS = {
  A: BIT_BY_NAME.A,
  B: BIT_BY_NAME.B,
  SELECT: BIT_BY_NAME.SELECT,
  START: BIT_BY_NAME.START,
  UP: BIT_BY_NAME.UP,
  DOWN: BIT_BY_NAME.DOWN,
  LEFT: BIT_BY_NAME.LEFT,
  RIGHT: BIT_BY_NAME.RIGHT,
} as const;

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

/** Применяет разницу двух масок к эмулятору через buttonDown/buttonUp. */
export function applyButtons(
  nes: NES,
  player: 1 | 2,
  prev: ButtonMask,
  next: ButtonMask,
): void {
  const changed = prev ^ next;
  if (!changed) return;
  for (let bit = 0; bit < 8; bit++) {
    const flag = 1 << bit;
    if (!(changed & flag)) continue;
    if (next & flag) nes.buttonDown(player, bit as 0);
    else nes.buttonUp(player, bit as 0);
  }
}

/**
 * Объединяет несколько источников ввода (тачскрин, клавиатура) в одну маску
 * через OR: кнопка нажата, пока её держит хотя бы один источник.
 */
export class InputAggregator {
  private sources = new Map<string, ButtonMask>();
  private last: ButtonMask = 0;

  constructor(private onChange: (mask: ButtonMask) => void) {}

  set(source: string, mask: ButtonMask): void {
    this.sources.set(source, mask);
    let combined = 0;
    for (const m of this.sources.values()) combined |= m;
    if (combined !== this.last) {
      this.last = combined;
      this.onChange(combined);
    }
  }

  get mask(): ButtonMask {
    return this.last;
  }
}

/**
 * Тачскрин-геймпад. Кнопки определяются по координате пальца, а не по цели
 * события: палец можно проводить между зонами D-pad не отрывая, и диагонали
 * работают через зоны с data-button="UP,LEFT".
 */
export function attachTouchpad(
  pad: HTMLElement,
  onState: (mask: ButtonMask) => void,
): () => void {
  const pointers = new Map<number, ButtonMask>();
  let last: ButtonMask = 0;

  function maskAtPoint(x: number, y: number): ButtonMask {
    for (const el of document.elementsFromPoint(x, y)) {
      const attr = (el as HTMLElement).dataset?.button;
      if (attr) {
        let mask = 0;
        for (const name of attr.split(",")) mask |= BIT_BY_NAME[name.trim()] ?? 0;
        return mask;
      }
    }
    return 0;
  }

  function emit(): void {
    let mask = 0;
    for (const m of pointers.values()) mask |= m;
    if (mask !== last) {
      last = mask;
      onState(mask);
    }
  }

  function onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    pointers.set(e.pointerId, maskAtPoint(e.clientX, e.clientY));
    emit();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.set(e.pointerId, maskAtPoint(e.clientX, e.clientY));
    emit();
  }

  function onPointerUp(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId)) return;
    emit();
  }

  pad.addEventListener("pointerdown", onPointerDown);
  pad.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  return () => {
    pad.removeEventListener("pointerdown", onPointerDown);
    pad.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    if (last !== 0) onState(0);
  };
}

// Маска направления по вектору от точки касания: 8 секторов по 45°,
// сектор 0 — вправо, дальше по часовой (ось Y экрана растёт вниз).
const SECTOR_MASKS = [
  MASKS.RIGHT,
  MASKS.RIGHT | MASKS.DOWN,
  MASKS.DOWN,
  MASKS.DOWN | MASKS.LEFT,
  MASKS.LEFT,
  MASKS.LEFT | MASKS.UP,
  MASKS.UP,
  MASKS.UP | MASKS.RIGHT,
];

/**
 * Плавающий виртуальный стик: палец кладётся в любое место зоны, там
 * появляется основание, направление считается по вектору от точки касания.
 * 8 направлений с мёртвой зоной — как D-pad, но по-современному.
 */
export function attachStick(
  zone: HTMLElement,
  base: HTMLElement,
  nub: HTMLElement,
  onState: (mask: ButtonMask) => void,
): () => void {
  const DEAD_PX = 14; // мёртвая зона в пикселях
  const RANGE_PX = 40; // максимум визуального отклонения шляпки

  let pointerId: number | null = null;
  let originX = 0;
  let originY = 0;
  let last: ButtonMask = 0;

  function emit(mask: ButtonMask): void {
    if (mask !== last) {
      last = mask;
      onState(mask);
    }
  }

  function update(x: number, y: number): void {
    const dx = x - originX;
    const dy = y - originY;
    const dist = Math.hypot(dx, dy);

    const clamped = dist > RANGE_PX ? RANGE_PX / dist : 1;
    nub.style.transform = `translate(${dx * clamped}px, ${dy * clamped}px)`;

    if (dist < DEAD_PX) {
      emit(0);
      return;
    }
    const angle = Math.atan2(dy, dx); // -PI..PI, 0 — вправо
    const sector = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
    emit(SECTOR_MASKS[sector]);
  }

  function release(): void {
    pointerId = null;
    base.hidden = true;
    nub.style.transform = "translate(0, 0)";
    emit(0);
  }

  function onPointerDown(e: PointerEvent): void {
    if (pointerId !== null) return; // стик уже занят другим пальцем
    e.preventDefault();
    pointerId = e.pointerId;
    originX = e.clientX;
    originY = e.clientY;
    // Основание появляется там, куда лёг палец.
    const zoneRect = zone.getBoundingClientRect();
    base.style.left = `${originX - zoneRect.left}px`;
    base.style.top = `${originY - zoneRect.top}px`;
    base.hidden = false;
    update(e.clientX, e.clientY);
  }

  function onPointerMove(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    update(e.clientX, e.clientY);
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    release();
  }

  zone.addEventListener("pointerdown", onPointerDown);
  zone.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  return () => {
    zone.removeEventListener("pointerdown", onPointerDown);
    zone.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    release();
  };
}

/** Клавиатура: стрелки/WASD, K и J (или X и Z), Enter, Shift. */
export function attachKeyboard(
  onState: (mask: ButtonMask) => void,
): () => void {
  let mask: ButtonMask = 0;

  // Ввод в поле или нажатие Enter на сфокусированной кнопке — не игра:
  // иначе WASD нельзя набрать в поле кода, а Enter «жмёт» Start вместо кнопки.
  function isUiTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest("input, textarea, select, button, a");
  }

  function onKeyDown(e: KeyboardEvent): void {
    const name = KEYBOARD_MAP[e.code];
    if (!name || isUiTarget(e)) return;
    e.preventDefault();
    const next = mask | BIT_BY_NAME[name];
    if (next !== mask) onState((mask = next));
  }

  function onKeyUp(e: KeyboardEvent): void {
    const name = KEYBOARD_MAP[e.code];
    if (!name || isUiTarget(e)) return;
    e.preventDefault();
    const next = mask & ~BIT_BY_NAME[name];
    if (next !== mask) onState((mask = next));
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    if (mask !== 0) onState(0);
  };
}
