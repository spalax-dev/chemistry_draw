import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the pure frontend helpers; scripts/ holds node:test suites.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
