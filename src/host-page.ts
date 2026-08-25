import "./style.css";
import { $ } from "./dom";
import { setupRomPicker } from "./rom-store";
import { startEngine, type Engine } from "./engine";
import { AudioPipe } from "./audio";
import { HostSession, type PeerInfo } from "./net";
import { attachKeyboard, attachTouchpad, InputAggregator } from "./controls";
import { ms } from "./bench";

const screenPick = $("screen-pick");
const screenGame = $("screen-game");
const pickError = $("pick-error");
const netStatus = $("net-status");
const roomCode = $("room-code");
const copyLink = $<HTMLButtonElement>("copy-link");
const players = $("players");
const hostStats = $("host-stats");

let engine: Engine | null = null;

setupRomPicker({
  dropZone: $("drop"),
  input: $<HTMLInputElement>("rom-input"),
  savedButton: $<HTMLButtonElement>("use-saved"),
  onError: (message) => {
    pickError.textContent = message;
    pickError.hidden = false;
  },
  onRom: (bytes) => void begin(bytes),
});

async function begin(rom: Uint8Array): Promise<void> {
  screenPick.hidden = true;
  screenGame.hidden = false;
  window.scrollTo(0, 0);

  // AudioContext создаётся здесь, в цепочке жеста пользователя (клик по
  // выбору файла) — иначе браузер не даст звук. Если не вышло — играем без.
  let audio: AudioPipe | null = null;
  try {
    audio = await AudioPipe.create();
  } catch {
    audio = null;
  }

  const canvas = $<HTMLCanvasElement>("game-canvas");
  engine = startEngine({
    rom,
    canvas,
    audio,
    onStats: (s) => {
      hostStats.textContent =
        `${s.fps.toFixed(0)} fps · кадр ${ms(s.frameMs)} мс` +
        (s.droppedSteps ? ` · пропущено ${s.droppedSteps}` : "");
    },
  });

  // Хост играет за первого: тачскрин и клавиатура складываются через OR.
  const inputs = new InputAggregator((mask) => engine?.setButtons(1, mask));
  attachTouchpad($("pad"), (m) => inputs.set("touch", m));
  attachKeyboard((m) => inputs.set("kb", m));

  // Комната создаётся параллельно с игрой: хост уже играет, пока PeerJS
  // регистрируется. Если сеть недоступна — остаётся локальная игра.
  netStatus.textContent = "Создаю комнату…";
  let session: HostSession;
  try {
    session = await HostSession.create();
  } catch (err) {
    netStatus.textContent =
      `Комнату создать не вышло (${(err as Error).message}). ` +
      `Игра работает локально; проверь интернет и обнови страницу.`;
    return;
  }

  session.onInput = (slot, mask) => engine?.setButtons(slot, mask);
  session.onPeersChange = renderPeers;

  // Трансляция: картинка с canvas + звуковая дорожка из AudioPipe.
  const stream = canvas.captureStream(60);
  if (audio) {
    for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
  }
  session.setStream(stream);

  roomCode.textContent = session.code;
  const link = new URL(`join.html?c=${session.code}`, location.href).toString();
  netStatus.textContent = audio
    ? "Комната открыта. Отправь другу код или ссылку."
    : "Комната открыта (звук не завёлся — играем без него).";

  copyLink.hidden = false;
  copyLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      copyLink.textContent = "Скопировано";
    } catch {
      copyLink.textContent = link; // хотя бы показать
    }
    setTimeout(() => (copyLink.textContent = "Скопировать ссылку"), 2500);
  });

  window.addEventListener("beforeunload", () => session.destroy());
}

function renderPeers(list: PeerInfo[]): void {
  const player2 = list.some((p) => p.slot === 2);
  const watchers = list.filter((p) => p.slot === 0).length;
  const parts = [
    player2 ? "Игрок 2 подключён" : "Ждём второго игрока…",
    watchers ? `зрителей: ${watchers}` : null,
  ].filter(Boolean);
  players.textContent = parts.join(" · ");
}
