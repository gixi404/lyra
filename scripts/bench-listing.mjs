import { mkdtemp, writeFile, readdir, stat, rm, utimes } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const dir = await mkdtemp(join(tmpdir(), "lyra-list-bench-"));
const sizes = [100, 1000, 5000, 10000];
const repetitions = 5;
const valid = name => !name.startsWith(".") && (name.endsWith(".txt") || name.endsWith(".md"));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);

async function previousListing() {
  let start = performance.now();
  const entries = await readdir(dir, { withFileTypes: true });
  const enumeration = performance.now() - start;
  const files = entries.filter(entry => entry.isFile() && valid(entry.name)).map(entry => entry.name);
  start = performance.now();
  const items = await Promise.all(files.map(async name => {
    const metadata = await stat(join(dir, name));
    return { name, mtime: metadata.mtimeMs, birthtime: metadata.birthtimeMs };
  }));
  const metadata = performance.now() - start;
  start = performance.now();
  const stats = Object.fromEntries(items.map(({ name, ...values }) => [name, values]));
  const store = performance.now() - start;
  return { files, stats, enumeration, metadata, store };
}

function batchedListing() {
  let start = performance.now();
  const entries = readdirSync(dir, { withFileTypes: true });
  const enumeration = performance.now() - start;
  const files = [];
  const stats = {};
  start = performance.now();
  for (const entry of entries) {
    if (!entry.isFile() || !valid(entry.name)) continue;
    const metadata = statSync(join(dir, entry.name));
    files.push(entry.name);
    stats[entry.name] = { mtime: metadata.mtimeMs, birthtime: metadata.birthtimeMs };
  }
  const metadata = performance.now() - start;
  return { files, stats, enumeration, metadata, store: 0 };
}

try {
  let previousSize = 0;
  for (const size of sizes) {
    for (let index = previousSize; index < size; index++) {
      await writeFile(join(dir, `note-${String(index).padStart(5, "0")}.txt`), "sample");
    }
    previousSize = size;
    const before = [];
    const after = [];
    for (let run = 0; run < repetitions; run++) {
      const old = await previousListing();
      const next = batchedListing();
      if (old.files.length !== next.files.length || Object.keys(old.stats).length !== Object.keys(next.stats).length) {
        throw new Error("Listing mismatch");
      }
      before.push(old);
      after.push(next);
    }
    const changed = join(dir, "note-00000.txt");
    await utimes(changed, new Date(), new Date(Date.now() + 1000));
    const singleChangeBefore = [];
    const singleChangeAfter = [];
    for (let run = 0; run < repetitions; run++) {
      let start = performance.now();
      await previousListing();
      singleChangeBefore.push(performance.now() - start);
      start = performance.now();
      batchedListing();
      singleChangeAfter.push(performance.now() - start);
    }
    const result = values => ({
      enumerationMs: median(values.map(value => value.enumeration)),
      metadataMs: median(values.map(value => value.metadata)),
      storeMs: median(values.map(value => value.store)),
      totalMs: median(values.map(value => value.enumeration + value.metadata + value.store)),
    });
    console.log(JSON.stringify({ files: size, before: result(before), after: result(after),
      singleChangeMs: { before: median(singleChangeBefore), after: median(singleChangeAfter) },
      heapMb: (process.memoryUsage().heapUsed / 1048576).toFixed(2) }));
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
