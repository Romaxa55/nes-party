import "./style.css";
import {
  runBenchmark,
  judge,
  collectDeviceInfo,
  ms,
  FRAME_BUDGET_MS,
  type BenchReport,
} from "./bench";
import { startLive, type LiveSession } from "./live";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Нет элемента #${id}`);
  return el as T;
};

const screens = {
  pick: $("screen-pick"),
  run: $("screen-run"),
  result: $("screen-result"),
  live: $("screen-live"),
};

function show(name: keyof typeof screens): void {
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
  window.scrollTo(0, 0);
}

// --- хранение выбранного ROM ------------------------------------------------
// Кладём в localStorage, чтобы при повторном открытии страницы на телефоне
// не искать файл заново. Всё остаётся на устройстве.

const STORE_KEY = "nes-bench.rom";
const STORE_LIMIT = 1_500_000;

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

function saveRom(name: string, bytes: Uint8Array): void {
  if (bytes.length > STORE_LIMIT) return;
  try {
    const payload: StoredRom = { name, b64: toBase64(bytes) };
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch {
    // Переполнение или приватный режим — не критично, просто не сохраняем.
  }
}

function loadSavedRom(): { name: string; bytes: Uint8Array } | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredRom;
    return { name: parsed.name, bytes: fromBase64(parsed.b64) };
  } catch {
    return null;
  }
}

// --- приём файла ------------------------------------------------------------

const dropZone = $("drop");
const romInput = $<HTMLInputElement>("rom-input");
const pickError = $("pick-error");

function fail(message: string): void {
  pickError.textContent = message;
  pickError.hidden = false;
}

/** Проверяем заголовок iNES, чтобы не ловить невнятную ошибку внутри ядра. */
function isValidRom(bytes: Uint8Array): boolean {
  return (
    bytes.length > 16 &&
    bytes[0] === 0x4e &&
    bytes[1] === 0x45 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x1a
  );
}

async function acceptFile(file: File): Promise<void> {
  pickError.hidden = true;
  if (file.size > 4_000_000) {
    fail("Файл больше 4 МБ — это не похоже на образ NES.");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isValidRom(bytes)) {
    fail("Это не файл iNES: нет сигнатуры NES в начале. Нужен .nes.");
    return;
  }
  saveRom(file.name, bytes);
  void begin(bytes, file.name);
}

dropZone.addEventListener("click", () => romInput.click());
romInput.addEventListener("change", () => {
  const file = romInput.files?.[0];
  if (file) void acceptFile(file);
});

for (const type of ["dragenter", "dragover"]) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    dropZone.classList.remove("over");
  });
}
dropZone.addEventListener("drop", (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void acceptFile(file);
});

// --- прогон -----------------------------------------------------------------

let currentRom: Uint8Array | null = null;
let currentName = "";

const runStage = $("run-stage");
const runBar = $("run-bar");
const runDetail = $("run-detail");

async function begin(rom: Uint8Array, name: string): Promise<void> {
  currentRom = rom;
  currentName = name;
  show("run");

  const canvas = $<HTMLCanvasElement>("bench-canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    fail("Браузер не даёт 2D-контекст canvas.");
    show("pick");
    return;
  }

  // Кадр браузеру на перерисовку, иначе первый этап начнётся до показа экрана.
  await new Promise((r) => requestAnimationFrame(r));

  const report = await runBenchmark(rom, ctx, (u) => {
    runStage.textContent = `Этап ${u.stageIndex + 1} из ${u.stageCount}: ${u.stageLabel}`;
    const overall = (u.stageIndex + u.done / u.total) / u.stageCount;
    runBar.style.width = `${(overall * 100).toFixed(1)}%`;
    runDetail.textContent = `${u.done} из ${u.total} кадров`;
  });

  render(report);
  show("result");
}

// --- вывод результата -------------------------------------------------------

let lastReport: BenchReport | null = null;

/** Чередует обычный и выделенный текст: обычный, жирный, обычный, ... */
function line(...parts: string[]): Node[] {
  return parts.map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part);
    const b = document.createElement("b");
    b.textContent = part;
    return b;
  });
}

function render(report: BenchReport): void {
  lastReport = report;
  const verdict = judge(report);

  const box = $("verdict");
  box.className = `verdict ${verdict.grade}`;
  box.innerHTML = "";

  const h = document.createElement("h2");
  h.textContent = verdict.title;
  const p = document.createElement("p");
  p.textContent = verdict.body;
  const r = document.createElement("p");
  r.className = "rollback";
  r.textContent = verdict.rollbackNote;
  box.append(h, p, r);

  const tbody = $<HTMLTableSectionElement>("result-table").querySelector("tbody")!;
  tbody.innerHTML = "";
  for (const stage of report.stages) {
    const tr = document.createElement("tr");
    if (stage.id === "full") tr.className = "headline";

    const name = document.createElement("td");
    name.textContent = stage.label;
    const note = document.createElement("span");
    note.className = "note";
    note.textContent = stage.note;
    name.append(note);

    tr.append(name);
    for (const v of [stage.avg, stage.p95, stage.max]) {
      const td = document.createElement("td");
      td.textContent = ms(v);
      tr.append(td);
    }
    tbody.append(tr);
  }

  const full = report.stages.find((s) => s.id === "full")!;
  const used = (full.avg / FRAME_BUDGET_MS) * 100;
  const kb = (report.state.bytes / 1024).toFixed(0);

  // Собираем через DOM, а не innerHTML: сюда попадает имя файла,
  // которое выбрал пользователь.
  const extra = $("extra");
  extra.replaceChildren(
    ...line(
      `Бюджет кадра при 60 Гц — `,
      `${FRAME_BUDGET_MS.toFixed(2)} мс`,
      `. Полный цикл занимает `,
      `${used.toFixed(0)}%`,
      ` бюджета, свободно `,
      `${ms(FRAME_BUDGET_MS - full.avg)} мс`,
      ` на сеть и отрисовку.`,
    ),
    document.createElement("br"),
    ...line(
      `Снимок состояния: сохранение `,
      `${ms(report.state.saveMs)} мс`,
      `, восстановление `,
      `${ms(report.state.loadMs)} мс`,
      `, размер в JSON `,
      `${kb} КБ`,
      `.`,
    ),
    document.createElement("br"),
    ...line(
      `Все значения в миллисекундах, замер по ${full.frames} кадрам на игре `,
      currentName,
      `.`,
    ),
  );

  const deviceText = describeDevice();
  $("device-info").textContent = deviceText;
  $("device-info-2").textContent = deviceText;
}

function describeDevice(): string {
  const d = collectDeviceInfo();
  const parts = [
    `Экран ${d.screen} @${d.dpr}x`,
    d.cores ? `${d.cores} ядер` : null,
    d.memoryGb ? `${d.memoryGb} ГБ RAM` : null,
  ].filter(Boolean);
  return `${parts.join(" · ")}\n${d.ua}`;
}

$("device-info").textContent = describeDevice();

// --- текстовый отчёт для отправки -------------------------------------------

function reportAsText(report: BenchReport): string {
  const verdict = judge(report);
  const lines = [
    `NES Bench — ${currentName}`,
    describeDevice().replace("\n", " | "),
    "",
    `Вердикт: ${verdict.title}`,
    "",
    "Этап                          средн.    p95   худш.",
  ];
  for (const s of report.stages) {
    lines.push(
      `${s.label.padEnd(30)}${ms(s.avg).padStart(6)}${ms(s.p95).padStart(7)}${ms(s.max).padStart(8)}`,
    );
  }
  lines.push(
    "",
    `Снимок состояния: save ${ms(report.state.saveMs)} мс / load ${ms(report.state.loadMs)} мс / ${(report.state.bytes / 1024).toFixed(0)} КБ`,
    `Бюджет кадра ${FRAME_BUDGET_MS.toFixed(2)} мс`,
  );
  return lines.join("\n");
}

$("copy-result").addEventListener("click", async () => {
  if (!lastReport) return;
  const button = $<HTMLButtonElement>("copy-result");
  try {
    await navigator.clipboard.writeText(reportAsText(lastReport));
    button.textContent = "Скопировано";
  } catch {
    button.textContent = "Не вышло скопировать";
  }
  setTimeout(() => (button.textContent = "Скопировать результат"), 2000);
});

$("restart").addEventListener("click", () => {
  pickError.hidden = true;
  romInput.value = "";
  show("pick");
});

// --- живой режим ------------------------------------------------------------

let liveSession: LiveSession | null = null;

$("go-live").addEventListener("click", () => {
  if (!currentRom) return;
  show("live");
  const stats = $("live-stats");
  liveSession = startLive({
    rom: currentRom,
    canvas: $<HTMLCanvasElement>("live-canvas"),
    pad: $("pad"),
    onStats: (s) => {
      stats.textContent =
        `${s.fps.toFixed(1)} fps · кадр ${ms(s.frameMs)} мс` +
        ` · пик ${ms(s.worstMs)} мс` +
        (s.droppedSteps ? ` · пропущено ${s.droppedSteps}` : "");
    },
  });
});

$("live-back").addEventListener("click", () => {
  liveSession?.stop();
  liveSession = null;
  show("result");
});

// --- восстановление прошлого ROM --------------------------------------------

const saved = loadSavedRom();
if (saved) {
  const button = $<HTMLButtonElement>("use-saved");
  button.hidden = false;
  button.textContent = `Прогнать снова: ${saved.name}`;
  button.addEventListener("click", () => void begin(saved.bytes, saved.name));
}
