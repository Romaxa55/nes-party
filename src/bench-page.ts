import "./style.css";
import { $ } from "./dom";
import { setupRomPicker } from "./rom-store";
import {
  runBenchmark,
  judge,
  collectDeviceInfo,
  ms,
  FRAME_BUDGET_MS,
  type BenchReport,
} from "./bench";
import { startLive, type LiveSession } from "./live";

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

// --- приём файла ------------------------------------------------------------

const pickError = $("pick-error");

setupRomPicker({
  dropZone: $("drop"),
  input: $<HTMLInputElement>("rom-input"),
  savedButton: $<HTMLButtonElement>("use-saved"),
  onError: (message) => {
    pickError.textContent = message;
    pickError.hidden = false;
  },
  onRom: (bytes, name) => {
    pickError.hidden = true;
    void begin(bytes, name);
  },
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
    pickError.textContent = "The browser did not provide a 2D canvas context.";
    pickError.hidden = false;
    show("pick");
    return;
  }

  // Кадр браузеру на перерисовку, иначе первый этап начнётся до показа экрана.
  await new Promise((r) => requestAnimationFrame(r));

  const report = await runBenchmark(rom, ctx, (u) => {
    runStage.textContent = `Stage ${u.stageIndex + 1} of ${u.stageCount}: ${u.stageLabel}`;
    const overall = (u.stageIndex + u.done / u.total) / u.stageCount;
    runBar.style.width = `${(overall * 100).toFixed(1)}%`;
    runDetail.textContent = `${u.done} of ${u.total} frames`;
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
      `Frame budget at 60 Hz is `,
      `${FRAME_BUDGET_MS.toFixed(2)} ms`,
      `. The full cycle uses `,
      `${used.toFixed(0)}%`,
      ` of it, leaving `,
      `${ms(FRAME_BUDGET_MS - full.avg)} ms`,
      ` for networking and rendering.`,
    ),
    document.createElement("br"),
    ...line(
      `State snapshot: save `,
      `${ms(report.state.saveMs)} ms`,
      `, load `,
      `${ms(report.state.loadMs)} ms`,
      `, JSON size `,
      `${kb} KB`,
      `.`,
    ),
    document.createElement("br"),
    ...line(
      `All values in milliseconds, measured over ${full.frames} frames of `,
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
    `Screen ${d.screen} @${d.dpr}x`,
    d.cores ? `${d.cores} cores` : null,
    d.memoryGb ? `${d.memoryGb} GB RAM` : null,
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
    `Verdict: ${verdict.title}`,
    "",
    "Stage                            avg    p95   worst",
  ];
  for (const s of report.stages) {
    lines.push(
      `${s.label.padEnd(30)}${ms(s.avg).padStart(6)}${ms(s.p95).padStart(7)}${ms(s.max).padStart(8)}`,
    );
  }
  lines.push(
    "",
    `State snapshot: save ${ms(report.state.saveMs)} ms / load ${ms(report.state.loadMs)} ms / ${(report.state.bytes / 1024).toFixed(0)} KB`,
    `Frame budget ${FRAME_BUDGET_MS.toFixed(2)} ms`,
  );
  return lines.join("\n");
}

$("copy-result").addEventListener("click", async () => {
  if (!lastReport) return;
  const button = $<HTMLButtonElement>("copy-result");
  try {
    await navigator.clipboard.writeText(reportAsText(lastReport));
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => (button.textContent = "Copy result"), 2000);
});

$("restart").addEventListener("click", () => {
  pickError.hidden = true;
  $<HTMLInputElement>("rom-input").value = "";
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
        `${s.fps.toFixed(1)} fps · frame ${ms(s.frameMs)} ms` +
        ` · peak ${ms(s.worstMs)} ms` +
        (s.droppedSteps ? ` · dropped ${s.droppedSteps}` : "");
    },
  });
});

$("live-back").addEventListener("click", () => {
  liveSession?.stop();
  liveSession = null;
  show("result");
});
