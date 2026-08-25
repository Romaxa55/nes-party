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
const CODE_LENGTH = 5;
const CONNECT_TIMEOUT_MS = 20_000;

/** 0 — зритель, 1/2 — контроллеры NES. */
export type Slot = 0 | 1 | 2;

type Message =
  | { t: "hello" }
  | { t: "slot"; p: Slot }
  | { t: "input"; s: number };

export interface PeerInfo {
  id: string;
  slot: Slot;
}

function randomCode(): string {
  let code = "";
  const rnd = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[rnd[i] % CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function peerOptions(): NonNullable<ConstructorParameters<typeof Peer>[1]> {
  const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const extra = JSON.parse(localStorage.getItem("nes-party.ice") ?? "[]");
    if (Array.isArray(extra)) iceServers.push(...extra);
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

  private constructor(
    readonly code: string,
    private peer: Peer,
  ) {
    peer.on("connection", (conn) => this.acceptConnection(conn));
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
        if (hp && hp.slot !== 0) {
          this.onInput(hp.slot, Number(msg.s) & 0xff);
        }
      }
    });

    const drop = () => {
      const hp = this.peers.get(conn.peer);
      if (!hp) return;
      this.peers.delete(conn.peer);
      if (hp.slot !== 0) this.onInput(hp.slot, 0); // отпустить кнопки
      hp.call?.close();
      this.emitPeers();
    };
    conn.on("close", drop);
    conn.on("error", drop);
  }

  private admit(conn: DataConnection): void {
    if (this.peers.has(conn.peer)) return;
    // Хост всегда играет за P1; первый подключившийся получает P2,
    // остальные смотрят трансляцию как зрители.
    const taken = new Set([...this.peers.values()].map((p) => p.slot));
    const slot: Slot = taken.has(2) ? 0 : 2;

    const hp: HostPeer = { conn, slot, call: null };
    this.peers.set(conn.peer, hp);
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
    this.peer.destroy();
  }
}

// ---------------------------------------------------------------------------

export class ClientSession {
  /** Назначенный слот: 1/2 — играем, 0 — зритель. */
  slot: Slot | null = null;

  onSlot: (slot: Slot) => void = () => {};
  onStream: (stream: MediaStream) => void = () => {};
  onClose: () => void = () => {};

  private constructor(
    private peer: Peer,
    private conn: DataConnection,
  ) {}

  /** Подключается к комнате; reject — «не найдена» или таймаут. */
  static async connect(code: string): Promise<ClientSession> {
    const peer = await openPeer(undefined);

    return new Promise<ClientSession>((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error("Хост не ответил. Проверь код и что игра запущена."));
      }, CONNECT_TIMEOUT_MS);

      peer.on("error", (err) => {
        if ((err as { type?: string }).type === "peer-unavailable") {
          clearTimeout(timer);
          peer.destroy();
          reject(new Error("Комната не найдена. Проверь код."));
        }
      });

      const conn = peer.connect(ID_PREFIX + normalizeCode(code), {
        serialization: "json",
        reliable: true,
      });
      const session = new ClientSession(peer, conn);

      conn.on("open", () => conn.send({ t: "hello" } satisfies Message));
      conn.on("data", (raw) => {
        const msg = raw as Message;
        if (msg?.t === "slot") {
          clearTimeout(timer);
          session.slot = msg.p;
          session.onSlot(msg.p);
          resolve(session);
        }
      });
      conn.on("close", () => session.onClose());
      conn.on("error", () => session.onClose());

      peer.on("call", (call) => {
        call.answer(); // своего потока у клиента нет
        call.on("stream", (stream) => session.onStream(stream));
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

/** Открывает Peer и ждёт регистрации на signaling-сервере. */
function openPeer(id: string | undefined): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error("Не удалось связаться с signaling-сервером PeerJS."));
    }, CONNECT_TIMEOUT_MS);

    peer.once("open", () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.once("error", (err) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    });
  });
}
