import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  plugins: [react()],
  base: "/",
  build: { outDir: "../dist/dashboard", emptyOutDir: true, target: "es2022" },
});
