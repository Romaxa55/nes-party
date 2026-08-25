import type { MediaConnection } from "peerjs";
import { tuneReceiversForLatency } from "./net";

/**
 * Голосовой чат звездой через хоста. Участник с включённым микрофоном
 * звонит хосту voice-звонком (metadata.kind = "voice"); хост отвечает
 * персональным миксом — голоса всех, КРОМЕ самого собеседника, поэтому
 * никто не слышит собственное эхо. Хост слушает всех через свои колонки,
 * его микрофон подмешивается в миксы всех участников.
 */

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

/**
 * Страховка WebKit: MediaStreamSource из удалённого WebRTC-потока молчит,
 * если поток параллельно не привязан к audio-элементу в документе.
 */
function keepAliveAudio(stream: MediaStream, muted: boolean): HTMLAudioElement {
  const el = new Audio();
  el.muted = muted;
  el.autoplay = true;
  el.srcObject = stream;
  el.style.display = "none";
  document.body.append(el);
  void el.play().catch(() => {});
  return el;
}

interface VoiceMember {
  call: MediaConnection;
  /** Голос участника; null, пока его стрим не приехал. */
  source: MediaStreamAudioSourceNode | null;
  /** Персональный микс, который слышит этот участник. */
  mix: MediaStreamAudioDestinationNode;
  keepAlive: HTMLAudioElement | null;
}

/** Хостовая сторона: принимает звонки, миксует, раздаёт. */
export class VoiceHub {
  private members = new Map<string, VoiceMember>();
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micPending = false;

  onMembersChange: (count: number) => void = () => {};

  constructor(private ctx: AudioContext) {}

  /** Входящий voice-звонок от участника. */
  accept(call: MediaConnection): void {
    // Повторный звонок того же peer — заменяем старый принудительно.
    this.remove(call.peer);

    const mix = this.ctx.createMediaStreamDestination();
    for (const m of this.members.values()) m.source?.connect(mix);
    this.micSource?.connect(mix);

    const member: VoiceMember = { call, source: null, mix, keepAlive: null };
    this.members.set(call.peer, member);

    call.on("stream", (remote) => {
      tuneReceiversForLatency(call);
      member.keepAlive = keepAliveAudio(remote, true);
      const src = this.ctx.createMediaStreamSource(remote);
      member.source = src;
      src.connect(this.ctx.destination); // хост слышит участника
      for (const [id, m] of this.members) {
        if (id !== call.peer) src.connect(m.mix); // остальные тоже
      }
      this.onMembersChange(this.members.size);
    });

    // Поздний close/error СТАРОГО звонка не должен снести свежего участника.
    const drop = (): void => this.remove(call.peer, call);
    call.on("close", drop);
    call.on("error", drop);

    call.answer(mix.stream);
    this.onMembersChange(this.members.size);
  }

  private remove(id: string, onlyIfCall?: MediaConnection): void {
    const m = this.members.get(id);
    if (!m) return;
    if (onlyIfCall && m.call !== onlyIfCall) return;
    this.members.delete(id);
    try {
      m.source?.disconnect();
    } catch {
      /* уже отключён */
    }
    // Обратные связи: микс уходящего перестаёт получать чужие голоса,
    // его треки останавливаются — иначе мёртвые узлы копятся с каждым
    // переподключением.
    for (const other of this.members.values()) {
      try {
        other.source?.disconnect(m.mix);
      } catch {
        /* связи могло не быть */
      }
    }
    try {
      this.micSource?.disconnect(m.mix);
    } catch {
      /* mic мог быть выключен */
    }
    for (const t of m.mix.stream.getTracks()) t.stop();
    if (m.keepAlive) {
      m.keepAlive.srcObject = null;
      m.keepAlive.remove();
    }
    m.call.close();
    this.onMembersChange(this.members.size);
  }

  /** Микрофон хоста; возвращает фактическое состояние после переключения. */
  async setMic(on: boolean): Promise<boolean> {
    if (this.micPending) return this.micStream !== null;
    this.micPending = true;
    try {
      if (on && !this.micStream) {
        const mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        this.micStream = mic;
        this.micSource = this.ctx.createMediaStreamSource(mic);
        // Себя хост не слушает — только в миксы участников.
        for (const m of this.members.values()) this.micSource.connect(m.mix);
      } else if (!on && this.micStream) {
        try {
          this.micSource?.disconnect();
        } catch {
          /* уже отключён */
        }
        this.micSource = null;
        for (const t of this.micStream.getTracks()) t.stop();
        this.micStream = null;
      }
      return this.micStream !== null;
    } finally {
      this.micPending = false;
    }
  }

  destroy(): void {
    void this.setMic(false);
    for (const id of [...this.members.keys()]) this.remove(id);
  }
}

/** Клиентская сторона: микрофон в обмен на микс остальных голосов. */
export class VoiceClient {
  private call: MediaConnection | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private pending = false;
  private cancelled = false;

  /** Звонок отвалился сам (ICE, хост ушёл) — страница синхронизирует кнопку. */
  onEnded: () => void = () => {};

  constructor(private makeCall: (mic: MediaStream) => MediaConnection | null) {}

  get active(): boolean {
    return this.call !== null;
  }

  /** Включить голос; бросает, если микрофон не дали или звонок не создался. */
  async enable(): Promise<void> {
    if (this.call || this.pending) return;
    this.pending = true;
    this.cancelled = false;
    try {
      const mic = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      // disable() мог прилететь, пока пользователь жал «разрешить».
      if (this.cancelled) {
        for (const t of mic.getTracks()) t.stop();
        return;
      }
      const call = this.makeCall(mic);
      if (!call) {
        for (const t of mic.getTracks()) t.stop();
        throw new Error("voice call failed");
      }
      this.micStream = mic;
      this.call = call;
      call.on("stream", (remote) => {
        tuneReceiversForLatency(call);
        // Не muted: это и воспроизведение микса, и WebKit-страховка разом.
        this.audioEl = keepAliveAudio(remote, false);
      });
      const drop = (): void => {
        this.disable();
        this.onEnded();
      };
      call.on("close", drop);
      call.on("error", drop);
    } finally {
      this.pending = false;
    }
  }

  disable(): void {
    this.cancelled = true; // прибьёт pending getUserMedia, когда тот доедет
    const call = this.call;
    this.call = null;
    call?.close();
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
  }
}
