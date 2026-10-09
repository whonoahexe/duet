import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // better-sqlite3 and @node-rs/argon2 are native addons: isolate them in forked processes.
    pool: "forks",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
})
