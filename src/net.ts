import { Peer, type DataConnection, type MediaConnection } from "peerjs";
import type { ButtonMask } from "./controls";

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
  | { t: "input"; s: number };

export interface PeerInfo {
  id: string;
  slot: Slot;
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
  const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
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

// ---------------------------------------------------------------------------

interface HostPeer {
  conn: DataConnection;
  slot: Slot;
  call: MediaConnection | null;
}

export class HostSession {
  private peers = new Map<string, HostPeer>();
  private stream: MediaStream | null = null;

  /** Ввод от сетевого игрока: слот и маска кнопок. */
  onInput: (slot: 1 | 2, mask: ButtonMask) => void = () => {};
  /** Список подключённых изменился. */
  onPeersChange: (peers: PeerInfo[]) => void = () => {};
  /** Ошибка Peer после создания комнаты (сокет, WebRTC-переговоры и т.п.). */
  onError: (err: Error) => void = () => {};

  private constructor(
    readonly code: string,
    private peer: Peer,
  ) {
    peer.on("connection", (conn) => this.acceptConnection(conn));
    // Обрыв сокета до signaling не рвёт уже установленные P2P-соединения —
    // тихо переподключаемся, чтобы могли заходить новые игроки.
    peer.on("disconnected", () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on("error", (err) => this.onError(err as Error));
  }

  /**
   * Создаёт комнату: генерирует код и занимает peer id с этим кодом.
   * Коллизия кода (unavailable-id) — пробуем следующий, до пяти раз.
   */
  static async create(): Promise<HostSession> {
    let lastError: Error = new Error("не удалось создать комнату");
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
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
      if (!hp.call) hp.call = this.peer.call(id, stream);
    }
  }

  private acceptConnection(conn: DataConnection): void {
    conn.on("data", (raw) => {
      const msg = raw as Message;
      if (msg?.t === "hello") {
        this.admit(conn);
      } else if (msg?.t === "input") {
        const hp = this.peers.get(conn.peer);
        if (hp && hp.conn === conn && hp.slot !== 0) {
          this.onInput(hp.slot, Number(msg.s) & 0xff);
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
      this.emitPeers();
    };
    conn.on("close", drop);
    conn.on("error", drop);
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

    let slot: Slot;
    if (existing) {
      slot = existing.slot;
    } else {
      // Хост всегда играет за P1; первый подключившийся получает P2,
      // остальные смотрят трансляцию как зрители.
      const taken = new Set([...this.peers.values()].map((p) => p.slot));
      slot = taken.has(2) ? 0 : 2;
    }

    const hp: HostPeer = { conn, slot, call: null };
    this.peers.set(conn.peer, hp); // до close(), чтобы drop старого не снёс запись
    if (existing) {
      existing.call?.close();
      existing.conn.close();
    }

    conn.send({ t: "slot", p: slot } satisfies Message);
    if (this.stream) hp.call = this.peer.call(conn.peer, this.stream);
    this.emitPeers();
  }

  private emitPeers(): void {
    this.onPeersChange(
      [...this.peers.entries()].map(([id, p]) => ({ id, slot: p.slot })),
    );
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

  onClose: () => void = () => {};

  // Медиапоток может прийти раньше, чем страница успеет подписаться, —
  // буферизуем последний и отдаём при назначении обработчика.
  private streamCb: (stream: MediaStream) => void = () => {};
  private lastStream: MediaStream | null = null;

  set onStream(cb: (stream: MediaStream) => void) {
    this.streamCb = cb;
    if (this.lastStream) cb(this.lastStream);
  }

  private constructor(
    private peer: Peer,
    private conn: DataConnection,
  ) {}

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
        () => fail(new Error("Хост не ответил. Проверь код и что игра запущена.")),
        CONNECT_TIMEOUT_MS,
      );

      peer.on("error", (err) => {
        const type = (err as { type?: string }).type;
        fail(
          type === "peer-unavailable"
            ? new Error("Комната не найдена. Проверь код.")
            : new Error(`Сеть: ${(err as Error).message}`),
        );
      });

      const conn = peer.connect(ID_PREFIX + normalizeCode(code), {
        serialization: "json",
        reliable: true,
      });
      // В состоянии disconnected peerjs возвращает undefined вопреки тайпингам.
      if (!conn) {
        fail(new Error("Соединение не создалось — обнови страницу."));
        return;
      }
      const session = new ClientSession(peer, conn);

      conn.on("open", () => conn.send({ t: "hello" } satisfies Message));
      conn.on("data", (raw) => {
        const msg = raw as Message;
        if (msg?.t === "slot" && !settled) {
          settled = true;
          clearTimeout(timer);
          session.slot = msg.p;
          resolve(session);
        } else if (msg?.t === "full") {
          fail(new Error("В комнате нет свободных мест."));
        }
      });
      conn.on("close", () => {
        if (!settled) fail(new Error("Хост разорвал соединение."));
        else session.onClose();
      });
      conn.on("error", () => {
        if (!settled) fail(new Error("Ошибка соединения с хостом."));
        else session.onClose();
      });

      peer.on("call", (call) => {
        call.answer(); // своего потока у клиента нет
        call.on("stream", (stream) => {
          session.lastStream = stream;
          session.streamCb(stream);
        });
      });
    });
  }

  sendInput(mask: ButtonMask): void {
    if (this.conn.open) {
      this.conn.send({ t: "input", s: mask & 0xff } satisfies Message);
    }
  }

  destroy(): void {
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
      () => onError(new Error("Не удалось связаться с signaling-сервером PeerJS.")),
      CONNECT_TIMEOUT_MS,
    );

    peer.on("open", onOpen);
    peer.on("error", onError);
  });
}
