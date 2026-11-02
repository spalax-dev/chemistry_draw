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
      "dist-packages",
      "node_modules",
      "target",
      "build-libs",
      ".pnpm-store",
      "public",
      "src-tauri/gen",
      "src-tauri/target",
      "src-tauri/lib",
      "patches",
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
  // Must stay last: turns off stylistic rules that Prettier owns.
  prettier,
);
