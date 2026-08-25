import "./style.css";
import { $ } from "./dom";
import { setupRomPicker, isValidRom, FILE_LIMIT } from "./rom-store";
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
// Играет ли хост сам за P1. Выключается чекбоксом — режим «этот экран
// телевизор, все игроки на телефонах».
let hostPlays = true;
let lastPeers: PeerInfo[] = [];

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

  // Локальный ввод (тачскрин + клавиатура через OR) идёт в P1, только пока
  // хост играет сам.
  const inputs = new InputAggregator((mask) => {
    if (hostPlays) engine?.setButtons(1, mask);
  });
  attachTouchpad($("pad"), (m) => inputs.set("touch", m));
  attachKeyboard((m) => inputs.set("kb", m));

  // Чекбокс вешаем до создания комнаты: снять его можно и пока PeerJS
  // регистрируется — применится, как только сессия появится.
  let sessionRef: HostSession | null = null;
  const hostPlaysBox = $<HTMLInputElement>("host-plays");
  hostPlaysBox.addEventListener("change", () => {
    hostPlays = hostPlaysBox.checked;
    if (!hostPlays) engine?.setButtons(1, 0); // отпустить свои кнопки
    sessionRef?.setHostPlays(hostPlays);
    renderPeers(lastPeers);
  });

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
  sessionRef = session;
  session.setHostPlays(hostPlays); // если чекбокс сняли до регистрации

  session.onInput = (slot, mask) => engine?.setButtons(slot, mask);
  session.onPeersChange = (list) => {
    lastPeers = list;
    renderPeers(list);
  };
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

// ROM по ссылке: host.html?rom=<адрес> — файл тянется браузером хоста,
// в репозитории и на нашем хостинге его нет. Разрешены пути своего origin
// (локальный public/roms/) и абсолютные https-адреса с CORS. В localStorage
// такой ROM намеренно не сохраняется: он и так доступен по той же ссылке.
const romUrl = new URLSearchParams(location.search).get("rom");
if (romUrl) void beginFromUrl(romUrl);

async function beginFromUrl(raw: string): Promise<void> {
  const pickStatus = $("pick-status");
  pickStatus.textContent = "Загружаю ROM по ссылке…";
  pickStatus.hidden = false;

  let bytes: Uint8Array;
  try {
    const url = new URL(raw, location.href);
    // Отсекает data:, blob: и чужие http: — источники, которых в честной
    // ссылке быть не может.
    if (url.protocol !== "https:" && url.origin !== location.origin) {
      throw new Error("разрешены https-адреса или файлы этого сайта");
    }
    const res = await fetch(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > FILE_LIMIT) throw new Error("файл больше 4 МБ");
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > FILE_LIMIT) throw new Error("файл больше 4 МБ");
    if (!isValidRom(bytes)) throw new Error("по ссылке не iNES-файл");
  } catch (err) {
    pickStatus.hidden = true;
    // Пока ссылка грузилась, пользователь мог запустить игру файлом —
    // тогда не мусорим ошибкой поверх идущей игры.
    if (started) return;
    pickError.textContent =
      `ROM по ссылке не загрузился (${(err as Error).message}). ` +
      `Проверь адрес, HTTPS и CORS на сервере файла.`;
    pickError.hidden = false;
    return;
  }
  pickStatus.hidden = true;
  void begin(bytes);
}

function renderPeers(list: PeerInfo[]): void {
  const p1 = list.some((p) => p.slot === 1);
  const p2 = list.some((p) => p.slot === 2);
  const watchers = list.filter((p) => p.slot === 0).length;
  const p1Text = hostPlays ? "P1: ты" : p1 ? "P1: телефон" : "P1: ждём";
  const p2Text = p2 ? "P2: подключён" : "P2: ждём";
  const parts = [
    p1Text,
    p2Text,
    watchers ? `зрителей: ${watchers}` : null,
  ].filter(Boolean);
  players.textContent = parts.join(" · ");
}
