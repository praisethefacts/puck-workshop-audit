import { writeFile } from "node:fs/promises";

const endpoint = process.argv[2];
const url = process.argv[3];
const out = process.argv[4];
const viewportWidth = Number(process.argv[5] || 390);
const isMobile = process.argv[6] !== "desktop";
const list = await (await fetch(`${endpoint}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("127.0.0.1:3312") && t.title.includes("Puck Workshop")) || list.find((t) => t.type === "page" && t.url.includes("127.0.0.1:3312")) || list.find((t) => t.type === "page");
if (!page) throw new Error("No page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: viewportWidth, height: 844, deviceScaleFactor: isMobile ? 2 : 1, mobile: isMobile
});
await send("Page.navigate", { url });
await new Promise((resolve) => setTimeout(resolve, 1200));
const metrics = await send("Runtime.evaluate", {
  expression: `(() => {
    const vw = visualViewport.width;
    const wide = [...document.querySelectorAll('body *')].filter((el) => !el.closest('.table-scroll')).map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: String(el.className).slice(0, 80), text: String(el.textContent).trim().slice(0, 50), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
    }).filter((r) => r.right > vw + 1 || r.left < -1 || r.width > vw + 1).slice(0, 25);
    const wrap = document.querySelector('.table-scroll');
    const chain = [];
    for (let el = wrap; el; el = el.parentElement) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      chain.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), left: Math.round(r.left), width: Math.round(r.width), right: Math.round(r.right), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: cs.overflowX });
    }
    const scrollCulprits = [...document.querySelectorAll('body *')].filter((el) => !el.closest('.table-scroll')).map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { tag: el.tagName, cls: String(el.className).slice(0, 50), left: Math.round(r.left), width: Math.round(r.width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: cs.overflowX };
    }).filter((r) => r.scrollWidth > r.clientWidth + 1 && r.overflowX === 'visible').slice(0, 20);
    const shellKids = [...document.querySelector('.page-enter').children].map((el) => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, cls: String(el.className).slice(0, 50), width: Math.round(r.width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    });
    return { innerWidth, outerWidth, visualViewport: vw, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, top: document.querySelector('.hero')?.getBoundingClientRect().height, anim: getComputedStyle(document.querySelector('.page-enter')).opacity, wide, chain, scrollCulprits, shellKids };
  })()`,
  returnByValue: true
});
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await writeFile(out, Buffer.from(shot.data, "base64"));
console.log(metrics.result.value ?? metrics.result.exceptionDetails ?? metrics.result);
await send("Emulation.clearDeviceMetricsOverride");
ws.close();
