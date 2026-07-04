# Codex Notes

- 2026-07-04: Added a mobile toolbar delete button for selected nodes. It reuses the existing soft-delete/autosave/history path, disables itself when the mobile selection is empty, and bumps `APP_VERSION` to 87.
- 2026-07-04: Added a persistent `titleHook.nodeId` space-state field. Right-clicking any node and choosing "Hook node to window title" makes that node own `document.title`; text nodes use their live text, calc variables update through the existing calc path, and command widgets can expose `getTitle(state)` for cleaner dynamic tab titles. Timer and stopwatch titles refresh once per second.
- 2026-07-04: Moved title-hook refresh onto a tiny Worker-backed ticker, with interval fallback and visibility/focus catch-up, so hooked timers keep updating the tab title while Skydive is inactive.
