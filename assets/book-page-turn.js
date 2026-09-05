// Reader-only: imported by book.html, never by the canvas or command loader.
// Animate the live paper so selection, EPUB styles and highlights stay intact.
export async function turnPage(page, direction, commit) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !page.animate) {
    commit();
    return;
  }
  const forward = direction > 0;
  const oldOrigin = page.style.transformOrigin;
  const oldEvents = page.style.pointerEvents;
  page.style.transformOrigin = forward ? "left center" : "right center";
  page.style.pointerEvents = "none";
  const fold = forward ? -1 : 1;
  let animation;
  let committed = false;
  try {
    animation = page.animate([
      { transform: "rotateY(0deg) skewY(0deg)", filter: "brightness(1)", boxShadow: "0 0 0 #0000" },
      { transform: `rotateY(${fold * 38}deg) skewY(${fold * 2}deg)`, filter: "brightness(.97)", boxShadow: `${-fold * 16}px 6px 24px #0002`, offset: 0.65 },
      { transform: `rotateY(${fold * 90}deg) skewY(${fold * 5}deg)`, filter: "brightness(.88)", boxShadow: `${-fold * 32}px 8px 32px #0003` }
    ], { duration: 210, easing: "ease-in", fill: "forwards" });
    await animation.finished;
    animation.cancel();
    commit();
    committed = true;
    page.style.transformOrigin = forward ? "right center" : "left center";
    animation = page.animate([
      { transform: `rotateY(${-fold * 88}deg) skewY(${-fold * 3}deg)`, filter: "brightness(.9)", boxShadow: `${fold * 24}px 5px 28px #0002` },
      { transform: `rotateY(${-fold * 20}deg) skewY(${-fold}deg)`, filter: "brightness(.99)", offset: 0.55 },
      { transform: "rotateY(0deg) skewY(0deg)", filter: "brightness(1)", boxShadow: "0 0 0 #0000" }
    ], { duration: 250, easing: "ease-out" });
    await animation.finished;
  } catch (error) {
    if (!committed) commit();
  } finally {
    animation?.cancel();
    page.style.transformOrigin = oldOrigin;
    page.style.pointerEvents = oldEvents;
  }
}
