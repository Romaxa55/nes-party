import "./style.css";
import { $, setupFullscreenButton } from "./dom";
import { setupRomPicker, isValidRom, FILE_LIMIT } from "./rom-store";
import { startEngine, type Engine } from "./engine";
import { AudioPipe } from "./audio";
import { HostSession, type PeerInfo } from "./net";
import {
  attachKeyboard,
  attachTouchpad,
  attachStick,
  InputAggregator,
} from "./controls";
import { ms } from "./bench";
import { setupChatPanel } from "./chat-ui";
import { VoiceHub } from "./voice";
import { startBot, type Bot } from "./bot";
import { loadNeuroBot } from "./neurobot";
import { renderSVG } from "uqr";

const screenPick = $("screen-pick");
const screenGame = $("screen-game");
const pickError = $("pick-error");
const netStatus = $("net-status");
const roomCode = $("room-code");
const copyLink = $<HTMLButtonElement>("copy-link");
const players = $("players");
const hostStats = $("host-stats");

declare const __BUILD_ID__: string;
// Версия сборки в HUD: сразу видно, не подсунул ли кеш старый код.
hostStats.title = `build ${__BUILD_ID__}`;
hostStats.textContent = `v:${__BUILD_ID__}`;

let engine: Engine | null = null;
let started = false;
// Играет ли хост сам за P1. Выключается чекбоксом — режим «этот экран
// телевизор, все игроки на телефонах».
let hostPlays = true;
/** Сколько контроллеров раздаёт комната; 4 — для 4P-ромхаков. */
let sessionMaxPlayers = 2;
let lastPeers: PeerInfo[] = [];

setupFullscreenButton($("fs-btn"));

// Чат и микрофон живут на модульном уровне: кнопки одни, сессия появляется позже.
let chatSend: (text: string) => void = () => {};
const chat = setupChatPanel((text) => chatSend(text));

let voiceHub: VoiceHub | null = null;
let voiceCtx: AudioContext | null = null;
let micOn = false;
const micBtn = $<HTMLButtonElement>("mic-btn");
micBtn.addEventListener("click", async () => {
  if (!voiceHub) return; // комната ещё не создана
  void voiceCtx?.resume().catch(() => {});
  micBtn.disabled = true;
  try {
    micOn = await voiceHub.setMic(!micOn);
    micBtn.textContent = micOn ? "Mic: on" : "Mic: off";
  } catch {
    micBtn.textContent = "Mic blocked";
  } finally {
    micBtn.disabled = false;
  }
});

// Бот занимает P2, пока слот свободен; живой игрок всегда важнее.
let bot: Bot | null = null;
let botWanted = false;
let p2Taken = false;
const botBtn = $<HTMLButtonElement>("bot-btn");
function syncBot(): void {
  if (!bot) return;
  if (botWanted && !p2Taken) bot.resume();
  else bot.pause();
  botBtn.textContent = botWanted
    ? p2Taken
      ? "Bot: waiting" // живой игрок на P2 — бот уступил
      : "Bot: on"
    : "Bot: off";
}
botBtn.addEventListener("click", () => {
  botWanted = !botWanted;
  syncBot();
});

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

// Ручные Game Genie коды из ссылки: host.html?gg=SLAIUZ,GXXZZLVI
const query = new URLSearchParams(location.search);
const queryGg = (query.get("gg") ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
// Постоянный облачный сервер: ?room=TANKS — фиксированный код комнаты,
// ?tv=1 — хост не играет, оба контроллера уходят клиентам.
const preferredRoom = query.get("room") ?? undefined;
const tvMode = query.get("tv") === "1";
// ?botdebug=1 — показывать в HUD режим решения бота (полевые отчёты).
const botDebug = query.get("botdebug") === "1";
// ?neurobot=1 — за P2 играет нейросеть вместо скриптового бота.
const neuroBot = query.get("neurobot") === "1";
if (tvMode) hostPlays = false;

async function begin(
  rom: Uint8Array,
  ggCodes?: string[],
  ramPatches?: Array<{ a: number; v: number }>,
  players4?: boolean,
): Promise<void> {
  if (started) return;
  started = true;
  // ?gg= — ручное переопределение, оно сильнее кодов из манифеста.
  const gg = queryGg.length ? queryGg : ggCodes;
  const p4 = players4 || query.get("p4") === "1";
  sessionMaxPlayers = p4 ? 4 : 2;
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
      ggCodes: gg,
      ramPatches,
      players4: p4,
      onStats: (s) => {
        hostStats.textContent =
          `${s.fps.toFixed(0)} fps · frame ${ms(s.frameMs)} ms` +
          (s.droppedSteps ? ` · dropped ${s.droppedSteps}` : "") +
          (botDebug && bot && !bot.paused ? ` · bot:${bot.mode}` : "");
      },
      onError: (err) => {
        netStatus.textContent = `The emulator crashed: ${err.message}. Reload the page.`;
        void audio?.close().catch(() => {});
      },
    });
  } catch (err) {
    // Валидный iNES, но маппер не поддержан ядром — честно возвращаем выбор.
    void audio?.close().catch(() => {});
    started = false;
    screenGame.hidden = true;
    screenPick.hidden = false;
    pickError.textContent = `The core failed to start the game: ${(err as Error).message}`;
    pickError.hidden = false;
    return;
  }

  // Локальный ввод (тачскрин + клавиатура через OR) идёт в P1, только пока
  // хост играет сам.
  const inputs = new InputAggregator((mask) => {
    if (hostPlays) engine?.setButtons(1, mask);
  });
  attachTouchpad($("btn-zone"), (m) => inputs.set("touch", m));
  attachStick($("stick-zone"), $("stick-base"), $("stick-nub"), (m) =>
    inputs.set("stick", m),
  );
  attachKeyboard((m) => inputs.set("kb", m));

  // Чекбокс вешаем до создания комнаты: снять его можно и пока PeerJS
  // регистрируется — применится, как только сессия появится.
  let sessionRef: HostSession | null = null;
  const hostPlaysBox = $<HTMLInputElement>("host-plays");
  hostPlaysBox.checked = hostPlays; // tv-режим снимает галку ещё до комнаты
  hostPlaysBox.addEventListener("change", () => {
    hostPlays = hostPlaysBox.checked;
    if (!hostPlays) engine?.setButtons(1, 0); // отпустить свои кнопки
    sessionRef?.setHostPlays(hostPlays);
    renderPeers(lastPeers);
  });

  // Комната создаётся параллельно с игрой: хост уже играет, пока PeerJS
  // регистрируется. Если сеть недоступна — остаётся локальная игра.
  netStatus.textContent = "Creating room…";
  let session: HostSession;
  try {
    session = await HostSession.create(preferredRoom, p4 ? 4 : 2);
  } catch (err) {
    netStatus.textContent =
      `Could not create a room (${(err as Error).message}). ` +
      `The game still works locally; check the connection and reload.`;
    return;
  }
  sessionRef = session;
  session.setHostPlays(hostPlays); // если чекбокс сняли до регистрации
  renderPeers(lastPeers); // HUD сразу показывает все места, включая P3/P4

  chatSend = (text) => session.sendChat(text);
  session.onChat = (from, text) => chat.addMessage(from, text);
  session.onSys = (text) => chat.addSystem(text);

  // Голосовой микшер — на том же AudioContext, что и звук игры.
  voiceCtx = audio?.context ?? new AudioContext();
  const hub = new VoiceHub(voiceCtx);
  voiceHub = hub;
  session.onVoiceCall = (call) => hub.accept(call);
  micBtn.disabled = false; // хаб готов — кнопка оживает

  if (p4) {
    // Бот заточен под RAM-карту оригинала: в 4P-хаке слоты врагов 2-3 —
    // живые игроки, он целился бы в них. До адаптации — выключен.
    botBtn.disabled = true;
    botBtn.title = "Bot is not adapted to the 4-player hack yet";
  } else if (neuroBot) {
    // ?neurobot=1 — за P2 играет обученная сеть (модель лежит рядом с ромами).
    loadNeuroBot(engine.nes, (mask) => engine?.setButtons(2, mask), "/models/neurobot.json")
      .then((nb) => {
        bot = nb;
        bot.pause();
        botBtn.disabled = false;
        botBtn.title = "Neural bot";
        syncBot();
      })
      .catch((err) => {
        netStatus.textContent = `Neural bot failed to load: ${(err as Error).message}`;
      });
  } else {
    // Бот стартует на паузе и включается кнопкой.
    bot = startBot(engine.nes, (mask) => engine?.setButtons(2, mask));
    bot.pause();
    botBtn.disabled = false;
    syncBot();
  }

  session.onInput = (slot, mask) => {
    // Живой ввод на P2 перебивает бота (он и так на паузе, но на всякий).
    if (slot === 2 && bot && !bot.paused) return;
    engine?.setButtons(slot, mask);
  };
  session.onPeersChange = (list) => {
    lastPeers = list;
    p2Taken = list.some((p) => p.slot === 2);
    syncBot();
    renderPeers(list);
  };
  session.onError = (err) => {
    netStatus.textContent = `Network: ${err.message}`;
  };

  // Трансляция: картинка с canvas + звуковая дорожка из AudioPipe.
  let streamOk = true;
  try {
    const stream = canvas.captureStream(60);
    // Подсказки кодеку: картинка — постоянное движение, звук — «музыка»
    // (без голосовых фильтров, портящих чиптюн).
    for (const track of stream.getVideoTracks()) track.contentHint = "motion";
    if (audio) {
      for (const track of audio.stream.getAudioTracks()) {
        track.contentHint = "music";
        stream.addTrack(track);
      }
    }
    session.setStream(stream);
  } catch {
    streamOk = false;
  }

  roomCode.textContent = session.code;
  const link = new URL(`join.html?c=${session.code}`, location.href).toString();
  if (!streamOk) {
    netStatus.textContent =
      "Room is open, but the browser cannot capture canvas video — " +
      "clients will join without a picture. Try another browser.";
  } else {
    netStatus.textContent = audio
      ? "Room is open. Send the code or the link to a friend."
      : "Room is open (audio failed to start — playing without it).";
  }

  // QR-приглашение: второй телефон сканирует камерой и попадает сразу в комнату.
  const qrBtn = $<HTMLButtonElement>("qr-btn");
  const qrOverlay = $("qr-overlay");
  $("qr-box").innerHTML = renderSVG(link, { border: 2 }); // наш собственный SVG
  $("qr-code-text").textContent = session.code;
  qrBtn.hidden = false;
  qrBtn.addEventListener("click", () => {
    qrOverlay.hidden = false;
  });
  qrOverlay.addEventListener("click", () => {
    qrOverlay.hidden = true;
  });

  copyLink.hidden = false;
  copyLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(link);
      copyLink.textContent = "Copied";
    } catch {
      copyLink.textContent = link; // хотя бы показать
    }
    setTimeout(() => (copyLink.textContent = "Copy link"), 2500);
  });

  // pagehide надёжнее beforeunload на мобильных браузерах.
  window.addEventListener("pagehide", () => {
    voiceHub?.destroy();
    session.destroy();
  });
}

// ROM по ссылке: host.html?rom=<адрес> — файл тянется браузером хоста,
// в репозитории и на нашем хостинге его нет. Разрешены пути своего origin
// (локальный public/roms/) и абсолютные https-адреса с CORS. В localStorage
// такой ROM намеренно не сохраняется: он и так доступен по той же ссылке.
const romUrl = new URLSearchParams(location.search).get("rom");
if (romUrl) void beginFromUrl(romUrl);

/** Читы файла из манифеста: gg-коды и RAM-фризы — чтобы ?rom= получал их
 *  так же, как галерея (читы не должны зависеть от способа запуска). */
interface ManifestCheats {
  gg?: string[];
  ram?: Array<{ a: number; v: number }>;
  /** 4-player ромхак: включить Four Score и раздавать 4 слота. */
  p4?: boolean;
}
/** Сырая запись из /roms/index.json — все поля недоверенные. */
interface ManifestRomEntry {
  name?: unknown;
  file?: unknown;
  gg?: unknown;
  ram?: unknown;
  p4?: unknown;
}
function parseCheats(r: ManifestRomEntry): ManifestCheats {
  return {
    p4: r.p4 === true,
    gg: Array.isArray(r.gg)
      ? r.gg.filter((c): c is string => typeof c === "string")
      : undefined,
    ram: Array.isArray(r.ram)
      ? r.ram
          .filter(
            (p): p is { a: number | string; v: number } =>
              !!p && typeof p === "object" && "a" in p && "v" in p,
          )
          .map((p) => ({ a: Number(p.a), v: Number(p.v) }))
          .filter((p) => Number.isFinite(p.a) && Number.isFinite(p.v))
      : undefined,
  };
}

async function cheatsFromManifest(
  pathname: string,
): Promise<ManifestCheats | undefined> {
  try {
    const res = await fetch("/roms/index.json", { credentials: "omit" });
    if (!res.ok) return undefined;
    const parsed = (await res.json()) as { roms?: ManifestRomEntry[] };
    const file = pathname.split("/").pop();
    const hit = (parsed.roms ?? []).find(
      (r) => typeof r?.file === "string" && r.file === file,
    );
    return hit ? parseCheats(hit) : undefined;
  } catch {
    return undefined;
  }
}

async function beginFromUrl(raw: string, ggCodes?: string[]): Promise<void> {
  const pickStatus = $("pick-status");
  pickStatus.textContent = "Loading ROM from the link…";
  pickStatus.hidden = false;

  let bytes: Uint8Array;
  let cheats: ManifestCheats | undefined;
  try {
    const url = new URL(raw, location.href);
    // Манифест читается всегда: p4 и RAM-фризы не зависят от того,
    // переопределил ли пользователь gg-коды через URL.
    cheats = await cheatsFromManifest(url.pathname);
    // Отсекает data:, blob: и чужие http: — источники, которых в честной
    // ссылке быть не может.
    if (url.protocol !== "https:" && url.origin !== location.origin) {
      throw new Error("only https URLs or same-site files are allowed");
    }
    const res = await fetch(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > FILE_LIMIT * 1.4) throw new Error("file is larger than 4 MB");
    if (url.pathname.endsWith(".b64")) {
      // ROM, сохранённый как base64-текст: так бинарники доставляются на
      // сервер через инструменты, умеющие писать только UTF-8.
      const text = (await res.text()).replace(/\s+/g, "");
      const raw = atob(text);
      bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    if (bytes.length > FILE_LIMIT) throw new Error("file is larger than 4 MB");
    if (!isValidRom(bytes)) throw new Error("the link is not an iNES file");
  } catch (err) {
    pickStatus.hidden = true;
    // Пока ссылка грузилась, пользователь мог запустить игру файлом —
    // тогда не мусорим ошибкой поверх идущей игры.
    if (started) return;
    pickError.textContent =
      `Failed to load the ROM from the link (${(err as Error).message}). ` +
      `Check the URL, HTTPS and CORS on the file server.`;
    pickError.hidden = false;
    return;
  }
  pickStatus.hidden = true;
  void begin(
    bytes,
    ggCodes?.length ? ggCodes : cheats?.gg,
    cheats?.ram,
    cheats?.p4,
  );
}

/**
 * Галерея игр с сервера: /roms/index.json существует только там, куда
 * владелец сам положил ромы — локальный public/roms/ или его собственная
 * VM. В репозитории и на общем хостинге манифеста нет, и галерея просто
 * не появляется.
 */
async function loadGallery(): Promise<void> {
  let list: Array<{ name: string; file: string; cheats: ManifestCheats }> = [];
  try {
    const res = await fetch("/roms/index.json", { credentials: "omit" });
    if (!res.ok) return;
    const parsed = (await res.json()) as {
      roms?: Array<{ name?: unknown; file?: unknown; gg?: unknown; ram?: unknown }>;
    };
    list = (parsed.roms ?? [])
      .filter(
        (r): r is { name: string; file: string; gg?: unknown; ram?: unknown } =>
          typeof r?.name === "string" && typeof r?.file === "string",
      )
      .map((r) => ({ name: r.name, file: r.file, cheats: parseCheats(r) }));
  } catch {
    return; // нет манифеста — нет галереи
  }
  if (!list.length) return;

  const gallery = $("rom-gallery");
  gallery.hidden = false;
  for (const rom of list) {
    const btn = document.createElement("button");
    btn.className = "ghost";
    const hasCheats = rom.cheats.gg?.length || rom.cheats.ram?.length;
    const marks = [hasCheats ? "∞ lives" : null, rom.cheats.p4 ? "4P" : null]
      .filter(Boolean)
      .join(" · ");
    btn.textContent = marks ? `${rom.name} · ${marks}` : rom.name;
    // Без явных кодов: beginFromUrl сам возьмёт из манифеста и gg, и ram.
    btn.addEventListener("click", () => void beginFromUrl(`/roms/${rom.file}`));
    gallery.append(btn);
  }
}
void loadGallery();

function renderPeers(list: PeerInfo[]): void {
  const ping = (p: PeerInfo | undefined): string =>
    p?.rtt ? ` ${p.rtt}ms` : "";
  const maxP = sessionMaxPlayers;
  const parts: string[] = [];
  const p1 = list.find((p) => p.slot === 1);
  parts.push(
    hostPlays ? "P1: you" : p1 ? `P1: phone${ping(p1)}` : "P1: waiting",
  );
  for (let s = 2; s <= maxP; s++) {
    const p = list.find((e) => e.slot === s);
    parts.push(p ? `P${s}: on${ping(p)}` : `P${s}: waiting`);
  }
  const watchers = list.filter((p) => p.slot === 0).length;
  if (watchers) parts.push(`spectators: ${watchers}`);
  players.textContent = parts.join(" · ");
}
