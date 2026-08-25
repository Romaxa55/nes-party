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
    button.hidden = true;
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
