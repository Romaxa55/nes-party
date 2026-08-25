import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
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
    },
  },
});
