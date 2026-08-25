/**
 * Звуковой конвейер: jsnes отдаёт сэмплы по одному из onAudioSample,
 * мы копим их в буфер кадра и после каждого nes.frame() передаём пачкой
 * в AudioWorklet. SharedArrayBuffer недоступен на GitHub Pages (нет
 * COOP/COEP-заголовков), поэтому связь через postMessage с transferable.
 *
 * Тот же звук уходит и в MediaStream — его подмешиваем в WebRTC-трансляцию.
 */

/** Порог заполнения кольца, выше которого пуши дропаются (фреймов, ~170 мс). */
const HIGH_WATER = 8192;

// Код процессора — строкой в Blob URL: не требует настройки сборки воркетов
// в Vite и одинаково работает локально и на GitHub Pages.
const WORKLET_SOURCE = `
class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 32768;                       // фреймов (пар L/R)
    this.buf = new Float32Array(this.capacity * 2);
    this.read = 0;
    this.write = 0;
    this.level = 0;                              // занято фреймов
    this.primed = false;                         // не играть, пока не накопим
    this.tick = 0;
    this.port.onmessage = (e) => {
      const chunk = e.data;                      // Float32Array, interleaved L/R
      const frames = chunk.length >> 1;
      for (let i = 0; i < frames; i++) {
        if (this.level >= this.capacity) break;  // переполнение — дропаем хвост
        const w = this.write * 2;
        this.buf[w] = chunk[i * 2];
        this.buf[w + 1] = chunk[i * 2 + 1];
        this.write = (this.write + 1) % this.capacity;
        this.level++;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const stereo = out.length > 1;
    const R = stereo ? out[1] : L;
    if (!this.primed && this.level >= 3072) this.primed = true; // ~70 мс запаса
    for (let i = 0; i < L.length; i++) {
      if (this.primed && this.level > 0) {
        const r = this.read * 2;
        if (stereo) {
          L[i] = this.buf[r];
          R[i] = this.buf[r + 1];
        } else {
          // Моно-выход: миксуем каналы, а не затираем левый правым.
          L[i] = (this.buf[r] + this.buf[r + 1]) * 0.5;
        }
        this.read = (this.read + 1) % this.capacity;
        this.level--;
      } else {
        L[i] = 0;
        R[i] = 0;
      }
    }
    if (this.primed && this.level === 0) this.primed = false;   // андерран — копим заново
    if (++this.tick >= 64) {                     // отчёт об уровне ~каждые 190 мс
      this.tick = 0;
      this.port.postMessage(this.level);
    }
    return true;
  }
}
registerProcessor("nes-audio", NesAudioProcessor);
`;

export class AudioPipe {
  /** Частота, которую нужно передать в конструктор NES как sampleRate. */
  readonly sampleRate: number;
  /** Аудиодорожка для WebRTC-трансляции. */
  readonly stream: MediaStream;

  private pending: Float32Array;
  private pendingFrames = 0;
  private workletLevel = 0;

  private constructor(
    private ctx: AudioContext,
    private node: AudioWorkletNode,
    dest: MediaStreamAudioDestinationNode,
  ) {
    this.sampleRate = ctx.sampleRate;
    this.stream = dest.stream;
    // С запасом на несколько кадров: при catchup-шагах flush мог не успеть.
    this.pending = new Float32Array(16384 * 2);
    node.port.onmessage = (e: MessageEvent<number>) => {
      this.workletLevel = e.data;
    };
  }

  /** Создавать только из обработчика клика — иначе контекст не запустится. */
  static async create(): Promise<AudioPipe> {
    const ctx = new AudioContext();
    await ctx.resume();

    const url = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
    );
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, "nes-audio", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    node.connect(ctx.destination); // локальный звук хоста
    node.connect(dest); // дорожка для трансляции

    return new AudioPipe(ctx, node, dest);
  }

  /** Колбэк для NES({ onAudioSample }) — вызывается на каждый сэмпл. */
  onSample = (left: number, right: number): void => {
    if (this.pendingFrames * 2 + 1 >= this.pending.length) return;
    const i = this.pendingFrames * 2;
    this.pending[i] = left;
    this.pending[i + 1] = right;
    this.pendingFrames++;
  };

  /** Вызывать после каждого nes.frame(): отправляет накопленное в воркет. */
  flush(): void {
    if (this.pendingFrames === 0) return;
    if (this.workletLevel > HIGH_WATER) {
      // Буфер разросся (например, после фриза вкладки) — сбрасываем,
      // чтобы звук не отставал от картинки. Уровень уползает редко.
      this.pendingFrames = 0;
      return;
    }
    const chunk = this.pending.slice(0, this.pendingFrames * 2);
    this.node.port.postMessage(chunk, [chunk.buffer]);
    this.pendingFrames = 0;
  }

  async close(): Promise<void> {
    this.node.disconnect();
    await this.ctx.close();
  }
}
