import { Peer, type DataConnection, type MediaConnection } from "peerjs";
import type { ButtonMask } from "./controls";

/**
 * Минимальная задержка воспроизведения входящего медиапотока: браузер
 * по умолчанию держит jitter-буфер в сотню-другую миллисекунд «на всякий
 * случай» — для игры это чистый инпут-лаг. Поля нестандартные (Chromium),
 * Safari молча игнорирует.
 */
export function tuneReceiversForLatency(call: MediaConnection): void {
  try {
    const pc = (call as unknown as { peerConnection?: RTCPeerConnection })
      .peerConnection;
    for (const r of pc?.getReceivers() ?? []) {
      const rr = r as RTCRtpReceiver & {
        playoutDelayHint?: number;
        jitterBufferTarget?: number;
      };
      // Видео — в ноль (каждая мс буфера = инпут-лаг); звуку оставляем
      // ~60 мс: лишнюю задержку голоса человек не замечает, а треск на
      // первом же джиттере — сразу.
      const video = rr.track?.kind === "video";
      rr.playoutDelayHint = video ? 0 : 0.06;
      try {
        rr.jitterBufferTarget = video ? 0 : 60;
      } catch {
        // старые Chromium кидают на присвоение — не критично
      }
    }
  } catch {
    // нет peerConnection — просто без тюнинга
  }
}

/**
 * Сетевой слой на PeerJS. Signaling идёт через бесплатное облако PeerJS
 * (0.peerjs.com) — свой сервер не нужен. Код комнаты зашит прямо в peer id
 * хоста, поэтому серверная логика комнат не нужна вовсе.
 *
 * TURN по умолчанию нет: если сети не соединяются напрямую (симметричный NAT),
 * добавь свои ICE-серверы в localStorage под ключом "nes-party.ice":
 *   [{"urls":"turn:host:3478","username":"u","credential":"p"}]
 */

const ID_PREFIX = "nes-party-";
// Без похожих символов (0/O, 1/I/L), чтобы код диктовался по телефону без ошибок.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;
const CONNECT_TIMEOUT_MS = 20_000;
/** Игрок 2 плюс несколько зрителей; дальше — отказ, чтобы не выесть аплинк хоста. */
const MAX_PEERS = 6;

/** 0 — зритель, 1/2 — контроллеры NES. */
export type Slot = 0 | 1 | 2;

type Message =
  | { t: "hello" }
  | { t: "slot"; p: Slot }
  | { t: "full" }
  | { t: "input"; s: number }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "rtt"; ms: number }
  | { t: "chat"; text: string; from?: string }
  | { t: "sys"; text: string }
  | { t: "roster"; l: Array<{ s: Slot; r: number | null }> };

export interface PeerInfo {
  id: string;
  slot: Slot;
  /** RTT до хоста, репортит сам клиент; null — ещё не измерен. */
  rtt: number | null;
}

const CHAT_MAX_LEN = 300;

function slotName(slot: Slot): string {
  return slot === 0 ? "Spec" : `P${slot}`;
}

function randomCode(): string {
  // Rejection sampling: 256 не делится на 31, поэтому байты выше порога
  // отбрасываем — иначе первые символы алфавита были бы чуть вероятнее.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      if (b < limit && code.length < CODE_LENGTH) {
        code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      }
    }
  }
  return code;
}

export function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function peerOptions(): NonNullable<ConstructorParameters<typeof Peer>[1]> {
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    // Публичный TURN (openrelay) — запасные кандидаты для случаев, где
    // прямой P2P не пробивается (датацентровые NAT: headless-хост комнаты
    // TANKS ↔ внешние клиенты). Прямому соединению не мешает: ICE всегда
    // предпочитает host/srflx-пары relay-паре.
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];
  try {
    const extra = JSON.parse(localStorage.getItem("nes-party.ice") ?? "[]");
    if (Array.isArray(extra)) {
      for (const s of extra) {
        // Кривой элемент уронил бы переговоры ICE позже и непонятно —
        // отбрасываем всё, что не похоже на RTCIceServer.
        if (s && (typeof s.urls === "string" || Array.isArray(s.urls))) {
          iceServers.push(s);
        }
      }
    }
  } catch {
    // Кривой JSON в настройке — работаем с одним STUN.
  }
  return { config: { iceServers } };
}

/**
 * Исходящее видео хоста: плавность важнее чёткости (при нехватке сети браузер
 * по умолчанию жертвует кадрами ради разрешения — для игры нужно наоборот),
 * плюс потолок битрейта, чтобы не душить аплинк хоста при трёх зрителях.
 */
export function tuneSendersForGame(call: MediaConnection): void {
  const apply = (): boolean => {
    const pc = (call as unknown as { peerConnection?: RTCPeerConnection })
      .peerConnection;
    let done = false;
    for (const s of pc?.getSenders() ?? []) {
      if (s.track?.kind !== "video") continue;
      const p = s.getParameters();
      p.degradationPreference = "maintain-framerate";
      if (p.encodings?.[0]) p.encodings[0].maxBitrate = 2_500_000;
      void s.setParameters(p).catch(() => {});
      done = true;
    }
    return done;
  };
  // Сендеры появляются после негошиации — одна отложенная попытка.
  if (!apply()) setTimeout(apply, 1000);
}

// ---------------------------------------------------------------------------

interface HostPeer {
  conn: DataConnection;
  slot: Slot;
  call: MediaConnection | null;
  rtt: number | null;
  /** Метки времени последних чат-сообщений — для rate-limit. */
  chatTimes?: number[];
}

export class HostSession {
  private peers = new Map<string, HostPeer>();
  private stream: MediaStream | null = null;
  private hostPlays = true;

  /** Ввод от сетевого игрока: слот и маска кнопок. */
  onInput: (slot: 1 | 2, mask: ButtonMask) => void = () => {};
  /** Список подключённых изменился. */
  onPeersChange: (peers: PeerInfo[]) => void = () => {};
  /** Ошибка Peer после создания комнаты (сокет, WebRTC-переговоры и т.п.). */
  onError: (err: Error) => void = () => {};
  /** Сообщение чата (включая свои — хост тоже видит их через этот колбэк). */
  onChat: (from: string, text: string) => void = () => {};
  /** Системное событие комнаты (кто вошёл/вышел/пересел) — в ленту чата. */
  onSys: (text: string) => void = () => {};
  /** Входящий голосовой звонок (metadata.kind === "voice") — отдаётся VoiceHub. */
  onVoiceCall: (call: MediaConnection) => void = (call) => call.close();

  private constructor(
    readonly code: string,
    private peer: Peer,
  ) {
    peer.on("connection", (conn) => this.acceptConnection(conn));
    peer.on("call", (call) => {
      const kind = (call.metadata as { kind?: string } | undefined)?.kind;
      if (kind === "voice") this.onVoiceCall(call);
      else call.close(); // незваные медиазвонки не принимаем
    });
    // Обрыв сокета до signaling не рвёт уже установленные P2P-соединения —
    // тихо переподключаемся, чтобы могли заходить новые игроки.
    peer.on("disconnected", () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on("error", (err) => this.onError(err as Error));
  }

  /**
   * Создаёт комнату: занимает peer id с кодом. Без preferredCode код
   * случайный; с ним (постоянный облачный сервер) сначала пробуем его,
   * при коллизии откатываемся на случайные.
   */
  static async create(preferredCode?: string): Promise<HostSession> {
    let lastError: Error = new Error("failed to create a room");
    for (let attempt = 0; attempt < 5; attempt++) {
      const code =
        attempt === 0 && preferredCode
          ? normalizeCode(preferredCode)
          : randomCode();
      if (code.length !== CODE_LENGTH) continue;
      try {
        const peer = await openPeer(ID_PREFIX + code);
        return new HostSession(code, peer);
      } catch (err) {
        lastError = err as Error;
        if ((err as { type?: string }).type !== "unavailable-id") throw err;
      }
    }
    throw lastError;
  }

  /** Трансляция (видео+звук): звоним всем текущим и каждому новому. */
  setStream(stream: MediaStream): void {
    this.stream = stream;
    for (const [id, hp] of this.peers) {
      if (!hp.call) {
        hp.call = this.peer.call(id, stream);
        tuneSendersForGame(hp.call);
      }
    }
  }

  private acceptConnection(conn: DataConnection): void {
    // Быстрый канал ввода: unreliable, бинарный, со своим порядком (seq).
    if (conn.label === "input") {
      this.acceptInputChannel(conn);
      return;
    }
    conn.on("data", (raw) => {
      const msg = raw as Message;
      if (msg?.t === "hello") {
        this.admit(conn);
        return;
      }
      const hp = this.peers.get(conn.peer);
      if (!hp || hp.conn !== conn) return;
      switch (msg?.t) {
        case "input":
          if (hp.slot !== 0) this.onInput(hp.slot, Number(msg.s) & 0xff);
          break;
        case "ping":
          conn.send({ t: "pong", ts: Number(msg.ts) } satisfies Message);
          break;
        case "rtt": {
          const ms = Math.round(Number(msg.ms));
          if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) break;
          // Roster рассылается только при заметном изменении пинга и с
          // троттлингом — иначе каждый rtt-репорт умножался бы на всех пиров.
          const notable = hp.rtt === null || Math.abs(ms - hp.rtt) >= 15;
          hp.rtt = ms;
          if (notable) this.emitPeersThrottled();
          break;
        }
        case "chat": {
          // Мусор и гиганты — мимо, до какой-либо обработки.
          if (typeof msg.text !== "string" || msg.text.length > 2000) break;
          // Rate-limit: 5 сообщений за 5 секунд на пира, лишнее молча дропаем —
          // хост ретранслирует каждое всем, флуд умножался бы на аплинк.
          const now = performance.now();
          hp.chatTimes = (hp.chatTimes ?? []).filter((t) => now - t < 5000);
          if (hp.chatTimes.length >= 5) break;
          hp.chatTimes.push(now);
          const text = msg.text.slice(0, CHAT_MAX_LEN).trim();
          if (text) this.deliverChat(slotName(hp.slot), text);
          break;
        }
      }
    });

    const drop = () => {
      const hp = this.peers.get(conn.peer);
      // Тот же peer id мог переподключиться новым соединением — закрытие
      // старого не должно выкидывать из комнаты живого игрока.
      if (!hp || hp.conn !== conn) return;
      this.peers.delete(conn.peer);
      if (hp.slot !== 0) this.onInput(hp.slot, 0); // отпустить кнопки
      hp.call?.close();
      this.deliverSys(
        hp.slot === 0 ? "A spectator left" : `Player ${hp.slot} left`,
      );
      this.rebalance(); // освободившийся контроллер — первому зрителю
      this.emitPeers();
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  /**
   * Пакет ввода: [маска, seqLo, seqHi]. Канал без ретрансмитов и порядка,
   * поэтому устаревшие/дублирующиеся пакеты отбрасываются по seq
   * (сравнение с учётом переполнения 16 бит).
   */
  private acceptInputChannel(conn: DataConnection): void {
    let lastSeq = -1;
    conn.on("data", (raw) => {
      const hp = this.peers.get(conn.peer);
      if (!hp || hp.slot === 0) return;
      const b =
        raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw instanceof Uint8Array
            ? raw
            : null;
      if (!b || b.length < 3) return;
      const seq = b[1] | (b[2] << 8);
      if (lastSeq >= 0) {
        const diff = (seq - lastSeq + 0x10000) & 0xffff;
        if (diff === 0 || diff > 0x8000) return; // дубль или устаревший
      }
      lastSeq = seq;
      this.onInput(hp.slot, b[0] & 0xff);
    });
  }

  private admit(conn: DataConnection): void {
    // Повторный hello с того же peer id — переподключение: старое соединение
    // закрываем, слот наследуется.
    const existing = this.peers.get(conn.peer);
    if (existing && existing.conn === conn) return;

    if (!existing && this.peers.size >= MAX_PEERS) {
      conn.send({ t: "full" } satisfies Message);
      setTimeout(() => conn.close(), 500); // дать сообщению долететь
      return;
    }

    const slot: Slot = existing ? existing.slot : this.freeSlot();

    const hp: HostPeer = { conn, slot, call: null, rtt: null };
    this.peers.set(conn.peer, hp); // до close(), чтобы drop старого не снёс запись
    if (existing) {
      existing.call?.close();
      existing.conn.close();
    }

    conn.send({ t: "slot", p: slot } satisfies Message);
    if (this.stream) {
      hp.call = this.peer.call(conn.peer, this.stream);
      tuneSendersForGame(hp.call);
    }
    if (!existing) {
      this.deliverSys(slot === 0 ? "A spectator joined" : `Player ${slot} joined`);
    }
    this.emitPeers();
  }

  /**
   * Играет ли хост сам за P1. Выключено — слот 1 отдаётся клиентам:
   * режим «этот экран — телевизор, все игроки на телефонах».
   */
  setHostPlays(v: boolean): void {
    if (this.hostPlays === v) return;
    this.hostPlays = v;
    if (v) {
      for (const hp of this.peers.values()) {
        if (hp.slot === 1) {
          hp.slot = 0;
          hp.conn.send({ t: "slot", p: 0 } satisfies Message);
          this.onInput(1, 0); // отпустить кнопки забранного контроллера
        }
      }
    }
    this.rebalance();
    this.emitPeers();
  }

  private freeSlot(): Slot {
    const taken = new Set([...this.peers.values()].map((p) => p.slot));
    if (!this.hostPlays && !taken.has(1)) return 1;
    if (!taken.has(2)) return 2;
    return 0;
  }

  /** Повышает зрителей на освободившиеся контроллеры, в порядке входа. */
  private rebalance(): void {
    for (const hp of this.peers.values()) {
      if (hp.slot !== 0) continue;
      const give = this.freeSlot();
      if (give === 0) break;
      hp.slot = give;
      hp.conn.send({ t: "slot", p: give } satisfies Message);
      this.deliverSys(`A spectator is now Player ${give}`);
    }
  }

  /** Сообщение от хоста в общий чат. */
  sendChat(text: string): void {
    const clean = text.slice(0, CHAT_MAX_LEN).trim();
    if (clean) this.deliverChat("Host", clean);
  }

  /** Показывает сообщение всем: локально хосту и рассылкой клиентам. */
  private deliverChat(from: string, text: string): void {
    this.onChat(from, text);
    const msg = { t: "chat", from, text } satisfies Message;
    for (const hp of this.peers.values()) {
      if (hp.conn.open) hp.conn.send(msg);
    }
  }

  /** Системное событие — в ленту чата всем и хосту. */
  private deliverSys(text: string): void {
    this.onSys(text);
    const msg = { t: "sys", text } satisfies Message;
    for (const hp of this.peers.values()) {
      if (hp.conn.open) hp.conn.send(msg);
    }
  }

  private emitTimer: ReturnType<typeof setTimeout> | undefined;

  /** Коалесцирует частые обновления (rtt-репорты) в одну рассылку раз в 500 мс. */
  private emitPeersThrottled(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emitPeers();
    }, 500);
  }

  private emitPeers(): void {
    const list = [...this.peers.entries()].map(([id, p]) => ({
      id,
      slot: p.slot,
      rtt: p.rtt,
    }));
    this.onPeersChange(list);
    // Состав комнаты — клиентам; хост включает сам себя как P1, когда играет.
    const roster = {
      t: "roster",
      l: [
        ...(this.hostPlays ? [{ s: 1 as Slot, r: null }] : []),
        ...list.map((p) => ({ s: p.slot, r: p.rtt })),
      ],
    } satisfies Message;
    for (const hp of this.peers.values()) {
      if (hp.conn.open) hp.conn.send(roster);
    }
  }

  destroy(): void {
    for (const hp of this.peers.values()) {
      hp.call?.close();
      hp.conn.close();
    }
    this.peers.clear();
    this.peer.destroy();
  }
}

// ---------------------------------------------------------------------------

export class ClientSession {
  /** Назначенный слот: 1/2 — играем, 0 — зритель. */
  slot: Slot | null = null;
  /** Последний измеренный RTT до хоста, мс. */
  rtt: number | null = null;

  onClose: () => void = () => {};
  /** Хост может пересадить на другой слот уже после подключения. */
  onSlotChange: (slot: Slot) => void = () => {};
  onChat: (from: string, text: string) => void = () => {};
  onSys: (text: string) => void = () => {};
  onRtt: (ms: number) => void = () => {};
  /** Состав комнаты (слоты и пинги), рассылается хостом при изменениях. */
  onRoster: (l: Array<{ s: Slot; r: number | null }>) => void = () => {};

  // Медиапоток может прийти раньше, чем страница успеет подписаться, —
  // буферизуем последний и отдаём при назначении обработчика.
  private streamCb: (stream: MediaStream) => void = () => {};
  private lastStream: MediaStream | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private inputConn: DataConnection | null = null;
  private inputTimer: ReturnType<typeof setInterval> | undefined;
  private inputSeq = 0;
  private lastMask: ButtonMask = 0;

  set onStream(cb: (stream: MediaStream) => void) {
    this.streamCb = cb;
    if (this.lastStream) cb(this.lastStream);
  }

  private constructor(
    private peer: Peer,
    private conn: DataConnection,
    private hostId: string,
  ) {}

  /** Периодический замер RTT; результат уходит и хосту для его HUD. */
  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.conn.open) {
        this.conn.send({ t: "ping", ts: performance.now() } satisfies Message);
      }
    }, 2000);
  }

  /**
   * Быстрый канал ввода: без ретрансмитов — потерянный пакет не блокирует
   * следующие (у reliable-канала потеря стоила бы RTT всем нажатиям после
   * неё). Потери страхуются ресендом текущего состояния каждые 50 мс.
   * Пока канал не открыт (или не открылся вовсе) — работает старый путь.
   */
  private openInputChannel(): void {
    // Вспомогательный канал не имеет права ломать основное подключение —
    // любая ошибка здесь просто оставляет ввод на надёжном пути.
    try {
      const c = this.peer.connect(this.hostId, {
        label: "input",
        reliable: false,
        serialization: "raw", // как есть, без сериализатора
      });
      if (!c) return;
      c.on("open", () => {
        this.inputConn = c;
      });
      const drop = (): void => {
        if (this.inputConn === c) this.inputConn = null;
      };
      c.on("close", drop);
      c.on("error", drop);
    } catch {
      return;
    }
    this.inputTimer = setInterval(() => this.pushInput(), 50);
  }

  private pushInput(): void {
    if (this.inputConn?.open) {
      this.inputSeq = (this.inputSeq + 1) & 0xffff;
      const b = new Uint8Array(3);
      b[0] = this.lastMask;
      b[1] = this.inputSeq & 0xff;
      b[2] = this.inputSeq >> 8;
      this.inputConn.send(b);
    } else if (this.conn.open) {
      this.conn.send({ t: "input", s: this.lastMask } satisfies Message);
    }
  }

  /** Подключается к комнате; reject — «не найдена», «мест нет» или таймаут. */
  static async connect(code: string): Promise<ClientSession> {
    const peer = await openPeer(undefined);

    return new Promise<ClientSession>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(err);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              "The host did not respond. Check the code and that the game is running.",
            ),
          ),
        CONNECT_TIMEOUT_MS,
      );

      peer.on("error", (err) => {
        const type = (err as { type?: string }).type;
        fail(
          type === "peer-unavailable"
            ? new Error("Room not found. Check the code.")
            : new Error(`Network: ${(err as Error).message}`),
        );
      });

      const hostId = ID_PREFIX + normalizeCode(code);
      const conn = peer.connect(hostId, {
        serialization: "json",
        reliable: true,
      });
      // В состоянии disconnected peerjs возвращает undefined вопреки тайпингам.
      if (!conn) {
        fail(new Error("Could not create a connection — reload the page."));
        return;
      }
      const session = new ClientSession(peer, conn, hostId);

      conn.on("open", () => conn.send({ t: "hello" } satisfies Message));
      conn.on("data", (raw) => {
        const msg = raw as Message;
        if (msg?.t === "slot") {
          session.slot = msg.p;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            session.startPing();
            session.openInputChannel();
            resolve(session);
          } else {
            session.onSlotChange(msg.p);
          }
        } else if (msg?.t === "full") {
          fail(new Error("No free seats in this room."));
        } else if (msg?.t === "pong") {
          const ms = Math.max(0, Math.round(performance.now() - Number(msg.ts)));
          session.rtt = ms;
          session.onRtt(ms);
          if (conn.open) conn.send({ t: "rtt", ms } satisfies Message);
        } else if (msg?.t === "chat") {
          session.onChat(
            String(msg.from ?? "?").slice(0, 20),
            String(msg.text ?? "").slice(0, CHAT_MAX_LEN),
          );
        } else if (msg?.t === "sys") {
          session.onSys(String(msg.text ?? "").slice(0, CHAT_MAX_LEN));
        } else if (msg?.t === "roster") {
          const l = Array.isArray(msg.l)
            ? msg.l.filter(
                (e): e is { s: Slot; r: number | null } =>
                  !!e && typeof e === "object" &&
                  typeof (e as { s?: unknown }).s === "number",
              )
            : [];
          session.onRoster(l);
        }
      });
      conn.on("close", () => {
        if (!settled) fail(new Error("The host closed the connection."));
        else session.onClose();
      });
      conn.on("error", () => {
        if (!settled) fail(new Error("Connection to the host failed."));
        else session.onClose();
      });

      let gameCall: MediaConnection | null = null;
      peer.on("call", (call) => {
        // Принимаем только игровой звонок от нашего хоста — незваные мимо.
        const kind = (call.metadata as { kind?: string } | undefined)?.kind;
        if (call.peer !== hostId || kind === "voice") {
          call.close();
          return;
        }
        gameCall?.close(); // реконнект хоста — старый поток больше не нужен
        gameCall = call;
        call.on("stream", (stream) => {
          tuneReceiversForLatency(call);
          session.lastStream = stream;
          session.streamCb(stream);
        });
        call.answer(); // своего потока в игровом звонке у клиента нет
      });
    });
  }

  sendInput(mask: ButtonMask): void {
    this.lastMask = mask & 0xff;
    this.pushInput();
  }

  sendChat(text: string): void {
    const clean = text.slice(0, CHAT_MAX_LEN).trim();
    if (clean && this.conn.open) {
      this.conn.send({ t: "chat", text: clean } satisfies Message);
    }
  }

  /** Голосовой звонок хосту: свой микрофон в обмен на микс остальных.
   *  null — peer отвалился от signaling (peerjs возвращает undefined). */
  callVoice(mic: MediaStream): MediaConnection | null {
    return (
      this.peer.call(this.hostId, mic, { metadata: { kind: "voice" } }) ?? null
    );
  }

  destroy(): void {
    clearInterval(this.pingTimer);
    clearInterval(this.inputTimer);
    this.peer.destroy();
  }
}

// ---------------------------------------------------------------------------

/**
 * Открывает Peer и ждёт регистрации на signaling-сервере. Оба обработчика
 * снимаются после первого исхода: висящий error-хендлер иначе убивал бы
 * Peer при любой поздней ошибке (например, неудачных ICE-переговорах
 * одного из клиентов).
 */
function openPeer(id: string | undefined): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      peer.off("open", onOpen);
      peer.off("error", onError);
    };
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(peer);
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      peer.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => onError(new Error("Could not reach the PeerJS signaling server.")),
      CONNECT_TIMEOUT_MS,
    );

    peer.on("open", onOpen);
    peer.on("error", onError);
  });
}
