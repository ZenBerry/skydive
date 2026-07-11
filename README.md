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
- `netlify/functions/` contains the persistence, auth, upload signing, Mark, agent API, and OpenClaw endpoints.
- `assets/` and `scripts/` hold small shared browser/runtime helpers.

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

## Configuration

Shared spaces need MongoDB:

```sh
MONGODB_URI=...
```

Optional variables used by specific features:

- `MONGODB_DB`, `MONGODB_COLLECTION`, `MONGODB_USERS_COLLECTION`, `MONGODB_USER_SESSIONS_COLLECTION`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_UPLOAD_FOLDER`
- `GEMINI_API_KEY`, `GEMMA_MODEL`, `GEMMA_FALLBACK_MODEL`
- `SKYDIVE_AGENT_AUTH_MODE`, `SKYDIVE_AGENT_TOKEN`
- `SKYDIVE_SESSION_SECONDS`, `SKYDIVE_SESSION_REFRESH_SECONDS`
- `SKYDIVE_OPENCLAW_*` and `OPENCLAW_*` for the OpenClaw bridge

Most of the app can be inspected as static files, but persistence, uploads, Mark, and the agent API depend on the Netlify Functions environment.

## Development notes

Keep changes small and dependency-light. This project favors direct browser APIs, simple data shapes, and backwards-compatible state changes over extra layers.

When changing app behavior for a commit, update `APP_VERSION` in `index.html`. When changing a command widget, also check whether its entry in `commands/registry.json` needs a version bump.

For quick validation, use the smallest check that exercises the touched path: syntax-check edited JavaScript, parse edited JSON, run `git diff --check`, and use Netlify Dev when function behavior matters.

## Deployment

Netlify publishes the repo root and serves functions from `netlify/functions`, as configured in `netlify.toml`. Route rewrites live in `_redirects`.
