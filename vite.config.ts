import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  // Относительный base — одинаково работает и локально, и на GitHub Pages
  // под любым именем репозитория, без правки конфига.
  base: "./",
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
