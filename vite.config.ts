import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Версия сборки видна в HUD — «какая версия бота?» решается взглядом.
let buildId = "dev";
try {
  buildId = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  /* вне git */
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  // Относительный base — одинаково работает и локально, и на GitHub Pages
  // под любым именем репозитория, без правки конфига.
  base: "./",
  // Самоподписанный HTTPS для dev: AudioWorklet (звук хоста) работает только
  // в secure context, а телефоны заходят по IP. Телефон один раз спросит про
  // сертификат — «всё равно открыть». На прод-сборку не влияет.
  // VITE_NO_SSL=1 отключает — для автотестов, которым нужен plain http.
  plugins: process.env.VITE_NO_SSL === "1" ? [] : [basicSsl()],
  server: {
    // Слушать 0.0.0.0, чтобы страница открывалась с телефона по IP в той же сети.
    host: true,
    port: 5173,
  },
  build: {
    target: "es2020",
    outDir: "dist",
    rollupOptions: {
      // Четыре независимые страницы: лендинг, хост, клиент, бенчмарк.
      input: {
        index: fileURLToPath(new URL("index.html", import.meta.url)),
        host: fileURLToPath(new URL("host.html", import.meta.url)),
        join: fileURLToPath(new URL("join.html", import.meta.url)),
        bench: fileURLToPath(new URL("bench.html", import.meta.url)),
      },
      output: {
        // Держим каждый чанк меньше ~100 КБ: канал заливки на VibHost VM
        // (vh_write_file_on_project) отдаёт 413 на большие тела запроса.
        // jsnes — десяток модулей, режется по подсистемам консоли.
        manualChunks(id: string) {
          if (id.includes("node_modules/jsnes")) {
            if (id.includes("/ppu")) return "jsnes-ppu";
            if (id.includes("/papu")) return "jsnes-papu";
            if (id.includes("/mappers")) return "jsnes-mappers";
            return "jsnes-core";
          }
          // Явный чанк: без него peerjs приклеивался к net.ts, и общий чанк
          // подобрался к лимиту заливки на 2 КБ.
          if (id.includes("node_modules/peerjs")) return "peerjs";
        },
      },
    },
  },
});
