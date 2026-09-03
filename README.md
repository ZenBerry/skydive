# Skydive

Skydive is a small shared canvas app for thinking in space. Its main idea is to be a zoomable user interface (ZUI) with no practical limit on canvas size or zoom, so people can keep moving between tiny details and huge maps of thought.

It lets people create text nodes, connect ideas, upload files, use tiny persistent widgets, and keep spaces synced through a lightweight Netlify + MongoDB backend.

The repo is intentionally plain: mostly static HTML, handwritten browser JavaScript, a few command modules, and Netlify Functions. There is no frontend build step.

## What is here

- `index.html` is the main Skydive canvas.
- `mark.html` is Mark, the built-in assistant UI for chatting and working with Skydive spaces.
- `agents.html` documents the JSON agent API for external tools.
- `book.html` is the isolated EPUB reader route.
- `commands/` contains static slash-command widgets such as stopwatch, timer, file upload, recorder, Delorean, and today.
- `netlify/functions/` contains the persistence, auth, upload signing, Mark, and agent API endpoints.
- `assets/` holds small shared browser helpers and mobile UI images.

## Local development

Install dependencies:

```sh
npm install
```

Start Netlify Dev:

```sh
npm run dev
```

The app normally runs at:

```text
http://localhost:8888
```

Useful local routes:

- `/` main canvas
- `/mark` Mark assistant
- `/agents` agent API docs
- `/book/...` EPUB reader
- `/api/agent?manifest=1` machine-readable agent manifest

## User accounts

Users are created through Mark rather than a separate signup page. Open `/mark` and ask to register, sign up, or create an account. Mark asks for a nickname, creates the user, logs them in, and then offers an optional password using hidden input.

Logged-in users are stored in MongoDB-backed sessions and are used to attribute newly created nodes.

## Canvas features

Skydive is built around a few direct primitives:

- Text nodes: editable blocks that can be moved, resized, selected, linked, and styled.
- Natural lines: right-click a node, choose `Line`, then connect it to another node.
- Math lines: right-click a line and mark it as `+`, `-`, `*`, `÷`, or `=`. Number nodes can form small calculation chains, and `=` writes the result into its target node.
- Internal links: copy a node ID, select text inside another node, then link that selection to the target node.
- Files: drag files onto the canvas to upload them. File widgets can open, download, preview images, and send EPUBs to the separate reader.
- Audio: drop audio files or use `/rec` to record a voice note with playback, speed, loop, and download controls.
- Widgets: slash commands create persistent nodes for stopwatch, timer, file, recorder, Delorean time-travel spaces, and today's date.
- Mark: `/mark` can chat, manage accounts, list/read spaces, and apply supported Skydive edits through the agent API.
- Agent API: `/agents` documents the JSON API for external tools that need to inspect or edit spaces safely.

## Using the app

Open `/` for a local-only canvas, or open any path such as `/research/ideas` to create/read that shared space. Named spaces autosave through MongoDB and poll for remote updates.

Basic canvas controls:

- Double-click empty canvas space to create a text node.
- Drag the canvas to pan; use the wheel/trackpad to move around.
- Use `Ctrl`/`Cmd` + wheel or pinch gestures to zoom.
- Use `Alt` + wheel to rotate the canvas.
- Drag files onto the canvas to create upload widgets.
- Type `/` inside a text node to search and insert commands.

Keyboard shortcuts:


- Number keys `1` to `9` resize selected nodes.
- `=` aligns selected nodes into a column.
- `Shift` + `Enter` creates a new line.
- `Ctrl`/`Cmd` + `S` exports a `.mind.json` file.
- `Ctrl`/`Cmd` + `O` imports a saved `.mind.json` file.
- `Ctrl`/`Cmd` + `Z` undo; `Ctrl`/`Cmd` + `Y` or `Ctrl`/`Cmd` + `Shift` + `Z` redo.
- `Delete` or `Shift` + `Backspace` deletes selected nodes.
- `Tab` toggles the app version counter.


Context menus:

- Node menu: copy node ID, hook the node to the browser title, start a line, link selected text to another node ID, and recolor widgets.
- Line menu: choose a math operation or delete the line.
- Canvas menu: use Bird's eye view to zoom out to the whole space.

## Configuration

Shared spaces need MongoDB:

```sh
MONGODB_URI=...
```

Optional variables used by specific features:

- `MONGODB_DB`, `MONGODB_COLLECTION`, `MONGODB_USERS_COLLECTION`, `MONGODB_USER_SESSIONS_COLLECTION`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_FOLDER`
- `GEMINI_API_KEY`, `GEMMA_MODEL`, `GEMMA_FALLBACK_MODEL`
- `SUPABASE_URL` with `SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_ANON_KEY` enables Supabase Realtime fanout for shared-space saves; MongoDB remains the source of truth.
- `SKYDIVE_AGENT_AUTH_MODE`, `SKYDIVE_AGENT_TOKEN`
- `SKYDIVE_SESSION_SECONDS`, `SKYDIVE_SESSION_REFRESH_SECONDS`
Most of the app can be inspected as static files, but persistence, uploads, Mark, and the agent API depend on the Netlify Functions environment.

## Development notes

Keep changes small and dependency-light. This project favors direct browser APIs, simple data shapes, and backwards-compatible state changes over extra layers.

When changing app behavior for a commit, update `APP_VERSION` in `index.html`. When changing a command widget, also check whether its entry in `commands/registry.json` needs a version bump.

For quick validation, use the smallest check that exercises the touched path: syntax-check edited JavaScript, parse edited JSON, run `git diff --check`, and use Netlify Dev when function behavior matters.

## Deployment

Netlify publishes the repo root and serves functions from `netlify/functions`, as configured in `netlify.toml`. Route rewrites live in `_redirects`.
