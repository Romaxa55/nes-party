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
        index: new URL("index.html", import.meta.url).pathname,
        host: new URL("host.html", import.meta.url).pathname,
        join: new URL("join.html", import.meta.url).pathname,
        bench: new URL("bench.html", import.meta.url).pathname,
      },
    },
  },
});
