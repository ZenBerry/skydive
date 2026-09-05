// Run with Playwright available: NODE_PATH=/path/to/node_modules node tests/book-reader.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const paragraphs = Array.from({length: 75}, (_, i) => `<p>Paragraph ${i}. ${'John remembered the quiet room and the stories they had shared. '.repeat(i % 4 === 0 ? 32 : 5)}</p>`).join('');
const chapter = `<html><body><h1>A reader test</h1>${paragraphs}<h2>The final page</h2><p>THE END.</p></body></html>`;
const epub = execFileSync('python3', ['-c', `
import io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z:
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
 z.writestr('book.opf','<package><metadata><title>Reader regression</title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
 z.writestr('chapter.xhtml',sys.argv[1])
sys.stdout.buffer.write(b.getvalue())
`, chapter], {timeout: 10000});
(async () => {
 console.log('Launching browser');
 const browser = await chromium.launch({headless: true, channel: 'chrome'});
 console.log('Browser ready');
 const context = await browser.newContext({viewport: {width: 1440, height: 900}, ...(process.env.READER_VIDEO ? {recordVideo: {dir: process.env.READER_VIDEO, size: {width: 1440, height: 900}}} : {})});
 let session = {id: 1, src: 'http://reader.test/fixture.epub', name: 'Reader regression', position: {pageIndex: 0, progress: 0}, highlights: [], markHistory: []};
 const saves = [], requests = [], errors = [];
 await context.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url()); requests.push(url.pathname);
  if(url.hostname !== 'reader.test') return route.abort();
  if(url.pathname === '/api/books') {
   if(req.method() === 'POST') { const data = req.postDataJSON(); saves.push(data); session = {...session, ...data}; }
   return route.fulfill({json: {book: session}});
  }
  if(url.pathname === '/fixture.epub') return route.fulfill({body: epub, contentType: 'application/epub+zip'});
  if(url.pathname === '/mark') return route.fulfill({body: '<html><body>Mark test frame</body></html>', contentType:'text/html'});
  const file = url.pathname.startsWith('/book') ? 'book.html' : url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['book.html','index.html','assets/book-page-turn.js','assets/book-page-turn-fallback.js','assets/disable-native-zoom.js'].includes(file) && !file.startsWith('assets/vendor/')) return route.abort();
  return route.fulfill({body: fs.readFileSync(path.join(root, file)), contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript'});
 });
 const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
 const ready = () => page.waitForFunction(() => bookReady && pageCount > 5 && !turning);
 const state = () => page.evaluate(() => ({index: pageIndex, count: pageCount, offset: bookTextOffset, text: currentPageText(), scroll: pageElement.scrollTop}));
 console.log('Opening fixture');
 await page.goto('http://reader.test/book/1');
 await ready();
 assert.equal(await page.evaluate(() => Math.abs(document.querySelector('#reader').getBoundingClientRect().width - markFrame.getBoundingClientRect().width) < 2), true);
 // Every rendered line is inside its page, across the whole book, not a pixel scroll slice.
 const checkLines = async () => {
  const result = await page.evaluate(() => {
   const bounds = pageElement.getBoundingClientRect(); const bad = [];
   for (const node of textNodesInFlow()) {
    if(!node.data.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width && (r.top < bounds.top - .5 || r.bottom > bounds.bottom + .5)) bad.push({text:node.data.slice(0,40),top:r.top,bottom:r.bottom,bounds:{top:bounds.top,bottom:bounds.bottom}});
   }
   return {bad:bad.slice(0,5), height:pageElement.clientHeight, count:pageCount};
  });
  assert.deepEqual(result.bad, [], JSON.stringify(result));
 };
 await checkLines();
 const checkCoverage = async () => {
  const coverage = await page.evaluate(() => {
   const original = pageIndex, texts = [];
   for (pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    renderPage(); texts.push(currentPageText());
   }
   pageIndex = original; renderPage();
   return {actual: cleanText(texts.join(' ')), expected: cleanText(textNodesInFlow().map(n => n.data).join(' '))};
  });
  assert.equal(coverage.actual, coverage.expected, 'Pagination must neither skip nor duplicate text');
 };
 await checkCoverage();
 await page.waitForTimeout(400);
 await page.locator('#next').click();
 await page.locator('[data-book-peel]').waitFor({state:'attached',timeout:2500});
 await ready(); assert.equal((await state()).index, 1);
 await page.keyboard.press('ArrowRight'); await ready(); assert.equal((await state()).index, 2);
 await page.waitForTimeout(600); assert.equal(saves.at(-1).position.pageIndex, 2); assert.ok(saves.at(-1).position.textOffset > 0);
 const saved = (await state()).offset;
 await page.reload(); await ready(); assert.equal((await state()).offset, saved);
 // Dragging within text and shift-arrow selection must never navigate.
 await page.evaluate(() => {
  const part = visibleTextParts()[0], r = document.createRange();
  r.setStart(part.node, part.start); r.setEnd(part.node, Math.min(part.end,part.start+20));
  getSelection().removeAllRanges(); getSelection().addRange(r);
 });
 await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('ArrowRight'); assert.equal((await state()).index, 2);
 await page.evaluate(() => createHighlight('#fff3a3'));
 assert.ok(await page.locator('.epub-highlight').count());
 await page.waitForTimeout(600); assert.equal(saves.at(-1).highlights.length, 1);
 await page.reload(); await ready(); assert.ok(await page.locator('.epub-highlight').count());
 const pageBox = await page.locator('#page').boundingBox();
 await page.mouse.move(pageBox.x+30, pageBox.y+50); await page.mouse.down(); await page.mouse.move(pageBox.x+160, pageBox.y+90, {steps:12}); await page.mouse.up();
 assert.equal((await state()).index, 2);
 await page.evaluate(() => getSelection().removeAllRanges());
 // Wheel cannot scroll the book; only a margin swipe turns it.
 await page.mouse.wheel(0, 500); await page.waitForTimeout(100); assert.equal((await state()).scroll,0); assert.equal((await state()).index,2);
 const wrap = await page.locator('#page-wrap').boundingBox();
 await page.mouse.move(wrap.x+wrap.width-10,wrap.y+10); await page.mouse.down(); await page.mouse.move(wrap.x+wrap.width-100,wrap.y+12,{steps:12}); await page.mouse.up(); await ready(); assert.equal((await state()).index,3);
 const anchor = (await state()).offset;
 await page.setViewportSize({width: 1001,height: 760}); await page.waitForTimeout(350); await checkLines(); await checkCoverage();
 const containsAnchor = await page.evaluate(offset => visibleTextParts().some(p => p.offset <= offset && offset < p.offset+p.end-p.start), anchor); assert.ok(containsAnchor);
 await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(350); await checkLines(); await checkCoverage();
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(() => { pageIndex = pageCount - 2; renderPage(); rememberPageStart(); }); await page.locator('#next').click(); await ready();
 assert.ok((await state()).text.includes('THE END.')); assert.equal(await page.locator('#next').isDisabled(),true);
 await page.screenshot({path: '/tmp/reader-mobile.png'});
 await page.setViewportSize({width:1440,height:900}); await page.waitForTimeout(350);
 await page.evaluate(() => { pageIndex=0; renderPage(); rememberPageStart(); });
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.screenshot({path:'/tmp/reader-desktop.png'});
 await page.locator('#next').click(); await ready();
 assert.deepEqual(errors, []);
 const marker = requests.length;
 await page.goto('http://reader.test/'); await page.waitForTimeout(200);
 assert.equal(requests.slice(marker).some(url => /book-page-turn|vendor\/(canvas-ui-peel|html-to-image)/.test(url)), false);
 // Both unsupported GPU and failed DOM capture retain the previous CSS turn.
 for (const failure of ['gpu','capture']) {
  const fallback = await context.newPage();
  if (failure === 'gpu') await fallback.addInitScript(() => {
   const getContext=HTMLCanvasElement.prototype.getContext;
   HTMLCanvasElement.prototype.getContext=function(type,...args) { return type==='webgl2'?null:getContext.call(this,type,...args); };
  });
  else await fallback.route('**/vendor/html-to-image.js', route => route.abort());
  await fallback.goto('http://reader.test/book/1');
  await fallback.waitForFunction(() => bookReady && pageCount>5);
  const before = await fallback.evaluate(() => pageIndex);
  await fallback.locator('#next').click();
  await fallback.waitForFunction(() => pageElement.getAnimations().length>0);
  await fallback.waitForFunction(() => !turning);
  assert.equal(await fallback.evaluate(() => pageIndex),before+1);
  assert.equal(await fallback.locator('[data-book-peel]').count(),0);
  await fallback.close();
 }
 await context.close(); await browser.close();
 console.log('PASS: line bounds, controls, selection, margin swipe, wheel, highlights, saved position, resize, mobile, reduced motion, lazy loading');
})().catch(error => {console.error(error); process.exit(1);});
