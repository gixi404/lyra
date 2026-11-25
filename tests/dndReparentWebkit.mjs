import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const site = process.env.LYRA_DND_TEST_SITE ?? "http://127.0.0.1:1420";
const driver = process.env.LYRA_DND_TEST_DRIVER ?? "http://127.0.0.1:9519";
const browser = process.env.LYRA_DND_TEST_BROWSER ?? "/usr/libexec/webkit2gtk-4.1/MiniBrowser";
const children = [];
const only = process.env.LYRA_DND_TEST_ONLY;
const directory = path => path.slice(0, Math.max(0, path.lastIndexOf("/")));

async function ready(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await globalThis.fetch(url)).ok) return; } catch { /* Service is starting. */ }
    await sleep(100);
  }
  throw new Error(`Service did not start: ${url}`);
}

async function request(path, method = "GET", data) {
  const response = await globalThis.fetch(`${driver}${path}`, {
    method,
    ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (result.value?.error) throw new Error(`${result.value.error}: ${result.value.message}`);
  return result.value;
}

async function scenario(name, spec, source, target, options = {}) {
  if (only && !name.includes(only)) return;
  spec = { ...spec, id: `${Date.now()}-${Math.random()}` };
  const session = await request("/session", "POST", { capabilities: { alwaysMatch: {
    "webkitgtk:browserOptions": { binary: browser, args: ["--automation"] },
  } } });
  const path = `/session/${session.sessionId}`;
  const execute = script => request(`${path}/execute/sync`, "POST", { script, args: [] });
  const actions = steps => request(`${path}/actions`, "POST", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }] });
  const point = async (kind, value) => execute(`return (() => {
    const element = [...document.querySelectorAll(${JSON.stringify(kind === "folder" ? "[data-folder-path]" : "[data-fixture-file]")})]
      .find(node => node.getAttribute(${JSON.stringify(kind === "folder" ? "data-folder-path" : "data-fixture-file")}) === ${JSON.stringify(value)});
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { x: Math.round(bounds.x + 130), y: Math.round(bounds.y + bounds.height / 2) };
  })()`);
  const snapshot = () => execute(`return {
    errors: window.fixtureErrors,
    moves: window.fixtureMoves,
    identityCalls: window.fixtureIdentityCalls,
    disk: window.fixtureDisk,
    sortOption: document.querySelector("[data-fixture-sort-option]")?.getAttribute("data-fixture-sort-option") ?? null,
    files: [...document.querySelectorAll("[data-fixture-file]")].map(node => node.getAttribute("data-fixture-file")),
    rows: [...document.querySelectorAll("[data-explorer-row-id]")].map(node => node.getAttribute("data-explorer-path")),
  }`);
  const destinationOrder = (files, draggedPath) => files.filter(file =>
    file === draggedPath || directory(file) === directory(options.destination));
  try {
    await request(`${path}/url`, "POST", { url: `${site}/tests/fixtures/dnd-reparent.html?spec=${encodeURIComponent(JSON.stringify(spec))}` });
    for (let i = 0; i < 50; i++) {
      const ready = await execute(`const list = document.querySelector("[data-explorer-scroll] [role=list]");
        return Boolean(list?.querySelector("[data-fixture-file]") && list.getAnimations().every(animation => animation.playState !== "running"))`);
      if (ready) break;
      await sleep(100);
    }
    const before = await snapshot();
    assert.deepEqual(before.errors, [], `${name}: fixture must load without errors`);
    if (options.scrollStart !== undefined) {
      await execute(`document.querySelector("[data-explorer-scroll]").scrollTop = ${options.scrollStart}`);
      await sleep(50);
    }
    const sourceId = await execute(`return [...document.querySelectorAll("[data-explorer-row-kind=file]")].find(node => node.getAttribute("data-explorer-path") === ${JSON.stringify(source)})?.getAttribute("data-explorer-row-id")`);
    if (options.fail) await execute("window.fixtureFailMove = true");
    const from = await point("file", source);
    assert.ok(from, `${name}: source visible (${JSON.stringify(before)})`);
    if (options.visual) await execute(`window.fixtureTrace = []; window.fixtureTraceRunning = true;
      window.fixtureDropScroll = null;
      const overlayObserverTarget = document.querySelector('[data-dnd-overlay]');
      if (overlayObserverTarget) new MutationObserver(() => {
        if (window.fixtureDropScroll === null && overlayObserverTarget.hasAttribute('data-dnd-dropping'))
          window.fixtureDropScroll = document.querySelector('[data-explorer-scroll]').scrollTop;
      }).observe(overlayObserverTarget, { attributes: true, attributeFilter: ['data-dnd-dropping'] });
      (function record() {
        const container = document.querySelector('[data-explorer-scroll]');
        const row = [...document.querySelectorAll('[data-explorer-row-kind=file]')]
          .find(node => node.getAttribute('data-explorer-row-id') === ${JSON.stringify(sourceId)});
        const overlay = document.querySelector('[data-dnd-overlay]');
        const rect = node => { if (!node) return null; const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height }; };
        const textRect = node => { const text = node?.querySelector('[data-fixture-file]');
          if (!text) return null; const range = document.createRange(); range.selectNodeContents(text); return rect(range); };
        const probeFolder = ${JSON.stringify(options.probeFolder ?? null)} == null ? null
          : [...document.querySelectorAll('[data-explorer-row-kind=folder]')]
            .find(node => node.getAttribute('data-explorer-path') === ${JSON.stringify(options.probeFolder ?? null)});
        const probeFile = ${JSON.stringify(options.probeFile ?? null)} == null ? null
          : [...document.querySelectorAll('[data-explorer-row-kind=file]')]
            .find(node => node.getAttribute('data-explorer-path') === ${JSON.stringify(options.probeFile ?? null)});
        const paths = [${JSON.stringify(source)}, ${JSON.stringify(options.destination ?? null)}];
        const moved = [...document.querySelectorAll('[data-explorer-row-kind=file]')]
          .filter(node => paths.includes(node.getAttribute('data-explorer-path')))
          .map(node => ({ id: node.getAttribute('data-explorer-row-id'), path: node.getAttribute('data-explorer-path'),
            ...rect(node) }));
        window.fixtureTrace.push({ t: performance.now(),
          orderSaveDone: window.fixtureOrderSaveDone === true,
          dndState: JSON.parse(JSON.stringify(window.__lyraDndState ?? null)),
          scrollTop: container.scrollTop,
          list: rect(document.querySelector('[data-explorer-row-id]')?.parentElement),
          rows: [...document.querySelectorAll('[data-explorer-row-id]')].map(node => node.getAttribute('data-explorer-path')),
          probeFolder: rect(probeFolder), probeFile: rect(probeFile),
          moved,
          rowId: row?.getAttribute('data-explorer-row-id') ?? null,
          rowPath: row?.getAttribute('data-explorer-path') ?? null,
          row: rect(row), rowText: textRect(row), overlay: rect(overlay),
          overlayChild: rect(overlay?.firstElementChild), overlayText: textRect(overlay),
          dropping: overlay?.hasAttribute('data-dnd-dropping') ?? false });
        if (window.fixtureTraceRunning) requestAnimationFrame(record);
      })()`);
    await actions([{ type: "pointerMove", duration: 0, ...from }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 175 }]);
    if (options.expectManualOnDrag) {
      const during = await snapshot();
      assert.equal(during.sortOption, "manual", `${name}: automatic sort must switch to Manual at drag activation`);
      assert.deepEqual(during.rows, before.rows, `${name}: switching to Manual must not reorder rows`);
    }
    let destination = await point(target.kind, target.path);
    assert.ok(destination, `${name}: destination visible`);
    destination.y += options.targetOffsetY ?? 0;
    if (options.autoScroll) {
      const bottom = await execute(`return document.querySelector('[data-explorer-scroll]').getBoundingClientRect().bottom`);
      destination = { ...destination, y: Math.round(bottom - 20) };
    }
    await actions([{ type: "pointerMove", duration: options.autoScroll ? 80 : 400, ...destination },
      { type: "pause", duration: options.hoverMs ?? (options.autoScroll ? 30 : options.expand ? 650 : 250) }]);
    if (options.expand) {
      destination = await point("file", options.expand);
      assert.ok(destination, `${name}: expanded target visible`);
      await actions([{ type: "pointerMove", duration: 200, ...destination }, { type: "pause", duration: 150 }]);
    }
    if (options.crossSortable) {
      let during = await snapshot();
      for (let attempt = 0; attempt < 6 && during.rows.indexOf(source) <= during.rows.indexOf(options.crossSortable); attempt++) {
        destination = await point(target.kind, target.path);
        assert.ok(destination, `${name}: destination stays visible during drag`);
        await actions([{ type: "pointerMove", duration: 80, ...destination }, { type: "pause", duration: 80 }]);
        during = await snapshot();
      }
      const sourceIndex = during.rows.indexOf(source);
      const folderIndex = during.rows.indexOf(options.crossSortable);
      assert.ok(sourceIndex > folderIndex, `${name}: optimistic sorting must reparent the source before drop (${JSON.stringify(during)})`);
    }
    if (options.cancel) {
      await request(`${path}/actions`, "POST", { actions: [{ type: "key", id: "keyboard", actions: [
        { type: "keyDown", value: "\uE00C" }, { type: "keyUp", value: "\uE00C" },
      ] }] });
    }
    if (options.delaySave) await execute(`window.fixtureDelaySaveMs = ${options.delaySave}`);
    if (options.removeBeforeRelease) {
      const beforeRefresh = (await snapshot()).rows;
      assert.equal(beforeRefresh[beforeRefresh.indexOf(source) - 1], options.removeBeforeRelease,
        `${name}: the removed file must precede the dragged row in the destination`);
      await execute(`window.fixtureRemoveFile(${JSON.stringify(options.removeBeforeRelease)})`);
    }
    if (options.verifySlot !== undefined) await execute(`window.addEventListener("pointerup", () => {
      window.fixtureReleaseRows = [...document.querySelectorAll("[data-explorer-row-id][data-open='1']")].map(node => ({
        path: node.dataset.explorerPath, kind: node.dataset.explorerRowKind,
      }));
    }, { capture: true, once: true })`);
    await actions([{ type: "pointerUp", button: 0 }]);
    let selectedOrder;
    if (options.verifySlot !== undefined) {
      const rows = await execute("return window.fixtureReleaseRows");
      const index = rows.findIndex(row => row.path === source);
      assert.ok([rows[index - 1], rows[index + 1]].some(row =>
        row?.kind === "file" && directory(row.path) === directory(options.destination)),
      `${name}: the dragged row must be beside a destination file at release`);
      const order = destinationOrder(rows.filter(row => row.kind === "file").map(row => row.path), source);
      if (Number.isInteger(options.verifySlot)) {
        assert.equal(order[options.verifySlot], source, `${name}: fixture must select slot ${options.verifySlot} (${order})`);
      }
      selectedOrder = order.map(file => file === source ? options.destination : file);
    }
    if (options.delaySave) {
      // Con la corrección la escritura definitiva termina y ordena la fila; con
      // el código defectuoso no llega a producirse. En ambos casos se observa la
      // ventana completa antes de comprobar la proyección.
      for (let i = 0; i < 40; i++) {
        if (await execute(`return window.fixtureOrderSaveDone === true`)) break;
        await sleep(50);
      }
    }
    for (let i = 0; i < (options.reorder ? 3 : 30); i++) {
      const current = await snapshot();
      if (options.cancel || options.reorder || current.moves.length || current.errors.length) break;
      await sleep(100);
    }
    await sleep(250);
    const after = await snapshot();
    if (selectedOrder) {
      const persisted = await execute(`const preferences = JSON.parse(sessionStorage.getItem(${JSON.stringify(`fixturePreferences:${spec.id}`)}));
        return JSON.parse(preferences?.fileOrder ?? "{}")[${JSON.stringify(directory(options.destination))}]`);
      assert.deepEqual({ rendered: destinationOrder(after.rows.filter(row => after.files.includes(row))), persisted }, {
        rendered: selectedOrder, persisted: selectedOrder,
      }, `${name}: confirmed visual slot must match persistence and reconciliation`);
    }
    if (options.expectNoMissingBinding) {
      assert.ok(after.identityCalls.some(call => call.path === source), `${name}: existing file was bound`);
      assert.ok(after.identityCalls.every(call => call.path !== options.expectNoMissingBinding),
        `${name}: missing file must not be rebound (${JSON.stringify(after.identityCalls)})`);
    }
    if (options.visual) {
      const trace = await execute(`window.fixtureTraceRunning = false; return window.fixtureTrace`);
      const dropping = trace.filter(frame => frame.dropping);
      let dropScroll = dropping[0]?.scrollTop ?? 0;
      let last = null;
      if (!options.delaySave && dropping.some(frame => frame.overlay)) {
        assert.ok(dropping.length >= 3, `${name}: native drop animation has measured frames`);
        assert.ok(dropping.every(frame => frame.overlayChild && frame.overlayText),
          `${name}: overlay content stays mounted through native placement`);
        const visiblePlacement = dropping.filter(frame => frame.overlay && frame.overlay.width > 0);
        assert.ok(visiblePlacement.length >= 3, `${name}: visible placement has measured intermediate frames`);
        assert.ok(visiblePlacement.every(frame => Math.abs(frame.overlay.x - frame.list.x) < 1
          && Math.abs(frame.overlay.width - frame.list.width) < 1),
        `${name}: every visible overlay frame keeps the explorer's absolute x and width (${JSON.stringify(visiblePlacement.map(frame => ({ overlay: frame.overlay, list: frame.list })))})`);
        const aligned = dropping.filter(frame => frame.overlayChild && frame.row && frame.rowText && frame.overlayText);
        assert.ok(aligned.length >= 1, `${name}: overlay and row have measurable bounds during placement`);
        assert.ok(aligned.every(frame => Math.abs(frame.overlayChild.x - frame.row.x) < 1),
          `${name}: overlay and final row share horizontal bounds`);
        last = aligned.at(-1);
        assert.ok(Math.abs(last.overlayText.x - last.rowText.x) <= 1.5,
          `${name}: overlay text reaches final indentation (${last.overlayText.x}, ${last.rowText.x})`);
        const xSteps = aligned.slice(1).map((frame, index) => Math.abs(frame.overlayText.x - aligned[index].overlayText.x));
        assert.ok(xSteps.every(step => step <= 15), `${name}: no abrupt horizontal indentation change (${xSteps})`);
        const releaseScroll = await execute(`return window.fixtureDropScroll`);
        assert.equal(dropScroll, releaseScroll, `${name}: first placement frame preserves release scrollTop`);
        assert.ok(dropping.every(frame => frame.scrollTop === dropScroll),
          `${name}: scrollTop stays fixed during placement (${dropping.map(frame => frame.scrollTop)})`);
        assert.equal(trace.at(-1).scrollTop, dropScroll, `${name}: scrollTop stays fixed after placement`);
      }
      if (options.autoScroll) {
        const beforeDrop = trace.filter(frame => !frame.dropping).map(frame => frame.scrollTop);
        assert.ok(Math.max(...beforeDrop) > Math.min(...beforeDrop), `${name}: native auto-scroll worked during drag`);
      }
      if (options.delaySave) {
        const placementFrames = trace.filter(frame => frame.moved.some(item => item.path === options.destination));
        assert.ok(placementFrames.length >= 3, `${name}: delayed persistence has observed placement frames`);
        const projectionStarted = placementFrames.findIndex(frame => frame.dndState?.optimisticMove);
        assert.ok(projectionStarted >= 0, `${name}: optimistic projection was installed at drop`);
        const pendingFrames = placementFrames.slice(projectionStarted).filter(frame => !frame.orderSaveDone);
        assert.ok(pendingFrames.length >= 3, `${name}: definitive order persistence has observed placement frames`);
        assert.ok(pendingFrames.every(frame => frame.dndState?.optimisticMove),
          `${name}: optimistic projection must stay active until the definitive order is persisted (${JSON.stringify(pendingFrames.map(frame => frame.dndState && { optimistic: frame.dndState.optimisticMove, pending: frame.dndState.pending }))})`);
        assert.ok(pendingFrames.every(frame => frame.moved.every(item => item.path !== source)),
          `${name}: the source must not reappear while persistence is pending (${JSON.stringify(pendingFrames.map(frame => frame.moved))})`);
      }
      if (options.probeFolder) {
        const samples = trace.filter(frame => frame.probeFolder);
        assert.ok(samples.length >= 10, `${name}: folder row has measured frames`);
        // La fila de carpeta puede desplazarse una sola vez por una razón legítima
        // (p. ej. la nota sale de una carpeta situada encima de ella), pero no
        // debe oscilar ni volver a moverse durante el drop.
        let shifts = 0;
        for (let index = 1; index < samples.length; index++) {
          if (Math.abs(samples[index].probeFolder.y - samples[index - 1].probeFolder.y) > 1) shifts++;
        }
        assert.ok(shifts <= 1, `${name}: folder "${options.probeFolder}" must not jump back and forth (${shifts} shifts)`);
        const firstDropIndex = trace.findIndex(frame => frame.dropping);
        const settled = trace[Math.max(0, firstDropIndex - 1)]?.probeFolder?.y;
        assert.ok(trace.slice(firstDropIndex).every(frame => !frame.probeFolder || Math.abs(frame.probeFolder.y - settled) <= 1),
          `${name}: folder "${options.probeFolder}" moves during/after the drop (${JSON.stringify(trace.slice(firstDropIndex).map(frame => frame.probeFolder?.y))})`);
        const folderIndex = samples[0].rows.indexOf(options.probeFolder);
        assert.ok(folderIndex >= 0, `${name}: probe folder is present in the DOM`);
        let crossed = false;
        for (const frame of samples) {
          const sourceIndex = frame.rows.indexOf(source);
          if (sourceIndex === -1) continue;
          if (sourceIndex > folderIndex) crossed = true;
          else if (crossed) assert.fail(`${name}: the moved file returned above "${options.probeFolder}" before settling (${JSON.stringify(frame.rows)})`);
        }
      }
      if (options.probeFile) {
        const samples = trace.filter(frame => frame.probeFile);
        assert.ok(samples.length >= 10, `${name}: file row has measured frames`);
        const firstDropIndex = trace.findIndex(frame => frame.dropping);
        const settled = trace[Math.max(0, firstDropIndex - 1)]?.probeFile?.y;
        // Tras el drop, el archivo que cierra/abre espacio debe quedar fijo, sin
        // volver a moverse (la posición definitiva es la optimista).
        assert.ok(trace.slice(firstDropIndex).every(frame => !frame.probeFile || Math.abs(frame.probeFile.y - settled) <= 1),
          `${name}: file "${options.probeFile}" moves during/after the drop (${JSON.stringify(trace.slice(firstDropIndex).map(frame => frame.probeFile?.y))})`);
        // Sin saltos abruptos entre fotogramas consecutivos: el desplazamiento debe ser continuo.
        let maxStep = 0;
        for (let index = 1; index < samples.length; index++) {
          maxStep = Math.max(maxStep, Math.abs(samples[index].probeFile.y - samples[index - 1].probeFile.y));
        }
        assert.ok(maxStep <= 40, `${name}: file "${options.probeFile}" moved abruptly between frames (max ${maxStep}px)`);
      }
      const beforeDrop = trace.slice(0, Math.max(0, trace.indexOf(dropping[0]))).at(-1);
      const pointText = point => point ? `(${point.x.toFixed(1)},${point.y.toFixed(1)})` : "(n/a)";
      console.log(`TRACE ${name}: before overlay=${pointText(beforeDrop?.overlay)} `
        + `row=${pointText(beforeDrop?.row)} scrollTop=${beforeDrop?.scrollTop}; `
        + `placing text x=${dropping[0]?.overlayText?.x.toFixed(1) ?? "n/a"}→${last?.overlayText?.x.toFixed(1) ?? "n/a"} `
        + `overlay y=${dropping[0]?.overlay?.y.toFixed(1) ?? "n/a"}→${last?.overlay?.y.toFixed(1) ?? "n/a"} scrollTop=${dropScroll}; `
        + `after row=${pointText(trace.at(-1).row)} scrollTop=${trace.at(-1).scrollTop}`);
    }
    assert.deepEqual(after.errors, [], `${name}: React must not throw during commit`);
    if (options.expectManualOnDrag) {
      assert.equal(after.sortOption, "manual", `${name}: the drag must finish with Manual still selected`);
    }
    assert.equal(after.moves.length, options.cancel || options.reorder ? 0 : 1, `${name}: physical move count (${JSON.stringify(after)})`);
    const expected = options.cancel || options.fail || options.reorder ? source : options.destination;
    assert.equal(after.disk.includes(expected), true, `${name}: disk model (${JSON.stringify(after)})`);
    assert.equal(after.files.includes(expected), true, `${name}: visual model`);
    if (!options.reorder) assert.equal(after.files.includes(options.cancel || options.fail ? options.destination : source), false, `${name}: no stale duplicate`);
    if (options.reorder) assert.ok(after.rows.indexOf(source) < after.rows.indexOf(target.path), `${name}: manual order changed`);
    if (options.expectAfter) {
      const destinationIndex = after.rows.indexOf(options.destination);
      const anchorIndex = after.rows.indexOf(options.expectAfter);
      assert.ok(destinationIndex >= 0 && anchorIndex >= 0, `${name}: drop slot is present in the final DOM (${JSON.stringify(after.rows)})`);
      assert.equal(destinationIndex, anchorIndex + 1,
        `${name}: definitive order must keep the drop slot after "${options.expectAfter}" (${JSON.stringify(after.rows)})`);
    }
    if (options.expectBefore) {
      const destinationIndex = after.rows.indexOf(options.destination);
      const anchorIndex = after.rows.indexOf(options.expectBefore);
      assert.ok(destinationIndex >= 0 && anchorIndex >= 0, `${name}: drop slot is present in the final DOM (${JSON.stringify(after.rows)})`);
      assert.equal(destinationIndex, anchorIndex - 1,
        `${name}: definitive order must keep the drop slot before "${options.expectBefore}" (${JSON.stringify(after.rows)})`);
    }
    if (!options.cancel && !options.fail && !options.reorder) {
      const afterId = await execute(`return [...document.querySelectorAll("[data-explorer-row-kind=file]")].find(node => node.getAttribute("data-explorer-path") === ${JSON.stringify(options.destination)})?.getAttribute("data-explorer-row-id")`);
      assert.equal(afterId, sourceId, `${name}: stable file identity`);
    }
    if (options.consecutive) {
      const moved = await point("file", options.destination);
      const { file, folder } = options.consecutive;
      const back = await point(file ? "file" : "folder", file ?? folder);
      assert.ok(moved && back, `${name}: second drag targets visible`);
      if (file) back.y -= 10;
      await actions([{ type: "pointerMove", duration: 0, ...moved }, { type: "pointerDown", button: 0 },
        { type: "pause", duration: 175 }, { type: "pointerMove", duration: file ? 120 : 400, ...back },
        { type: "pause", duration: file ? 90 : 250 }, { type: "pointerUp", button: 0 }]);
      for (let i = 0; i < 30; i++) {
        if ((await snapshot()).moves.length === 2) break;
        await sleep(100);
      }
      await sleep(250);
      const second = await snapshot();
      assert.deepEqual(second.errors, [], `${name}: second React commit`);
      assert.equal(second.moves.length, 2, `${name}: exactly two physical moves`);
      assert.equal(second.disk.includes(source), true, `${name}: second disk destination`);
      assert.equal(second.files.includes(source), true, `${name}: second visual destination`);
      assert.equal(second.disk.includes(options.destination), false, `${name}: no duplicate disk file`);
      if (file) assert.equal(second.rows.indexOf(source) + 1, second.rows.indexOf(file),
        `${name}: the second move must keep its insertion slot (${second.rows})`);
    }
    if (options.restart) {
      await request(`${path}/refresh`, "POST", {});
      for (let i = 0; i < 30; i++) {
        if ((await snapshot()).files.includes(options.destination)) break;
        await sleep(100);
      }
      const restarted = await snapshot();
      if (selectedOrder) assert.deepEqual(destinationOrder(restarted.rows.filter(row => restarted.files.includes(row))),
        selectedOrder, `${name}: reload keeps the confirmed slot`);
      assert.deepEqual(restarted.errors, [], `${name}: reload errors`);
      assert.equal(restarted.files.includes(options.destination), true, `${name}: reload visual state`);
      assert.equal(restarted.disk.includes(options.destination), true, `${name}: reload disk state`);
    }
    console.log(`PASS ${name}`);
  } finally {
    await request(path, "DELETE").catch(() => undefined);
  }
}

try {
  if (!process.env.LYRA_DND_TEST_SITE) {
    children.push(spawn("pnpm", ["run", "dev", "--host", "127.0.0.1"], { stdio: "ignore" }));
  }
  if (!process.env.LYRA_DND_TEST_DRIVER) {
    children.push(spawn("WebKitWebDriver", ["--port=9519"], { stdio: "ignore" }));
  }
  await ready(`${site}/tests/fixtures/dnd-reparent.html`);
  await ready(`${driver}/status`);
  await scenario("A to B/C over existing file", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", crossSortable: "B/C", restart: true });
  await scenario("B/C to A", { folders: ["A", "B", "B/C"], files: ["A/Existing.md", "B/C/Archivo.md"] },
    "B/C/Archivo.md", { kind: "file", path: "A/Existing.md" },
    { destination: "A/Archivo.md", crossSortable: "A" });
  await scenario("sibling subfolders", { folders: ["A", "A/D", "B", "B/C"], files: ["A/D/Archivo.md", "B/C/Existing.md"] },
    "A/D/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", crossSortable: "B/C" });
  await scenario("different depth", { folders: ["A", "B", "B/C", "B/C/D"], files: ["A/Archivo.md", "B/C/D/Existing.md"] },
    "A/Archivo.md", { kind: "file", path: "B/C/D/Existing.md" },
    { destination: "B/C/D/Archivo.md", crossSortable: "B/C/D", verifySlot: true });
  await scenario("empty destination", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md"] },
    "A/Archivo.md", { kind: "folder", path: "B/C" }, { destination: "B/C/Archivo.md" });
  await scenario("folder row stays stable while dropping between its files",
    { folders: ["A", "B"], files: ["A/Archivo1.md", "B/Archivo2.md", "B/Archivo3.md"], sortOption: "manual" },
    "A/Archivo1.md", { kind: "file", path: "B/Archivo3.md" },
    { destination: "B/Archivo1.md", visual: true, probeFolder: "B", expectAfter: "B/Archivo2.md" });
  await scenario("consecutive moves of the same file", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", crossSortable: "B/C", consecutive: { folder: "A" } });
  await scenario("collapsed destination", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"], expanded: { "B/C": false } },
    "A/Archivo.md", { kind: "folder", path: "B/C" },
    { destination: "B/C/Archivo.md", expand: "B/C/Existing.md" });
  await scenario("physical failure", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", crossSortable: "B/C", fail: true });
  await scenario("Escape cancellation", { folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", crossSortable: "B/C", cancel: true });
  const rootFillers = Array.from({ length: 12 }, (_, index) => `root-${index}.md`);
  const siblingFillers = Array.from({ length: 12 }, (_, index) => `B/tail-${index}.md`);
  const destinationFillers = Array.from({ length: 12 }, (_, index) => `B/C/tail-${index}.md`);
  await scenario("visual placement between open sibling folders",
    { folders: ["A", "B"], files: [...rootFillers, "A/Archivo.md", "B/Existing.md", ...siblingFillers] },
    "A/Archivo.md", { kind: "file", path: "B/Existing.md" },
    { destination: "B/Archivo.md", scrollStart: 500, visual: true });
  await scenario("visual placement into deeper subfolder",
    { folders: ["A", "B", "B/C"], files: [...rootFillers, "A/Archivo.md", "B/C/Existing.md", ...destinationFillers] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", scrollStart: 500, visual: true });
  await scenario("native auto-scroll stops on drop",
    { folders: ["A", "B", "B/C"], files: [...rootFillers, "A/Archivo.md", "B/C/Existing.md", ...destinationFillers] },
    "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
    { destination: "B/C/Archivo.md", scrollStart: 500, autoScroll: true, visual: true });
  await scenario("folder to Lyra root", { folders: ["A"], files: ["A/Archivo.md", "RootExisting.md"] },
    "A/Archivo.md", { kind: "file", path: "RootExisting.md" }, { destination: "Archivo.md", visual: true, verifySlot: true });
  await scenario("Lyra root to folder", { folders: ["A"], files: ["Archivo.md", "A/Existing.md"] },
    "Archivo.md", { kind: "file", path: "A/Existing.md" }, { destination: "A/Archivo.md", visual: true, verifySlot: true });
  await scenario("manual reorder within a folder", { folders: ["A"], files: ["A/Alpha.md", "A/Zeta.md"] },
    "A/Zeta.md", { kind: "file", path: "A/Alpha.md" }, { destination: "A/Zeta.md", reorder: true, visual: true });
  await scenario("manual reorder ignores obsolete order binding", {
    folders: ["A"], files: ["A/Alpha.md", "A/Zeta.md"],
    fileOrder: { A: ["A/Stale.md", "A/Alpha.md", "A/Zeta.md"] }, trackIdentity: true,
  }, "A/Zeta.md", { kind: "file", path: "A/Alpha.md" },
  { destination: "A/Zeta.md", reorder: true, expectNoMissingBinding: "A/Stale.md" });
  await scenario("automatic order switches to Manual without reordering", {
    folders: ["A"], files: ["A/Alpha.md", "A/Zeta.md"],
    sortOption: "mtime", fileOrder: { A: ["A/Zeta.md", "A/Alpha.md"] },
  }, "A/Zeta.md", { kind: "file", path: "A/Alpha.md" },
  { destination: "A/Zeta.md", reorder: true, expectManualOnDrag: true });
  await scenario("automatic drag cancelled keeps Manual selected", {
    folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "B/C/Existing.md"], sortOption: "az",
  }, "A/Archivo.md", { kind: "file", path: "B/C/Existing.md" },
  { destination: "B/C/Archivo.md", cancel: true, expectManualOnDrag: true });

  // Regresión: la posición elegida debe ser definitiva incluso cuando el archivo
  // arrastrado no tiene un vínculo de identidad (el caso habitual). El filtro de
  // orden no debe descartar archivos sin vínculo, o el estado final de React
  // divergiría del orden optimista de dnd-kit.
  await scenario("identity-tracked second position of 3 keeps its slot", {
    folders: ["A", "B"], files: ["A/Archivo.md", "B/one.md", "B/two.md", "B/three.md"], trackIdentity: true,
  }, "A/Archivo.md", { kind: "file", path: "B/two.md" },
  { destination: "B/Archivo.md", expectAfter: "B/one.md", probeFile: "B/two.md", visual: true, verifySlot: 1, restart: true });

  await scenario("identity-tracked beginning of 3", {
    folders: ["A", "B"], files: ["A/Archivo.md", "B/one.md", "B/two.md", "B/three.md"], trackIdentity: true,
  }, "A/Archivo.md", { kind: "file", path: "B/one.md" },
  { destination: "B/Archivo.md", expectBefore: "B/one.md", visual: true, verifySlot: 0 });

  await scenario("identity-tracked end of 3", {
    folders: ["A", "B"], files: ["A/Archivo.md", "B/one.md", "B/two.md", "B/three.md"], trackIdentity: true,
  }, "A/Archivo.md", { kind: "file", path: "B/three.md" },
  { destination: "B/Archivo.md", visual: true, verifySlot: 3, targetOffsetY: 14 });

  await scenario("listing refresh keeps the visible drop slot", {
    folders: ["A", "B"], files: ["A/Archivo.md", "B/one.md", "B/two.md", "B/three.md"],
  }, "A/Archivo.md", { kind: "file", path: "B/two.md" }, {
    destination: "B/Archivo.md", removeBeforeRelease: "B/one.md", verifySlot: 0, restart: true,
  });

  await scenario("quick release keeps the visible slot during sorting", {
    folders: ["A", "B"], files: ["A/Archivo.md", "B/one.md", "B/two.md", "B/three.md"],
  }, "A/Archivo.md", { kind: "file", path: "B/two.md" }, {
    destination: "B/Archivo.md", hoverMs: 35, verifySlot: 1,
  });

  await scenario("identity-tracked consecutive moves keep their slot", {
    folders: ["A", "B", "B/C"], files: ["A/Archivo.md", "A/one.md", "A/two.md", "B/C/one.md", "B/C/two.md", "B/C/three.md"], trackIdentity: true,
  }, "A/Archivo.md", { kind: "file", path: "B/C/two.md" },
  { destination: "B/C/Archivo.md", expectAfter: "B/C/one.md", consecutive: { file: "A/two.md" }, visual: true });

  // Regresión del parpadeo: mientras la escritura definitiva del orden está en
  // curso, la proyección optimista debe seguir vigente. Si se retira antes, la
  // fila del archivo cambia de identidad y puede reaparecer en la carpeta de
  // origen, desplazando las filas de carpeta durante el drop.
  await scenario("delayed persistence keeps the moved row stable until definitive order",
    { folders: ["A", "B"], files: ["A/Archivo1.md", "A/Archivo2.md", "B/Archivo3.md", "B/Archivo4.md"] },
    "A/Archivo1.md", { kind: "folder", path: "B" },
    { destination: "B/Archivo1.md", visual: true, probeFolder: "B", delaySave: 500, expectBefore: "B/Archivo3.md" });
} finally {
  for (const child of children) child.kill("SIGTERM");
}
