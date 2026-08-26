import "./style.css";
import { $, setupFullscreenButton } from "./dom";
import { ClientSession, normalizeCode, CODE_LENGTH } from "./net";
import {
  attachKeyboard,
  attachTouchpad,
  attachStick,
  InputAggregator,
} from "./controls";
import { setupChatPanel, type ChatPanel } from "./chat-ui";
import { VoiceClient } from "./voice";

const screenJoin = $("screen-join");
const screenPlay = $("screen-play");
const codeInput = $<HTMLInputElement>("code-input");
const connectBtn = $<HTMLButtonElement>("connect");
const joinError = $("join-error");
const joinStatus = $("join-status");
const playStatus = $("play-status");
const pingEl = $("ping");
const rosterEl = $("roster");
const soundBtn = $<HTMLButtonElement>("sound-btn");
const micBtn = $<HTMLButtonElement>("mic-btn");
const video = $<HTMLVideoElement>("stream-video");

let connecting = false;
let detachInputs: Array<() => void> = [];
let sessionRef: ClientSession | null = null;

// Один обработчик на страницу: подписка внутри connect() копилась бы
// с каждым реконнектом. pagehide надёжнее beforeunload на мобильных.
window.addEventListener("pagehide", () => {
  voice?.disable();
  sessionRef?.destroy();
});
// Чат-панель одна на страницу; отправитель переключается на живую сессию.
let chat: ChatPanel | null = null;
let chatSend: (text: string) => void = () => {};
let voice: VoiceClient | null = null;

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
  soundBtn.textContent = video.muted ? "Sound: off" : "Sound: on";
  if (!video.muted) void video.play().catch(() => {});
});

setupFullscreenButton($("fs-btn"));

micBtn.addEventListener("click", async () => {
  if (!voice) return; // ещё не подключены
  micBtn.disabled = true;
  try {
    if (voice.active) voice.disable();
    else await voice.enable();
    micBtn.textContent = voice.active ? "Mic: on" : "Mic: off";
  } catch {
    micBtn.textContent = "Mic blocked";
  } finally {
    micBtn.disabled = false;
  }
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

  if (!chat) chat = setupChatPanel((text) => chatSend(text));
  chatSend = (text) => session.sendChat(text);
  session.onChat = (from, text) => chat?.addMessage(from, text);
  session.onSys = (text) => chat?.addSystem(text);
  session.onRtt = (ms) => {
    pingEl.textContent = `${ms} ms`;
  };
  session.onRoster = (l) => {
    const parts: string[] = [];
    for (let s = 1; s <= 4; s++) {
      if (l.some((e) => e.s === s)) parts.push(`P${s}`);
    }
    const specs = l.filter((e) => e.s === 0).length;
    if (specs) parts.push(`${specs} watching`);
    rosterEl.textContent = parts.length ? `In room: ${parts.join(", ")}` : "";
  };
  sessionRef = session;
  voice = new VoiceClient((mic) => session.callVoice(mic));
  voice.onEnded = () => {
    micBtn.textContent = "Mic: off"; // звонок отвалился сам — кнопка не врёт
  };
  micBtn.textContent = "Mic: off";

  // Стрим мог прийти раньше подписки — сеттер в ClientSession отдаст его сразу.
  session.onStream = (stream) => {
    video.srcObject = stream;
    // Видео стартует беззвучным (autoplay muted разрешён всегда);
    // звук включается кнопкой — это жест, который браузер требует.
    void video.play().catch(() => {});
  };

  const inputs = new InputAggregator((mask) => session.sendInput(mask));
  const attachAll = (): void => {
    if (detachInputs.length) return;
    detachInputs = [
      attachTouchpad($("btn-zone"), (m) => inputs.set("touch", m)),
      attachStick($("stick-zone"), $("stick-base"), $("stick-nub"), (m) =>
        inputs.set("stick", m),
      ),
      attachKeyboard((m) => inputs.set("kb", m)),
    ];
  };
  const detachAll = (): void => {
    for (const detach of detachInputs) detach();
    detachInputs = [];
  };

  // Зрителю ввод не положен. Пересадка слотов на лету снимает и вешает
  // обработчики целиком — заодно это отпускает зажатый стик, если хост
  // пересадил игрока прямо во время касания.
  const onSlot = (slot: number): void => {
    applySlot(slot);
    if (slot === 0) detachAll();
    else attachAll();
  };
  onSlot(session.slot ?? 0);
  session.onSlotChange = onSlot;

  session.onClose = () => {
    voice?.disable();
    voice = null;
    micBtn.textContent = "Mic: off";
    // Снять игровые обработчики обязательно: глобальный keydown иначе
    // перехватывал бы буквы кода комнаты (WASD/KJXZ входят в его алфавит).
    detachAll();
    session.destroy();
    video.srcObject = null;
    pingEl.textContent = "–";
    screenPlay.hidden = true;
    screenJoin.hidden = false;
    connectBtn.disabled = false;
    joinStatus.hidden = true;
    showError("Connection to the host was lost. Try connecting again.");
  };

  // Телефон-геймпад не должен гаснуть посреди игры.
  navigator.wakeLock?.request("screen").catch(() => {});
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
