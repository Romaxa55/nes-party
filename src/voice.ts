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

interface VoiceMember {
  call: MediaConnection;
  /** Голос участника; null, пока его стрим не приехал. */
  source: MediaStreamAudioSourceNode | null;
  /** Персональный микс, который слышит этот участник. */
  mix: MediaStreamAudioDestinationNode;
}

/** Хостовая сторона: принимает звонки, миксует, раздаёт. */
export class VoiceHub {
  private members = new Map<string, VoiceMember>();
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;

  onMembersChange: (count: number) => void = () => {};

  constructor(private ctx: AudioContext) {}

  /** Входящий voice-звонок от участника. */
  accept(call: MediaConnection): void {
    // Повторный звонок того же peer — заменяем старый.
    this.remove(call.peer);

    const mix = this.ctx.createMediaStreamDestination();
    for (const m of this.members.values()) m.source?.connect(mix);
    this.micSource?.connect(mix);

    const member: VoiceMember = { call, source: null, mix };
    this.members.set(call.peer, member);
    call.answer(mix.stream);

    call.on("stream", (remote) => {
      tuneReceiversForLatency(call);
      const src = this.ctx.createMediaStreamSource(remote);
      member.source = src;
      src.connect(this.ctx.destination); // хост слышит участника
      for (const [id, m] of this.members) {
        if (id !== call.peer) src.connect(m.mix); // остальные тоже
      }
      this.onMembersChange(this.members.size);
    });

    const drop = (): void => this.remove(call.peer);
    call.on("close", drop);
    call.on("error", drop);
    this.onMembersChange(this.members.size);
  }

  private remove(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    m.source?.disconnect();
    m.call.close();
    this.onMembersChange(this.members.size);
  }

  /** Микрофон хоста; возвращает фактическое состояние после переключения. */
  async setMic(on: boolean): Promise<boolean> {
    if (on && !this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      // Себя хост не слушает — только в миксы участников.
      for (const m of this.members.values()) this.micSource.connect(m.mix);
    } else if (!on && this.micStream) {
      this.micSource?.disconnect();
      this.micSource = null;
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    return this.micStream !== null;
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

  constructor(private makeCall: (mic: MediaStream) => MediaConnection) {}

  get active(): boolean {
    return this.call !== null;
  }

  /** Включить голос; бросает, если пользователь не дал микрофон. */
  async enable(): Promise<void> {
    if (this.call) return;
    this.micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const call = this.makeCall(this.micStream);
    this.call = call;
    call.on("stream", (remote) => {
      tuneReceiversForLatency(call);
      // Вызов идёт из клика по кнопке Mic — жест для воспроизведения есть.
      this.audioEl = new Audio();
      this.audioEl.srcObject = remote;
      this.audioEl.autoplay = true;
      void this.audioEl.play().catch(() => {});
    });
    const drop = (): void => this.disable();
    call.on("close", drop);
    call.on("error", drop);
  }

  disable(): void {
    const call = this.call;
    this.call = null;
    call?.close();
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) t.stop();
      this.micStream = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
  }
}
