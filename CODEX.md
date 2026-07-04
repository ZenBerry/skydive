# Codex Notes

- 2026-07-04: Added a persistent `titleHook.nodeId` space-state field. Right-clicking any node and choosing "Hook node to window title" makes that node own `document.title`; text nodes use their live text, calc variables update through the existing calc path, and command widgets can expose `getTitle(state)` for cleaner dynamic tab titles. Timer and stopwatch titles refresh once per second.
