/**
 * Media key CLI (QT-4qu-key, T-4qu-04 / T-4qu-06): create the AES-256 key for media at rest, or
 * reuse the one that exists. It never overwrites a key, refuses to create one when data/media
 * already holds encrypted files, and never prints the key.
 *
 *   npm --prefix server run media-key     on the host: ~/.config/duet/media.key (MEDIA_KEY_FILE overrides)
 *
 * Run it before the first `docker compose up -d --build`: compose bind-mounts this file read-only
 * into the container and refuses to start while it is missing.
 */
import path from "node:path"
import { ConfigError, loadConfig } from "../src/config"
import { MediaKeyError, loadMediaKey } from "../src/media/crypto"

try {
  const config = loadConfig()
  const keyFile = config.MEDIA_KEY_FILE
  const { created, loosePermissions } = await loadMediaKey({ keyFile, mediaRoot: path.join(config.DATA_DIR, "media") })
  if (created) {
    console.log(`media-key: created ${keyFile} (mode 600)`)
    console.log(
      "media-key: back this file up off this machine (e.g. a password manager); without it every stored photo, video and voice note is unreadable",
    )
  } else {
    console.log(`media-key: reused ${keyFile}`)
  }
  if (loosePermissions) {
    console.warn(`media-key: warning: ${keyFile} is readable by group or others; run chmod 600 on it`)
  }
} catch (err) {
  if (err instanceof MediaKeyError || err instanceof ConfigError) {
    console.error(`media-key: ${err.message}`)
    process.exit(1)
  }
  throw err
}
