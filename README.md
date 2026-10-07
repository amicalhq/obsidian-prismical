# Prismical Sync

Sync selected Prismical note bodies with Markdown files in Obsidian, in both directions.

Desktop beta. Requires Obsidian 1.11.4 or later and a Prismical account with API access. Neither paid Obsidian Sync nor the Prismical desktop app is required. This is a source preview, not an available Community Store release. It requires compatible Prismical server support; do not treat a successful plugin build as confirmation that production sync is available.

## Features

- Choose **All notes** or one or more **Prismical folders**, optionally including subfolders. Newly created matching notes are imported automatically. Existing note-ID setups remain supported.
- Work is processed in batches of 50 notes, without a total-note cap. Large initial imports take multiple sync cycles; the status bar shows when work remains.
- Sync manually or every 60 seconds while Obsidian is open; also check on focus and reconnection, with at least 30 seconds between automatic runs. Manual sync bypasses that interval.
- Merge non-overlapping edits. Review overlapping changes and save both versions before resolving.
- Retain unsent edits and recover after interrupted writes or restarts.
- Rename and move linked files within the vault. Local deletion disconnects without deleting the remote note.
- Block uploads when unsupported content cannot be preserved safely.

## Install and connect

For a local build, follow the development commands below. Copy the contents of `dist/` to `<vault>/.obsidian/plugins/prismical-sync/`, then enable **Prismical Sync** in Obsidian's Community plugins settings.

1. Create an API key in Prismical's **Settings → API & MCP**.
2. Open the plugin settings and store/select the key through Obsidian SecretStorage.
3. Keep the API origin as `https://api.prismical.ai` unless using another trusted Prismical server.
4. Choose **All notes** or **Selected folders**, then click **Choose folders** to select one or more folders by name. Choose the Obsidian destination folder. A named top-level folder means only that folder and its selected subfolders; All notes also includes unfiled and shared notes.
5. Enable sync on this device and select **Sync now**.

Use **Review sync status and conflicts** to inspect conflicts or reconnect disconnected notes, including while sync is paused. Enable sync before applying a conflict resolution. Conflict backups are saved in the vault root for easy recovery. Preserve the identity frontmatter; duplicate linked IDs pause that note's sync. Malformed YAML or missing identity properties in an existing linked file pause that note without discarding its baseline. Repair the properties to resume; reconnecting is not necessary.

## Discovery and selection changes

The plugin checks changed-note metadata each sync and performs a complete paginated metadata reconciliation approximately every 15 minutes. It downloads full bodies for queued changes and locally edited notes. Folder moves, deletions and access changes can take until reconciliation to be reflected. Large inventories and imports span multiple cycles; interrupted work resumes from device-local checkpoints. Rate limits pause work and retain the queue.

Leaving a selection, trashing a remote note, or losing access never deletes your local Markdown or erases its baseline. Sync pauses for that note. Bringing it back into scope resumes reconciliation; explicitly disconnected notes stay disconnected until you reconnect them. Metadata is read for accessible notes to detect moves out of selected folders; only in-scope note bodies are synchronized. This is eventual synchronization, not an instantaneous snapshot of the workspace.

Existing installations keep their note-ID selection when upgrading. New installations default to All notes but stay paused until you enable syncing. Folder structure is not mirrored into Obsidian: imported files use the configured destination, and local moves/renames remain respected.

## Beta limitations

Enable only one connector device per shared vault. Obsidian must be open. Mobile, tags, title updates, transcripts, attachments, and creation of new Prismical notes from local files are not supported yet.

Ordinary Markdown is supported. Unsupported rich content, Obsidian-specific syntax and reference-style link definitions may block uploads to avoid data loss. **Lossless concurrent editing is not guaranteed.** Deleting a paragraph in one client can hide edits made inside it on another client that has not synchronized yet. Avoid editing the same note simultaneously across Prismical and Obsidian during this beta. This is periodic synchronization, not a shared live editor. Edits on adjacent lines (including list items and table rows) may require conflict review even if they look independent. If a write succeeds but its response is lost and the server reformats the Markdown, the plugin cannot reliably distinguish that write from another edit; it preserves both versions for review. Notes with unsaved edits in an open Markdown editor wait until those edits are saved before syncing. Recovery without a saved baseline conservatively asks for conflict review.

## Data and permissions

The plugin sends authentication and selected note content to the configured Prismical API over HTTPS. An API key retains its account/workspace permissions; selecting folders or notes does not narrow the key's permissions on the server. Only configure an API server you trust.

Keys are stored through Obsidian SecretStorage, not in shared plugin settings. SecretStorage is not a guarantee of OS-keychain encryption. Device-local IndexedDB stores sync baselines and pending/conflict content; linked Markdown files and conflict backups live in your vault. Selection mode, Prismical folder IDs, legacy note IDs, destination folder, API origin and the secret reference are saved in plugin settings. The plugin adds no client-side analytics and does not log note contents or API keys. Server-side request diagnostics are described below. Disabling or disconnecting sync does not erase existing Markdown files, conflict backups, stored checkpoints, or saved secrets.

## Development

Requires Node.js 22.14 or later and npm 11 or later. No other Prismical repository is needed.

```sh
npm ci
npm test
npm run type:check
npm run build
```

Tests use synthetic notes, a fake IndexedDB implementation, and a minimal Obsidian API test double. They do not replace acceptance testing inside Obsidian. They do not contact Prismical. Real-account acceptance requires a compatible server and a disposable vault.

## Releases

Keep `package.json` and `manifest.json` versions aligned. Update `versions.json` when adding releases. Build and attach `dist/main.js`, `dist/manifest.json`, `dist/LICENSE` and `dist/THIRD-PARTY-NOTICES.md` to a GitHub release whose tag exactly matches the plugin version. Publishing and community directory submission are separate steps; building does not publish anything.

See [Obsidian's publishing instructions](https://docs.obsidian.md/plugins/releasing/submit-plugin).

## Server-side diagnostics

Normal sync requests identify this plugin and its version and include a temporary sync-run ID. Prismical records server-side request outcomes, timing, request IDs, note IDs and authenticated account identifiers (including email) for usage measurement and troubleshooting. These sync diagnostics do not log note bodies, titles, vault paths or API keys. There is no client-side analytics SDK or separate telemetry upload. Server logs cannot confirm that a local file was written successfully. See the [Prismical privacy policy](https://prismical.ai/privacy) for data handling.

## License

MIT. See [LICENSE](LICENSE). The bundled node-diff3 dependency is MIT-licensed; its copyright and license are preserved in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
