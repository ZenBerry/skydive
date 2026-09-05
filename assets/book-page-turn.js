// All imports belong exclusively to /book. The canvas never requests these files.
import { createPeel } from './vendor/canvas-ui-peel.js';
import { turnPage as fallbackTurn } from './book-page-turn-fallback.js';

let captureLibrary;
let fontCSS;
const pages = new WeakMap();
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function stateFor(page) {
  if (!pages.has(page)) pages.set(page,{revision:0, snapshot:null, timer:0, renderer:null, output:null});
  return pages.get(page);
}
function captureSurface(page) {
  const box=page.getBoundingClientRect();
  const flow=page.querySelector('#book-flow');
  const chapters=flow ? Array.from(flow.children) : [];
  const visible=chapters.filter(chapter => Array.from(chapter.getClientRects()).some(r =>
    r.right>box.left && r.left<box.right && r.bottom>box.top && r.top<box.bottom));
  if(!flow || !visible.length) return {surface:page,remove:()=>{}};
  const flowBox=flow.getBoundingClientRect(), first=visible[0].getClientRects()[0];
  const stride=parseFloat(getComputedStyle(flow).columnWidth)+48;
  const column=Math.max(0,Math.floor((first.left-flowBox.left+1)/stride));
  const leading=column*parseFloat(getComputedStyle(flow).height)+first.top-flowBox.top;
  const host=document.createElement('div');
  host.setAttribute('aria-hidden','true'); host.inert=true;
  Object.assign(host.style,{position:'fixed',left:'-100000px',top:'0',width:`${box.width}px`,height:`${box.height}px`,pointerEvents:'none'});
  const surface=page.cloneNode(false), copy=flow.cloneNode(false);
  Object.assign(surface.style,{width:`${box.width}px`,height:`${box.height}px`});
  const spacer=document.createElement('div');
  Object.assign(spacer.style,{height:`${Math.max(0,leading)}px`,margin:'0',padding:'0',breakInside:'auto'});
  copy.append(spacer);
  for(const chapter of visible) {
    const clone=chapter.cloneNode(true);
    clone.querySelectorAll('style').forEach(node=>{ node.textContent=''; });
    clone.querySelectorAll('script').forEach(node=>node.remove());
    copy.append(clone);
  }
  surface.append(copy); host.append(surface); document.body.append(host);
  return {surface,remove:()=>host.remove()};
}
async function capture(page) {
  captureLibrary ||= import('./vendor/html-to-image.js').then(() => globalThis.htmlToImage);
  const library=await captureLibrary;
  // Embed the same fonts once; the SVG capture must not substitute different metrics.
  fontCSS ||= library.getFontEmbedCSS(page, {preferredFontFormat:'woff2'}).catch(() => '');
  const fonts=await fontCSS;
  const {surface,remove}=captureSurface(page);
  try {
    return await library.toCanvas(surface, {
      width:parseFloat(getComputedStyle(page).width), height:parseFloat(getComputedStyle(page).height),
      pixelRatio:Math.min(devicePixelRatio||1,2), backgroundColor:'#fff', fontEmbedCSS:fonts,
      filter:node => !['STYLE','SCRIPT'].includes(node.tagName)
    });
  } finally { remove(); }
}
function snapshotFor(page, state) {
  if (!state.snapshot) state.snapshot=capture(page).catch(() => null);
  return state.snapshot;
}
export function preparePage(page) {
  const state=stateFor(page);
  state.revision++;
  state.snapshot=null;
  clearTimeout(state.timer);
  if(reducedMotion() || document.hidden || state.inTurn) return;
  // One bounded preparation after a page/layout/highlight change; no polling.
  state.timer=setTimeout(() => { if (!document.hidden) void snapshotFor(page,state); },120);
}
function bounded(promise, ms) {
  let timer;
  return Promise.race([promise,new Promise(resolve => { timer=setTimeout(() => resolve(null),ms); })]).finally(() => clearTimeout(timer));
}
function createStaticPageCover(page,box,wrap) {
  const cover=page.cloneNode(true);
  cover.setAttribute('aria-hidden','true'); cover.inert=true;
  Object.assign(cover.style,{
    position:'absolute',left:`${box.left-wrap.left}px`,top:`${box.top-wrap.top}px`,
    width:`${box.width}px`,height:`${box.height}px`,margin:'0',pointerEvents:'none',
    zIndex:'1',clipPath:'inset(0 0 0 0)',userSelect:'none'
  });
  return cover;
}
function setStaticPageCoverProgress(cover,direction,progress) {
  const amount=`${Math.min(100,Math.max(0,progress*100)).toFixed(3)}%`;
  cover.style.clipPath=direction>0?`inset(0 ${amount} 0 0)`:`inset(0 0 0 ${amount})`;
}
export async function turnPage(page,direction,commit) {
  if(reducedMotion()) { commit(); return; }
  const state=stateFor(page), revision=state.revision;
  let committed=false;
  let cover=null;
  state.inTurn=true;
  clearTimeout(state.timer);
  try {
    const snapshot=await bounded(snapshotFor(page,state),1000);
    if(!snapshot || revision!==state.revision) throw new Error('Page capture unavailable');
    if(!state.renderer) {
      const output=document.createElement('canvas');
      output.setAttribute('aria-hidden','true'); output.dataset.bookPeel='';
      state.renderer=createPeel(output); state.output=output;
    }
    const box=page.getBoundingClientRect(), wrap=page.parentElement.getBoundingClientRect();
    const output=state.output;
    Object.assign(output.style,{position:'absolute',left:`${box.left-wrap.left}px`,top:`${box.top-wrap.top}px`,width:`${box.width}px`,height:`${box.height}px`,pointerEvents:'none',zIndex:'2'});
    state.renderer.setPage(snapshot,box.width,box.height,direction);
    state.renderer.render(0);
    cover=createStaticPageCover(page,box,wrap);
    page.parentElement.append(cover,output);
    commit(); committed=true;
    await new Promise((resolve,reject) => {
      const start=performance.now();
      function frame(now) {
        try {
          const resized=Math.abs(page.clientWidth-box.width)>1 || Math.abs(page.clientHeight-box.height)>1;
          const t=document.hidden || reducedMotion() || resized?1:Math.min(1,(now-start)/620);
          const eased=t*t*(3-2*t);
          setStaticPageCoverProgress(cover,direction,eased*1.37);
          state.renderer.render(eased);
          if(t<1) requestAnimationFrame(frame); else resolve();
        } catch(error) { reject(error); }
      }
      requestAnimationFrame(frame);
    });
  } catch(error) {
    state.output?.remove();
    state.renderer?.destroy(); state.renderer=null; state.output=null;
    if(!committed) await fallbackTurn(page,direction,commit);
  } finally {
    cover?.remove();
    state.output?.remove();
    state.inTurn=false;
    preparePage(page);
  }
}
