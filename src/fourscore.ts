import { NES, Controller } from "jsnes";

/**
 * Эмуляция NES Four Score (адаптер на 4 контроллера) поверх jsnes без
 * форка ядра. Протокол (nesdev.org/wiki/Four_Score): после строба каждое
 * чтение $4016 отдаёт по биту — джойстик 1 (8 бит), джойстик 3 (8 бит),
 * сигнатура 0x10 (8 бит, LSB-first → единица на 5-й позиции); $4017 —
 * джойстики 2 и 4 с сигнатурой 0x20. Счётчик строба в jsnes уже ходит
 * до 24 — подменяем только joy1Read/joy2Read у маппера.
 *
 * Вызывать ПОСЛЕ nes.loadROM(): маппер пересоздаётся при загрузке рома.
 */
export function enableFourScore(nes: NES): void {
  const anyNes = nes as unknown as {
    controllers: Record<number, Controller>;
    mmap: {
      _syncJoypadOutput: () => void;
      joypadOutputBit0: number;
      joy1StrobeState: number;
      joy2StrobeState: number;
      joy1Read: () => number;
      joy2Read: () => number;
    };
  };

  if (!anyNes.mmap) {
    throw new Error("enableFourScore must be called after nes.loadROM()");
  }

  anyNes.controllers[3] = new Controller();
  anyNes.controllers[4] = new Controller();

  const mmap = anyNes.mmap;

  mmap.joy1Read = function (this: typeof mmap): number {
    this._syncJoypadOutput();
    if (this.joypadOutputBit0) return anyNes.controllers[1].state[0];
    const s = this.joy1StrobeState;
    let ret: number;
    if (s < 8) ret = anyNes.controllers[1].state[s];
    else if (s < 16) ret = anyNes.controllers[3].state[s - 8];
    else ret = s === 20 ? 1 : 0; // сигнатура 0x10, LSB-first
    this.joy1StrobeState++;
    if (this.joy1StrobeState === 24) this.joy1StrobeState = 0;
    return ret;
  };

  mmap.joy2Read = function (this: typeof mmap): number {
    this._syncJoypadOutput();
    if (this.joypadOutputBit0) return anyNes.controllers[2].state[0];
    const s = this.joy2StrobeState;
    let ret: number;
    if (s < 8) ret = anyNes.controllers[2].state[s];
    else if (s < 16) ret = anyNes.controllers[4].state[s - 8];
    else ret = s === 21 ? 1 : 0; // сигнатура 0x20, LSB-first
    this.joy2StrobeState++;
    if (this.joy2StrobeState === 24) this.joy2StrobeState = 0;
    return ret;
  };
}
