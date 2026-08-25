/**
 * Выбор и хранение ROM-образа. Файл читается на устройстве и никуда
 * не отправляется; в localStorage кладётся, чтобы при повторном открытии
 * страницы не искать его заново.
 */

const STORE_KEY = "nes-bench.rom";
const STORE_LIMIT = 1_500_000;
const FILE_LIMIT = 4_000_000;

interface StoredRom {
  name: string;
  b64: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function saveRom(name: string, bytes: Uint8Array): void {
  if (bytes.length > STORE_LIMIT) return;
  try {
    const payload: StoredRom = { name, b64: toBase64(bytes) };
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    // Переполнение или приватный режим — не критично, просто не сохраняем.
  }
}

export function loadSavedRom(): { name: string; bytes: Uint8Array } | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRom;
    return { name: parsed.name, bytes: fromBase64(parsed.b64) };
  } catch {
    return null;
  }
}

/** Проверка заголовка iNES, чтобы не ловить невнятную ошибку внутри ядра. */
export function isValidRom(bytes: Uint8Array): boolean {
  return (
    bytes.length > 16 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a
  );
}

export interface RomPickerOptions {
  /** Зона drag&drop, по клику открывает выбор файла. */
  dropZone: HTMLElement;
  input: HTMLInputElement;
  /** Кнопка «использовать прошлый ROM»; скрыта, если сохранённого нет. */
  savedButton?: HTMLButtonElement;
  onError: (message: string) => void;
  onRom: (bytes: Uint8Array, name: string) => void;
}

/** Вешает на элементы страницы весь цикл выбора ROM: клик, drop, повтор. */
export function setupRomPicker(opts: RomPickerOptions): void {
  async function acceptFile(file: File): Promise<void> {
    if (file.size > FILE_LIMIT) {
      opts.onError("Файл больше 4 МБ — это не похоже на образ NES.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isValidRom(bytes)) {
      opts.onError("Это не файл iNES: нет сигнатуры NES в начале. Нужен .nes.");
      return;
    }
    saveRom(file.name, bytes);
    opts.onRom(bytes, file.name);
  }

  opts.dropZone.addEventListener("click", () => opts.input.click());
  opts.input.addEventListener("change", () => {
    const file = opts.input.files?.[0];
    if (file) void acceptFile(file);
  });

  for (const type of ["dragenter", "dragover"]) {
    opts.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      opts.dropZone.classList.add("over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    opts.dropZone.addEventListener(type, (e) => {
      e.preventDefault();
      opts.dropZone.classList.remove("over");
    });
  }
  opts.dropZone.addEventListener("drop", (e) => {
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void acceptFile(file);
  });

  const saved = loadSavedRom();
  if (saved && opts.savedButton) {
    const button = opts.savedButton;
    button.hidden = false;
    button.textContent = `Взять прошлый: ${saved.name}`;
    button.addEventListener("click", () => opts.onRom(saved.bytes, saved.name));
  }
}
