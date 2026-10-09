import { buildApp } from "./app"
import { ConfigError, loadConfig } from "./config"

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  }

  const app = await buildApp(config)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, "shutting down")
    try {
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error(err, "error during shutdown")
      process.exit(1)
    }
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))

  await app.listen({ host: config.HOST, port: config.PORT })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
