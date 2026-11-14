import test from "node:test";
import assert from "node:assert/strict";
import { shouldPreserveExplorerDataOnInit, startListInitialization, startLocalFirstListInitialization } from "../src/utils/listInitialization.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("AUD-008: setup, cleanup, setup applies only the live initialization", async () => {
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  const applied: string[][] = [];
  const errors: unknown[] = [];
  const cleanupFirst = startListInitialization(() => first.promise, value => applied.push(value), error => errors.push(error));
  cleanupFirst();
  const cleanupSecond = startListInitialization(() => second.promise, value => applied.push(value), error => errors.push(error));
  first.resolve(["stale.md"]);
  second.resolve(["current.md"]);
  await Promise.all([first.promise, second.promise]);
  await Promise.resolve();
  assert.deepEqual(applied, [["current.md"]]);
  assert.deepEqual(errors, []);
  cleanupSecond();
});

test("AUD-008: an initialization failure does not prevent a later attempt", async () => {
  const failed = deferred<string[]>();
  const applied: string[][] = [];
  const errors: unknown[] = [];
  const cleanupFailed = startListInitialization(() => failed.promise, value => applied.push(value), error => errors.push(error));
  failed.reject(new Error("temporary read failure"));
  await failed.promise.catch(() => {});
  await Promise.resolve();
  cleanupFailed();
  const cleanupRetry = startListInitialization(async () => ["recovered.md"], value => applied.push(value), error => errors.push(error));
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.deepEqual(applied, [["recovered.md"]]);
  cleanupRetry();
});

test("local notes appear before welcome reconciliation or Drive completes", async () => {
  const prepare = deferred<void>();
  const applied: string[][] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const cleanup = startLocalFirstListInitialization(
    async () => { reads++; return ["Local.md"]; },
    () => prepare.promise,
    value => applied.push(value),
    error => errors.push(error),
  );
  await Promise.resolve();
  assert.deepEqual(applied, [["Local.md"]]);
  assert.equal(reads, 1);
  prepare.reject(new Error("Drive archive unavailable"));
  await prepare.promise.catch(() => {});
  await Promise.resolve();
  assert.deepEqual(applied, [["Local.md"]]);
  assert.equal(errors.length, 1);
  cleanup();
});

test("an initially missing folder is listed after welcome setup creates it", async () => {
  const applied: string[][] = [];
  const errors: unknown[] = [];
  let exists = false;
  const cleanup = startLocalFirstListInitialization(
    async () => {
      if (!exists) throw new Error("folder missing");
      return ["¡Bienvenid@ a Lyra!.txt"];
    },
    async () => { exists = true; },
    value => applied.push(value),
    error => errors.push(error),
  );
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [["¡Bienvenid@ a Lyra!.txt"]]);
  assert.equal(errors.length, 1);
  cleanup();
});

test("a cancelled list session cannot apply a stale welcome refresh", async () => {
  const prepare = deferred<void>();
  const applied: string[][] = [];
  const cleanup = startLocalFirstListInitialization(
    async () => ["Old.md"],
    () => prepare.promise,
    value => applied.push(value),
    () => {},
  );
  await Promise.resolve();
  cleanup();
  prepare.resolve();
  await prepare.promise;
  await Promise.resolve();
  assert.deepEqual(applied, [["Old.md"]]);
});

test("returning to an initialized explorer preserves existing data instead of forcing a loading state", () => {
  assert.equal(
    shouldPreserveExplorerDataOnInit({ isInitialized: true, files: ["nota.txt"], folders: [] }),
    true,
  );
  assert.equal(
    shouldPreserveExplorerDataOnInit({ isInitialized: true, files: [], folders: ["Trabajo"] }),
    true,
  );
  assert.equal(
    shouldPreserveExplorerDataOnInit({ isInitialized: false, files: ["nota.txt"], folders: [] }),
    false,
  );
  assert.equal(
    shouldPreserveExplorerDataOnInit({ isInitialized: true, files: [], folders: [] }),
    false,
  );
});

test("listing generation: lectura antigua pendiente descartada tras mutación; lectura posterior aplicada", async () => {
  let gen = 0;
  const getGen = () => gen;
  const stale = deferred<string[]>();
  const appliedA: unknown[] = [];
  const cleanupStale = startListInitialization<string[]>(() => stale.promise, v => { appliedA.push(v); }, () => {}, getGen);
  // mutación local mientras la lectura está pendiente
  gen++;
  stale.resolve(["old.md"]);
  await stale.promise;
  await Promise.resolve();
  assert.deepEqual(appliedA, []); // descartada
  cleanupStale();

  // @ts-expect-error type inference quirk in test env
  const cleanupFresh = startListInitialization<string[]>(async () => ["new.md"], v => { appliedA.push(v); }, () => {}, getGen);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(appliedA, [["new.md"]]); // lectura iniciada tras mutación aplicada
  cleanupFresh();
});

test("listing generation: múltiples mutaciones durante lectura pendiente; init local-first descarta applies obsoletos", async () => {
  let gen = 0;
  const getGen = () => gen;
  const stale = deferred<string[]>();
  const appliedB: unknown[] = [];
  startListInitialization<string[]>(() => stale.promise, v => { appliedB.push(v); }, () => {}, getGen);
  gen++; gen++; // múltiples movimientos/mutaciones
  stale.resolve(["old.md"]);
  await stale.promise;
  await Promise.resolve();
  assert.deepEqual(appliedB, []);

  // startLocalFirstListInitialization: descarta primer apply si generación cambia durante lectura inicial
  const initRead = deferred<string[]>();
  const initAppliedB: unknown[] = [];
  let reads = 0;
  const cleanupInit = startLocalFirstListInitialization<string[]>(
    async () => { reads++; return initRead.promise; },
    async () => {},
    v => { initAppliedB.push(v); },
    () => {},
    getGen,
  );
  gen++; // mutación durante lectura inicial
  initRead.resolve(["stale-init.md"]);
  await initRead.promise;
  await Promise.resolve();
  assert.deepEqual(initAppliedB, []); // primer apply descartado
  assert.equal(reads, 1);
  cleanupInit();

  // inicialización válida tras estabilizarse
  const cleanupOk = startLocalFirstListInitialization<string[]>(
    async () => ["ok.md"],
    async () => {},
    // @ts-expect-error type inference quirk in test env
    v => { initAppliedB.push(v); },
    () => {},
    getGen,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(initAppliedB, [["ok.md"]]);
  cleanupOk();
});
