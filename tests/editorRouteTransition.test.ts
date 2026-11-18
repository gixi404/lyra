import test from "node:test";
import assert from "node:assert/strict";
import { transitionToEditor } from "../src/utils/editorRouteTransition.ts";

test("creating a note navigates only after the list exit animation finishes", async () => {
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const events: string[] = [];
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelector: () => ({ animate: () => { events.push("exit"); return { finished }; } }),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => ({ matches: false }),
  } });
  try {
    const navigation = transitionToEditor(() => events.push("navigate"));
    assert.deepEqual(events, ["exit"]);
    finish();
    await navigation;
    assert.deepEqual(events, ["exit", "navigate"]);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("reduced motion navigates without animating", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let animated = false;
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    querySelector: () => ({ animate: () => { animated = true; } }),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    matchMedia: () => ({ matches: true }),
  } });
  let navigated = false;
  try {
    await transitionToEditor(() => { navigated = true; });
    assert.equal(navigated, true);
    assert.equal(animated, false);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
