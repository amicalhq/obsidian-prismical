# Prismical Sync

Sync selected Prismical note bodies with Markdown files in Obsidian, in both directions.

Desktop beta. Requires Obsidian 1.11.4 or later and a Prismical account with API access. Neither paid Obsidian Sync nor the Prismical desktop app is required. This is a source preview, not an available Community Store release. It requires compatible Prismical server support; do not treat a successful plugin build as confirmation that production sync is available.

## Features

- Connect up to 50 existing notes using their Prismical note IDs.
- Sync manually or every 60 seconds while Obsidian is open; also check on focus and reconnection.
- Merge non-overlapping edits. Review overlapping changes and save both versions before resolving.
- Retain unsent edits and recover after interrupted writes or restarts.
- Rename and move linked files within the vault. Local deletion disconnects without deleting the remote note.
- Block uploads when unsupported content cannot be preserved safely.

## Install and connect

For a local build, follow the development commands below. Copy the contents of `dist/` to `<vault>/.obsidian/plugins/prismical-sync/`, then enable **Prismical Sync** in Obsidian's Community plugins settings.

1. Create an API key in Prismical's **Settings → API & MCP**.
2. Open the plugin settings and store/select the key through Obsidian SecretStorage.
3. Keep the API origin as `https://api.prismical.ai` unless using another trusted Prismical server.
4. Paste note IDs from Prismical note URLs, separated by commas or newlines, and choose a destination folder.
5. Enable sync on this device and select **Sync now**.

Use **Review sync status and conflicts** to resolve conflicts or reconnect disconnected notes. Preserve the identity frontmatter; duplicate linked IDs pause that note's sync.

## Beta limitations

Enable only one connector device per shared vault. Obsidian must be open. Mobile, tags, title updates, transcripts, attachments, and creation of new Prismical notes from local files are not supported yet.

Ordinary Markdown is supported. Unsupported rich content, Obsidian-specific syntax and reference-style link definitions may block uploads to avoid data loss. Concurrent edits can require manual cleanup; this is periodic synchronization, not a shared live editor. Recovery without a saved baseline conservatively asks for conflict review.

## Data and permissions

The plugin sends authentication and selected note content to the configured Prismical API over HTTPS. An API key retains its account/workspace permissions; selecting note IDs does not narrow the key's permissions on the server. Only configure an API server you trust.

Keys are stored through Obsidian SecretStorage, not in shared plugin settings. SecretStorage is not a guarantee of OS-keychain encryption. Device-local IndexedDB stores sync baselines and pending/conflict content; linked Markdown files and conflict backups live in your vault. Note IDs, destination folder, API origin and the secret reference are saved in plugin settings. The plugin adds no analytics and does not log note contents or API keys. Disabling or disconnecting sync does not erase existing Markdown files, conflict backups, stored checkpoints, or saved secrets.

## Development

Requires Node.js 22.14 or later and npm 11 or later. No other Prismical repository is needed.

```sh
npm ci
npm test
npm run type:check
npm run build
```

Tests use synthetic notes and a fake IndexedDB implementation. They do not contact Prismical. Real-account acceptance requires a compatible server and a disposable vault.

## Releases

Keep `package.json` and `manifest.json` versions aligned. Update `versions.json` when adding releases. Build and attach `dist/main.js`, `dist/manifest.json`, `dist/LICENSE` and `dist/THIRD-PARTY-NOTICES.md` to a GitHub release whose tag exactly matches the plugin version. Publishing and community directory submission are separate steps; building does not publish anything.

See [Obsidian's publishing instructions](https://docs.obsidian.md/plugins/releasing/submit-plugin).

## License

MIT. See [LICENSE](LICENSE). The bundled node-diff3 dependency is MIT-licensed; its copyright and license are preserved in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
