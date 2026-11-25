// Run against a visible, isolated Fedora Tauri instance populated with fictitious files.
// Required: LYRA_DND_INSPECTOR_WS, LYRA_DND_WINDOW_ID, LYRA_DND_TEST_ROOT,
// LYRA_DND_SOURCE, LYRA_DND_TARGET, LYRA_DND_DESTINATION.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const required = name => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};
const inspectorUrl = required("LYRA_DND_INSPECTOR_WS");
const windowId = required("LYRA_DND_WINDOW_ID");
const root = required("LYRA_DND_TEST_ROOT");
const source = required("LYRA_DND_SOURCE");
const target = required("LYRA_DND_TARGET");
const destination = required("LYRA_DND_DESTINATION");
assert.match(windowId, /^(?:0x)?[0-9a-fA-F]+$/);
assert.ok(existsSync(join(root, source)), "fictitious source must exist before the gesture");
assert.ok(!existsSync(join(root, destination)), "destination must be empty before the gesture");

const socket = new globalThis.WebSocket(inspectorUrl);
let targetId;
let messageId = 1;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === "Target.targetCreated") targetId = message.params.targetInfo.targetId;
  if (message.method !== "Target.dispatchMessageFromTarget") return;
  const result = JSON.parse(message.params.message);
  pending.get(result.id)?.(result);
  pending.delete(result.id);
};
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
for (let attempt = 0; !targetId && attempt < 50; attempt++) await sleep(20);
assert.ok(targetId, "WebKit inspector target must be available");
async function evaluate(expression) {
  const id = messageId++;
  const response = new Promise(resolve => pending.set(id, resolve));
  socket.send(JSON.stringify({ id: messageId++, method: "Target.sendMessageToTarget", params: {
    targetId, message: JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }),
  } }));
  const result = await response;
  assert.ok(!result.result?.wasThrown, JSON.stringify(result.result));
  return result.result?.result?.value;
}

// Keep the isolated X11 window rendering while sampling WebKitGTK frames.
execFileSync("python3", ["-c", `from Xlib import display,X,protocol
D=display.Display(':0');r=D.screen().root;w=D.create_resource_object('window',${windowId});a=D.intern_atom('_NET_ACTIVE_WINDOW');r.send_event(protocol.event.ClientMessage(window=w,client_type=a,data=(32,[2,X.CurrentTime,0,0,0])),event_mask=X.SubstructureRedirectMask|X.SubstructureNotifyMask);D.sync()`]);
await sleep(120);
const sourceLiteral = JSON.stringify(source);
const targetLiteral = JSON.stringify(target);
try {
  const initial = await evaluate(`(() => {
    const container = document.getElementById('lyra-list-scroll-container');
    container.scrollTop = Number(${JSON.stringify(process.env.LYRA_DND_SCROLL_TOP ?? "900")});
    const source = [...document.querySelectorAll('[data-explorer-row-kind="file"]')].find(row => row.dataset.explorerPath === ${sourceLiteral});
    const target = [...document.querySelectorAll('[data-explorer-row-kind="file"]')].find(row => row.dataset.explorerPath === ${targetLiteral});
    if (!source || !target) return null;
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; };
    window.__tauriDndProbe = { source, calls:[], frames:[], running:true, errors:[] };
    window.addEventListener('error', event => window.__tauriDndProbe.errors.push(event.message));
    const originalAnimate = Element.prototype.animate;
    window.__tauriDndProbe.restoreAnimate = () => { Element.prototype.animate = originalAnimate; };
    Element.prototype.animate = function(keyframes, options) {
      if (this.hasAttribute?.('data-dnd-overlay')) window.__tauriDndProbe.calls.push({ keyframes, options,
        sourceConnected:source.isConnected, overlay:rect(this) });
      return originalAnimate.call(this, keyframes, options);
    };
    (function sample() {
      const overlay = document.querySelector('[data-dnd-overlay]');
      window.__tauriDndProbe.frames.push({ t:performance.now(), scrollTop:container.scrollTop,
        overlay:rect(overlay), list:rect(document.querySelector('[data-explorer-row-id]')?.parentElement),
        dropping:overlay?.hasAttribute('data-dnd-dropping') ?? false });
      if (window.__tauriDndProbe.running) requestAnimationFrame(sample);
    })();
    return { source:rect(source), target:rect(target), scrollTop:container.scrollTop };
  })()`);
  assert.ok(initial?.source && initial?.target, "both file rows must exist in the isolated Lyra window");
  const down = await evaluate(`(() => {
    document.body.setPointerCapture = () => {}; document.body.releasePointerCapture = () => {};
    const row = [...document.querySelectorAll('[data-explorer-row-kind="file"]')].find(node => node.dataset.explorerPath === ${sourceLiteral});
    const r = row.getBoundingClientRect(); const x=r.x+100, y=r.y+r.height/2;
    row.querySelector('li').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:31,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y}));
    return {x,y};
  })()`);
  assert.ok(down);
  await sleep(200);
  const move = `(() => {
    const row = [...document.querySelectorAll('[data-explorer-row-kind="file"]')].find(node => node.dataset.explorerPath === ${targetLiteral});
    const r = row.getBoundingClientRect(); const x=r.x+100, y=r.y+r.height/2;
    row.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:31,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:x,clientY:y}));
    window.__tauriDndProbe.pointer={x,y}; return {x,y};
  })()`;
  await evaluate(move);
  await sleep(120);
  await evaluate(move);
  await sleep(220);
  const releaseScroll = await evaluate("document.getElementById('lyra-list-scroll-container').scrollTop");
  await evaluate(`document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId:31,pointerType:'mouse',isPrimary:true,button:0,buttons:0,clientX:window.__tauriDndProbe.pointer.x,clientY:window.__tauriDndProbe.pointer.y})); 'released'`);
  await sleep(500);
  const data = JSON.parse(await evaluate("window.__tauriDndProbe.running=false; JSON.stringify({calls:window.__tauriDndProbe.calls,frames:window.__tauriDndProbe.frames,errors:window.__tauriDndProbe.errors,rows:[...document.querySelectorAll('[data-explorer-row-kind=file]')].map(row=>row.dataset.explorerPath)})"));
  assert.deepEqual(data.errors, [], "React must not report a commit error");
  assert.ok(existsSync(join(root, destination)) && !existsSync(join(root, source)), "physical and visual destination must agree");
  assert.equal(data.rows.filter(path => path === destination).length, 1, "destination row must be present exactly once");
  assert.ok(!data.rows.includes(source), "old row must be absent");
  assert.ok(data.calls.some(call => !call.sourceConnected), "the regression must exercise the detached source element");
  const visible = data.frames.filter(frame => frame.dropping && frame.overlay?.width > 0);
  assert.ok(visible.length, "the overlay placement must be visible");
  assert.ok(visible.every(frame => Math.abs(frame.overlay.x - frame.list.x) < 1
    && Math.abs(frame.overlay.width - frame.list.width) < 1), "no visible frame may shift left or shrink");
  assert.ok(visible.every(frame => frame.scrollTop === releaseScroll), "scrollTop must stay fixed after release");
  console.log(JSON.stringify({ source, destination, frames:visible.length, x:visible.map(frame => frame.overlay.x),
    width:visible.map(frame => frame.overlay.width), scrollTop:releaseScroll }));
} finally {
  await evaluate("window.__tauriDndProbe?.restoreAnimate?.(); if(window.__tauriDndProbe) window.__tauriDndProbe.running=false; delete document.body.setPointerCapture; delete document.body.releasePointerCapture; 'cleaned'").catch(() => undefined);
  socket.close();
}
