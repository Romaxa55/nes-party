import "./style.css";
import { $ } from "./dom";
import { ClientSession, normalizeCode, CODE_LENGTH } from "./net";
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

let connecting = false;
let detachInputs: Array<() => void> = [];

// Код из ссылки вида join.html?c=ABCDE — сразу в поле.
const fromLink = new URLSearchParams(location.search).get("c");
if (fromLink) codeInput.value = normalizeCode(fromLink);

connectBtn.addEventListener("click", () => void connect());
codeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void connect();
});

// Кнопка звука живёт на модульном уровне: вешать обработчик внутри connect()
// нельзя — после реконнекта копии тогглили бы muted туда-обратно.
soundBtn.addEventListener("click", () => {
  video.muted = !video.muted;
  soundBtn.textContent = video.muted ? "Enable sound" : "Mute";
  if (!video.muted) void video.play().catch(() => {});
});

async function connect(): Promise<void> {
  if (connecting) return;
  const code = normalizeCode(codeInput.value);
  if (code.length !== CODE_LENGTH) {
    showError(`The room code is ${CODE_LENGTH} characters long.`);
    return;
  }

  connecting = true;
  joinError.hidden = true;
  joinStatus.hidden = false;
  joinStatus.textContent = "Connecting…";
  connectBtn.disabled = true;

  let session: ClientSession;
  try {
    session = await ClientSession.connect(code);
  } catch (err) {
    showError((err as Error).message);
    joinStatus.hidden = true;
    connectBtn.disabled = false;
    connecting = false;
    return;
  }
  connecting = false;

  screenJoin.hidden = true;
  screenPlay.hidden = false;
  window.scrollTo(0, 0);

  applySlot(session.slot ?? 0);
  session.onSlotChange = applySlot; // хост может пересадить на лету

  // Стрим мог прийти раньше подписки — сеттер в ClientSession отдаст его сразу.
  session.onStream = (stream) => {
    video.srcObject = stream;
    // Видео стартует беззвучным (autoplay muted разрешён всегда);
    // звук включается кнопкой — это жест, который браузер требует.
    void video.play().catch(() => {});
  };

  const inputs = new InputAggregator((mask) => session.sendInput(mask));
  detachInputs = [
    attachTouchpad($("pad"), (m) => inputs.set("touch", m)),
    attachKeyboard((m) => inputs.set("kb", m)),
  ];

  session.onClose = () => {
    // Снять игровые обработчики обязательно: глобальный keydown иначе
    // перехватывал бы буквы кода комнаты (WASD/KJXZ входят в его алфавит).
    for (const detach of detachInputs) detach();
    detachInputs = [];
    session.destroy();
    video.srcObject = null;
    screenPlay.hidden = true;
    screenJoin.hidden = false;
    connectBtn.disabled = false;
    joinStatus.hidden = true;
    showError("Connection to the host was lost. Try connecting again.");
  };

  // Телефон-геймпад не должен гаснуть посреди игры.
  navigator.wakeLock?.request("screen").catch(() => {});
  // pagehide надёжнее beforeunload на мобильных браузерах.
  window.addEventListener("pagehide", () => session.destroy());
}

function showError(message: string): void {
  joinError.textContent = message;
  joinError.hidden = false;
}

function applySlot(slot: number): void {
  playStatus.textContent =
    slot === 0 ? "You are a spectator — no free seats" : `You are Player ${slot}`;
  $("pad").hidden = slot === 0;
}
