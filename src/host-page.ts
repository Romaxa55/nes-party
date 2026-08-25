import "./style.css";
import { $ } from "./dom";
import { setupRomPicker, isValidRom } from "./rom-store";
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
let started = false;

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
  if (started) return;
  started = true;
  pickError.hidden = true;
  screenPick.hidden = true;
  screenGame.hidden = false;
  window.scrollTo(0, 0);

  // AudioContext создаётся в цепочке жеста пользователя — иначе браузер
  // не даст звук. Если не вышло — играем без него.
  let audio: AudioPipe | null = null;
  try {
    audio = await AudioPipe.create();
  } catch {
    audio = null;
  }

  const canvas = $<HTMLCanvasElement>("game-canvas");
  try {
    engine = startEngine({
      rom,
      canvas,
      audio,
      onStats: (s) => {
        hostStats.textContent =
          `${s.fps.toFixed(0)} fps · кадр ${ms(s.frameMs)} мс` +
          (s.droppedSteps ? ` · пропущено ${s.droppedSteps}` : "");
      },
      onError: (err) => {
        netStatus.textContent = `Эмулятор упал: ${err.message}. Обнови страницу.`;
        void audio?.close().catch(() => {});
      },
    });
  } catch (err) {
    // Валидный iNES, но маппер не поддержан ядром — честно возвращаем выбор.
    void audio?.close().catch(() => {});
    started = false;
    screenGame.hidden = true;
    screenPick.hidden = false;
    pickError.textContent = `Ядро не запустило игру: ${(err as Error).message}`;
    pickError.hidden = false;
    return;
  }

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
  session.onError = (err) => {
    netStatus.textContent = `Сеть: ${err.message}`;
  };

  // Трансляция: картинка с canvas + звуковая дорожка из AudioPipe.
  let streamOk = true;
  try {
    const stream = canvas.captureStream(60);
    if (audio) {
      for (const track of audio.stream.getAudioTracks()) stream.addTrack(track);
    }
    session.setStream(stream);
  } catch {
    streamOk = false;
  }

  roomCode.textContent = session.code;
  const link = new URL(`join.html?c=${session.code}`, location.href).toString();
  if (!streamOk) {
    netStatus.textContent =
      "Комната открыта, но браузер не отдаёт видео с canvas — " +
      "клиенты подключатся без картинки. Попробуй другой браузер.";
  } else {
    netStatus.textContent = audio
      ? "Комната открыта. Отправь другу код или ссылку."
      : "Комната открыта (звук не завёлся — играем без него).";
  }

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

  // pagehide надёжнее beforeunload на мобильных браузерах.
  window.addEventListener("pagehide", () => session.destroy());
}

// ROM по ссылке: host.html?rom=https://... — файл тянется браузером хоста
// с указанного адреса, в репозитории и на нашем хостинге его нет. Серверу
// файла нужны HTTPS и CORS-заголовок Access-Control-Allow-Origin.
const romUrl = new URLSearchParams(location.search).get("rom");
if (romUrl) {
  void (async () => {
    try {
      const res = await fetch(romUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!isValidRom(bytes)) throw new Error("по ссылке не iNES-файл");
      void begin(bytes);
    } catch (err) {
      pickError.textContent =
        `ROM по ссылке не загрузился (${(err as Error).message}). ` +
        `Проверь адрес, HTTPS и CORS на сервере файла.`;
      pickError.hidden = false;
    }
  })();
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
