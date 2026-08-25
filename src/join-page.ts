import "./style.css";
import { $ } from "./dom";
import { ClientSession, normalizeCode } from "./net";
import { attachKeyboard, attachTouchpad, InputAggregator } from "./controls";

const screenJoin = $("screen-join");
const screenPlay = $("screen-play");
const codeInput = $<HTMLInputElement>("code-input");
const connectBtn = $<HTMLButtonElement>("connect");
const joinError = $("join-error");
const joinStatus = $("join-status");
const playStatus = $("play-status");
const soundBtn = $<HTMLButtonElement>("sound-btn");
const video = $<HTMLVideoElement>("stream-video");

// Код из ссылки вида join.html?c=ABCDE — сразу в поле.
const fromLink = new URLSearchParams(location.search).get("c");
if (fromLink) codeInput.value = normalizeCode(fromLink);

connectBtn.addEventListener("click", () => void connect());
codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void connect();
});

async function connect(): Promise<void> {
  const code = normalizeCode(codeInput.value);
  if (code.length < 4) {
    showError("Код слишком короткий — в нём 5 символов.");
    return;
  }

  joinError.hidden = true;
  joinStatus.hidden = false;
  joinStatus.textContent = "Подключаюсь…";
  connectBtn.disabled = true;

  let session: ClientSession;
  try {
    session = await ClientSession.connect(code);
  } catch (err) {
    showError((err as Error).message);
    joinStatus.hidden = true;
    connectBtn.disabled = false;
    return;
  }

  screenJoin.hidden = true;
  screenPlay.hidden = false;
  window.scrollTo(0, 0);

  const slot = session.slot ?? 0;
  playStatus.textContent =
    slot === 0 ? "Ты зритель — оба места заняты" : `Ты — Игрок ${slot}`;
  if (slot === 0) $("pad").hidden = true;

  video.srcObject = null; // стрим придёт следом отдельным событием
  session.onStream = (stream) => {
    video.srcObject = stream;
    // Видео стартует беззвучным (autoplay muted разрешён всегда);
    // звук включается кнопкой — это жест, который браузер требует.
    void video.play().catch(() => {});
  };

  soundBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    soundBtn.textContent = video.muted ? "Включить звук" : "Выключить звук";
    if (!video.muted) void video.play().catch(() => {});
  });

  const inputs = new InputAggregator((mask) => session.sendInput(mask));
  attachTouchpad($("pad"), (m) => inputs.set("touch", m));
  attachKeyboard((m) => inputs.set("kb", m));

  session.onClose = () => {
    screenPlay.hidden = true;
    screenJoin.hidden = false;
    connectBtn.disabled = false;
    joinStatus.hidden = true;
    showError("Связь с хостом потеряна. Попробуй подключиться снова.");
  };

  // Телефон-геймпад не должен гаснуть посреди игры.
  navigator.wakeLock?.request("screen").catch(() => {});
  window.addEventListener("beforeunload", () => session.destroy());
}

function showError(message: string): void {
  joinError.textContent = message;
  joinError.hidden = false;
}
