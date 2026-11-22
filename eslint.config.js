import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated or non-JS/TS trees.
    ignores: [
      "dist",
      "build",
      "node_modules",
      "target",
      ".pnpm-store",
      "public",
      "src-tauri/gen",
      "src-tauri/target",
      "src-tauri/lib",
      "patches",
      // TypeDoc output: build output, ignored by git, not authored source.
      "docs/generated",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      // `_opts` is kept for file-saver API compatibility.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["*.{js,mjs,cjs,ts}", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // The OpenCode plugin runs in Node (reads `process.env`), not in a browser.
    files: [".opencode/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  // Must stay last: turns off stylistic rules that Prettier owns.
  prettier,
);
