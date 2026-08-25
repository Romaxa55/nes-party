import { $ } from "./dom";

const MAX_MESSAGES = 100;

export interface ChatPanel {
  addMessage(from: string, text: string): void;
}

/**
 * Панель чата поверх игровой сцены: кнопка #chat-btn открывает #chat-panel
 * с историей и полем ввода. Непрочитанное подсвечивает кнопку.
 * Разметка одинаковая на host.html и join.html.
 */
export function setupChatPanel(onSend: (text: string) => void): ChatPanel {
  const btn = $<HTMLButtonElement>("chat-btn");
  const panel = $("chat-panel");
  const log = $("chat-log");
  const form = $<HTMLFormElement>("chat-form");
  const input = $<HTMLInputElement>("chat-input");

  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      btn.classList.remove("attn");
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

  return {
    addMessage(from, text) {
      const row = document.createElement("div");
      row.className = "chat-msg";
      const who = document.createElement("b");
      who.textContent = `${from}: `;
      row.append(who, document.createTextNode(text));
      log.append(row);
      while (log.childElementCount > MAX_MESSAGES) log.firstElementChild?.remove();
      log.scrollTop = log.scrollHeight;
      if (panel.hidden) btn.classList.add("attn");
    },
  };
}
