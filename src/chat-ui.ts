import { $ } from "./dom";

const MAX_MESSAGES = 100;
const TOAST_MS = 5000;
const MAX_TOASTS = 3;

export interface ChatPanel {
  addMessage(from: string, text: string): void;
  /** Системное событие комнаты — серым курсивом, без имени. */
  addSystem(text: string): void;
}

/**
 * Панель чата поверх игровой сцены: кнопка #chat-btn открывает #chat-panel
 * с историей и полем ввода. При закрытой панели новое сообщение показывается
 * тостом поверх игры, а кнопка получает счётчик непрочитанных.
 */
export function setupChatPanel(onSend: (text: string) => void): ChatPanel {
  const btn = $<HTMLButtonElement>("chat-btn");
  const panel = $("chat-panel");
  const log = $("chat-log");
  const form = $<HTMLFormElement>("chat-form");
  const input = $<HTMLInputElement>("chat-input");
  let unread = 0;

  // Контейнер тостов создаётся рядом с панелью, внутри игровой сцены.
  const toasts = document.createElement("div");
  toasts.className = "chat-toasts";
  panel.parentElement?.append(toasts);

  function syncBtn(): void {
    btn.textContent = unread > 0 ? `Chat (${unread})` : "Chat";
    btn.classList.toggle("attn", unread > 0);
  }

  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      unread = 0;
      syncBtn();
      input.focus();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    onSend(text);
    input.value = "";
  });

  function push(row: HTMLElement): void {
    log.append(row);
    while (log.childElementCount > MAX_MESSAGES) log.firstElementChild?.remove();
    log.scrollTop = log.scrollHeight;

    if (panel.hidden) {
      unread++;
      syncBtn();
      const toast = row.cloneNode(true) as HTMLElement;
      toast.classList.add("chat-toast");
      toasts.append(toast);
      while (toasts.childElementCount > MAX_TOASTS) {
        toasts.firstElementChild?.remove();
      }
      setTimeout(() => toast.remove(), TOAST_MS);
    }
  }

  return {
    addMessage(from, text) {
      const row = document.createElement("div");
      row.className = "chat-msg";
      const who = document.createElement("b");
      who.textContent = `${from}: `;
      row.append(who, document.createTextNode(text));
      push(row);
    },
    addSystem(text) {
      const row = document.createElement("div");
      row.className = "chat-msg sys";
      row.textContent = text;
      push(row);
    },
  };
}
