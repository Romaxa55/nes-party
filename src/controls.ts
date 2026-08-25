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
 * iOS Safari игнорирует user-scalable=no и местами touch-action: быстрые
 * тапы по кнопке превращаются в double-tap zoom, протяжка — в скролл-баунс.
 * Глушим нативные touch-поведения на игровых зонах напрямую —
 * pointer-события при этом продолжают приходить.
 */
function suppressNativeTouch(el: HTMLElement): () => void {
  const prevent = (e: TouchEvent): void => e.preventDefault();
  el.addEventListener("touchstart", prevent, { passive: false });
  el.addEventListener("touchmove", prevent, { passive: false });
  return () => {
    el.removeEventListener("touchstart", prevent);
    el.removeEventListener("touchmove", prevent);
  };
}

/** Короткий тактильный отклик на нажатие; iOS вибрацию не даёт — молча нет. */
let lastBuzzAt = 0;
function buzz(): void {
  if (!("vibrate" in navigator)) return;
  // Не чаще раза в 60 мс: скольжение по кнопкам не должно жужжать очередью.
  const now = performance.now();
  if (now - lastBuzzAt < 60) return;
  lastBuzzAt = now;
  navigator.vibrate(12); // короче ~10 мс часть Android-моторов не отрабатывает
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
  const unsuppress = suppressNativeTouch(pad);

  // Элементы кнопок и их маски — для мгновенной подсветки нажатого.
  const buttonEls: Array<{ el: HTMLElement; mask: ButtonMask }> = [];
  for (const el of pad.querySelectorAll<HTMLElement>("[data-button]")) {
    let mask = 0;
    for (const name of (el.dataset.button ?? "").split(",")) {
      mask |= BIT_BY_NAME[name.trim()] ?? 0;
    }
    if (mask) buttonEls.push({ el, mask });
  }

  function highlight(mask: ButtonMask): void {
    for (const b of buttonEls) {
      b.el.classList.toggle("pressed", (mask & b.mask) === b.mask);
    }
  }

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
      if (mask & ~last) buzz(); // отклик только на нажатие, не на отпускание
      last = mask;
      onState(mask);
      highlight(mask);
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
    unsuppress();
    highlight(0);
    if (last !== 0) onState(0);
  };
}

/**
 * Маска направления по углу вектора от точки касания (градусы, 0 — вправо,
 * по часовой: ось Y экрана растёт вниз). Кардинальные сектора шире
 * диагональных (60° против 30°): случайный наклон пальца при движении
 * «вправо» не должен давать «вправо-вниз» — в половине игр это присед.
 */
function maskFromDegrees(deg: number): ButtonMask {
  if (deg < 30 || deg >= 330) return MASKS.RIGHT;
  if (deg < 60) return MASKS.RIGHT | MASKS.DOWN;
  if (deg < 120) return MASKS.DOWN;
  if (deg < 150) return MASKS.DOWN | MASKS.LEFT;
  if (deg < 210) return MASKS.LEFT;
  if (deg < 240) return MASKS.LEFT | MASKS.UP;
  if (deg < 300) return MASKS.UP;
  return MASKS.UP | MASKS.RIGHT;
}

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

  const unsuppress = suppressNativeTouch(zone);
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
    const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    emit(maskFromDegrees(deg));
  }

  function release(): void {
    pointerId = null;
    base.hidden = true;
    nub.style.transform = "translate(0, 0)";
    emit(0);
  }

  function onPointerDown(e: PointerEvent): void {
    if (pointerId !== null) {
      e.preventDefault(); // стик занят другим пальцем — глушим compat-события
      return;
    }
    e.preventDefault();
    pointerId = e.pointerId;
    // Захват: pointermove продолжает приходить, даже когда палец или мышь
    // уехали за пределы зоны (у мыши implicit capture нет).
    try {
      zone.setPointerCapture(e.pointerId);
    } catch {
      // указатель мог уже исчезнуть — не критично
    }
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
    unsuppress();
    release();
  };
}

/** Клавиатура: стрелки/WASD, K и J (или X и Z), Enter, Shift. */
export function attachKeyboard(
  onState: (mask: ButtonMask) => void,
): () => void {
  let mask: ButtonMask = 0;

  // Ввод в поле — не игра: иначе WASD нельзя набрать в поле кода. Кнопка
  // или чекбокс в фокусе (после тапа по HUD) перехватывают только Enter
  // и Space — стрелки и буквы продолжают идти в игру.
  function isUiTarget(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t.closest('input[type="checkbox"], button, a')) {
      return e.code === "Enter" || e.code === "Space";
    }
    return !!t.closest("input, textarea, select");
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
    if (!name) return;
    // Отпускание обрабатываем всегда: keyup, прилетевший в поле чата после
    // нажатия в игре, иначе оставил бы кнопку зажатой навсегда.
    if (!isUiTarget(e)) e.preventDefault();
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
