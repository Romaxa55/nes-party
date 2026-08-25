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
  if (!document.documentElement.requestFullscreen) {
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
        const orientation = screen.orientation as unknown as {
          lock?: (o: string) => Promise<void>;
        };
        orientation.lock?.("landscape").catch(() => {});
      })
      .catch(() => {});
  });
}
