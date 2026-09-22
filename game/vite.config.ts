import { defineConfig } from "vitest/config";

// 사이트의 /play/ 아래에 올라가므로 상대 경로로 빌드한다.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        play: "index.html",
        garage: "garage.html",
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
