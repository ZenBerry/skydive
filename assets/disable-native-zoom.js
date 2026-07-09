(function disableNativeZoom() {
  const viewportContent = [
    "width=device-width",
    "initial-scale=1",
    "minimum-scale=1",
    "maximum-scale=1",
    "user-scalable=no",
    "viewport-fit=cover"
  ].join(", ");

  const viewport = document.querySelector('meta[name="viewport"]') || document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = viewportContent;
  if (!viewport.parentNode) document.head.append(viewport);

  const style = document.createElement("style");
  style.textContent = "html,body{touch-action:manipulation;}";
  document.head.append(style);

  const isZoomShortcut = (event) => {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    return (
      key === "+" ||
      key === "-" ||
      key === "=" ||
      key === "_" ||
      key === "0" ||
      code === "Equal" ||
      code === "Minus" ||
      code === "NumpadAdd" ||
      code === "NumpadSubtract" ||
      code === "Numpad0"
    );
  };

  window.addEventListener("keydown", (event) => {
    if (!isZoomShortcut(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });

  window.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
  }, { capture: true, passive: false });

  window.addEventListener("dblclick", (event) => {
    event.preventDefault();
  }, { capture: true });

  ["gesturestart", "gesturechange", "gestureend", "gesturecancel"].forEach((type) => {
    window.addEventListener(type, (event) => {
      event.preventDefault();
    }, { capture: true, passive: false });
  });
}());
