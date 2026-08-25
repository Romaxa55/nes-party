/** Общие мелочи для страниц. */

export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Нет элемента #${id}`);
  return el as T;
};

/**
 * Кнопка фуллскрина: разворачивает страницу и пытается зафиксировать
 * ландшафт (работает на Android; iOS Safari не умеет ни того, ни другого
 * для не-video элементов — там кнопка прячется, подсказку о повороте
 * даёт CSS).
 */
export function setupFullscreenButton(button: HTMLElement): void {
  // fullscreenEnabled ловит и запрет через Permissions-Policy/iframe,
  // а не только отсутствие метода.
  if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) {
    // iOS Safari: настоящего fullscreen нет — кнопка объясняет PWA-путь.
    button.addEventListener("click", () => {
      if (document.getElementById("ios-fs-hint")) return;
      const hint = document.createElement("div");
      hint.id = "ios-fs-hint";
      hint.className = "ios-fs-hint";
      hint.textContent =
        "iPhone: open the Share menu and tap “Add to Home Screen” — " +
        "the game will launch fullscreen, without Safari bars. Tap to dismiss.";
      hint.addEventListener("click", () => hint.remove());
      document.body.append(hint);
      setTimeout(() => hint.remove(), 10_000);
    });
    return;
  }
  button.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    document.documentElement
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => {
        // В lib.dom у ScreenOrientation нет lock (Safari его не реализует),
        // поэтому каст; в рантайме Android он есть.
        const orientation = screen.orientation as unknown as {
          lock?: (o: string) => Promise<void>;
        };
        return orientation.lock?.("landscape");
      })
      .catch(() => {});
  });
}
