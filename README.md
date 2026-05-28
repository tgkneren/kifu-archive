# Reusable Goban Component

This is a framework-neutral SGF recorder/editor and mobile-friendly Go board. The current product direction is simple: record or import a Go game, save/export SGF, optionally publish a public archive record, and share its link. Opening a public game creates an editable local study copy; viewer edits never mutate the original public record.

```html
<script type="module" src="./goban-board.js"></script>
<goban-board size="19"></goban-board>
```

## API

- `size`: board size attribute. Defaults to `19`.
- `disabled`: disables placement and fades the board.
- `setStone(x, y, color)`: place a `black` or `white` stone.
- `clearStone(x, y)`: remove one stone.
- `clear()`: remove all stones.
- `setStones([{ x, y, color }])`: replace the board position.
- `getStones()`: read all stones as `{ x, y, color }`.
- `getPrisoners()`: read captured-stone totals as `{ black, white }`.
- `setCurrentColor(color)`: set the automatic placement color.
- `canUndo()`: returns whether there is a move to undo.
- `undo()`: restores stones, prisoner totals, and turn color to the previous move state.
- `canRedo()`: returns whether the current move has child variations.
- `getVariations()`: lists playable child branches from the current node.
- `playVariation(index)`: restores one child branch from the current node.
- `toSGF()`: exports the full game tree, including branches, as SGF text.
- `loadSGF(text)`: imports an SGF game tree and restores metadata, moves, captures, and variations.
- `setMetadata({ blackName, whiteName, event, gameName })`: sets SGF root metadata.
- `getMetadata()`: reads the current SGF metadata.

The component emits `goban-place` before placing a stone. Call `event.preventDefault()` inside that listener if your app wants to validate moves or manage state externally.

```js
board.addEventListener("goban-place", (event) => {
  const { x, y, color } = event.detail;
});
```

After a legal move, it removes any opponent groups with no liberties, updates prisoner totals, and emits `goban-update`:

```js
board.addEventListener("goban-update", (event) => {
  const { captured, prisoners, nextColor } = event.detail;
});
```

Suicide moves and immediate ko recaptures are rejected and emit `goban-illegal`.

The board also draws coordinates by default on all four sides, using Go-style letters that skip `I`; numbers run from `1` at the bottom to `19` at the top.
On touch screens, pressing shows a red target square, dragging moves that target, and releasing places the stone. Double-tapping zooms the board around the tapped area.

## Run locally

```sh
node server.mjs
```

The server defaults to `0.0.0.0:4174`. To use another port:

```sh
PORT=4173 node server.mjs
```

On Windows PowerShell:

```powershell
$env:PORT="4173"; node server.mjs
```

## Tests

```sh
node --test goban-board.test.mjs
```

## Public archive API

The editor can run as a static PWA for local SGF recording, import/export, autosave, settings, local archive previews, public game viewing, and public archive browsing. Public archive publishing needs Google sign-in through Supabase Auth so ownership survives browser cache clears and device changes.

By default the backend stores public records in `archive-data.json` for local development. In production, set these environment variables to use Supabase Postgres instead:

```sh
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY` in the browser or static frontend. It belongs only in the Node backend environment. Run `supabase-schema.sql` once in the Supabase SQL editor before enabling the Supabase-backed archive.
Enable Google as a Supabase Auth provider and add the deployed KifuArchive URL as an allowed redirect URL.

Current endpoints:

- `POST /api/archive/public-games`: publish an SGF. Requires a Google-authenticated Supabase access token. The backend stores `owner_user_id`, creates a `publicId`, checks duplicate SGF hashes, and keeps the user's email private.
- `GET /api/archive/public-games`: list public SGF records.
- `GET /api/archive/public-games/:publicId`: load one public SGF record.
- `DELETE /api/archive/public-games/:publicId`: unpublish only when the authenticated Google user owns the record.
- `GET /api/archive/auth-config`: public frontend config for starting Google OAuth.
- `GET /api/archive/me`: validates the current Supabase access token.
- `GET /g/:publicId`: share link for a public SGF. The app opens it as an editable local study copy.

There is no app-wide login requirement, follow, like, chat, notification, or profile model. Google sign-in is only for publishing and managing public records. `owner_handle` / `recorderNickname` is a public display label and is not used for authentication.

Public beta safeguards:

- Publish requests are limited to 512 KB request bodies.
- Public SGF content is limited to 300 KB.
- Publish requests are rate-limited per IP in memory.
- Duplicate public SGF content is rejected server-side and returns the existing public record.
- API requests are network-only in the service worker.
- Share pages under `/g/:publicId` are served from the network first and fall back to the cached app shell when offline.

## Persistence note

`archive-data.json` is acceptable for local development or a single-server prototype, and writes are done through a temporary file rename to reduce corruption risk. It is still not ideal production storage: concurrent writes, backups, migrations, and durability are limited. For a real public archive, Supabase is a good fit because it is a hosted product built on Postgres; in practice, choosing Supabase means using managed Postgres plus auth/storage/API tooling around it. SQLite on a persistent volume, direct Postgres, Turso, or Supabase are deployment choices at the persistence layer, not features the editor itself depends on.

Do not deploy local tunnel binaries or logs. Keep files such as `cloudflared.exe`, `localtunnel-output.log`, `localtunnel-error.log`, `server-output.log`, and `server-error.log` out of production artifacts.

## Deploy shape

- Static deploy only: editor, PWA shell, local autosave, local SGF import/export.
- Node backend deploy: public archive list, publish, share links, and owner-token unpublish.

## Vercel + Supabase deploy

This repo is prepared for Vercel:

- Static PWA files are served from the project root.
- Serverless API functions live under `api/archive/public-games`.
- `vercel.json` rewrites `/g/:publicId` to `index.html` so shared game links work on direct open and refresh.
- `.vercelignore` keeps local `.env`, logs, tunnel files, and JSON prototype storage out of the deployment.

Set these Vercel environment variables before deploying:

```sh
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```

Optional:

```sh
SUPABASE_PUBLIC_GAMES_TABLE="public_games"
```

Run `supabase-schema.sql` in the Supabase SQL editor before using the public archive. The service role key must stay server-side in Vercel env vars; do not put it in `index.html`, `goban-board.js`, or any browser-visible file.

Suggested Vercel project settings:

- Framework preset: Other
- Build command: empty / none
- Output directory: project root
- Install command: empty / none
