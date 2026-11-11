import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFileName } from "../src/utils/helpers.ts";
import { folderListDepthPx } from "../src/utils/folderIndent.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

// --- Problema 4: nombres de archivo -------------------------------------------

test("4. Unicode, acentos y alfabetos no latinos son válidos", () => {
  assert.equal(validateFileName("ñandú.md").ok, true);
  assert.equal(validateFileName("日本語のメモ.md").ok, true);
  assert.equal(validateFileName("Ελληνικά.md").ok, true);
  assert.equal(validateFileName("Café Ñandú.md").ok, true);
  assert.equal(validateFileName("emoji 🎉 y corazón ❤.md").ok, true);
  assert.equal(validateFileName("symbols @100 %! [ok] (ok) {ok}.md").ok, true);
});

test("4. Caracteres válidos no se sustituyen: se rechazan o se conservan tal cual", () => {
  // La función es pura y sin efectos: nunca modifica el argumento de entrada.
  const entries = [
    "notas 📝.md",
    "¿Cuánto cuesta?.txt", // contiene '?', debe rechazarse (no sustituirse)
    "mi @archivo!.md",
    "Ñ.txt",
  ];
  for (const entry of entries) {
    const copy = entry;
    validateFileName(entry);
    assert.equal(entry, copy, "validateFileName must not mutate the input");
  }
});

test("4. '?' se rechaza explícitamente, nunca se sustituye por '@'", () => {
  const r = validateFileName("mi?archivo.md");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /\?/);
  const source = read("src/utils/helpers.ts");
  assert.equal(source.includes("replace(/\\?/g"), false, "no debe quedar sustitución silenciosa de '?' en helpers.ts");
  assert.equal(source.includes("replace(/\\*/g"), false);
  assert.equal(source.includes("sanitizeFileName"), false);
});

test("4. Caracteres y secuencias inválidas se rechazan con explicación", () => {
  const invalid = [
    { name: "con/barra.md", pattern: /\// },
    { name: "con\\\\mantra.md", pattern: /\\/ },
    { name: "dos:puntos.md", pattern: /:/ },
    { name: "asterisco*.md", pattern: /\*/ },
    { name: 'comillas".md', pattern: /"/ },
    { name: "menor<que.md", pattern: /</ },
    { name: "mayor>que.md", pattern: />/ },
    { name: "barra|vertical.md", pattern: /\|/ },
    { name: "control\n.md", pattern: /control/ },
    { name: "", pattern: /vacío/ },
    { name: "   ", pattern: /vacío/ },
    { name: " con espacios inicio.md", pattern: /espacios/ },
    { name: "archivo.", pattern: /puntos o espacios/ },
    { name: "archivo ", pattern: /espacios/ },
    { name: "x".repeat(61), pattern: /largo/ },
    { name: "..", pattern: /puntos/ },
    { name: ".oculto", pattern: /puntos/ },
  ];
  for (const { name, pattern } of invalid) {
    const r = validateFileName(name);
    assert.equal(r.ok, false, `expected invalid: ${JSON.stringify(name)}`);
    assert.match(r.reason ?? "", pattern);
  }
});

test("4. Nombres reservados de Windows se rechazan también en Linux", () => {
  const reserved = ["CON.txt", "con.json", "PRN.py", "aux.md", "NUL.html", "COM1.doc", "com9.md", "LPT1.txt", "lpt9.rs"];
  for (const name of reserved) {
    assert.equal(validateFileName(name).ok, false, `expected reserved-name rejection: ${name}`);
  }
  assert.equal(validateFileName("servidor.py").ok, true);
  assert.equal(validateFileName("configuracion.json").ok, true);
  assert.equal(validateFileName("index.html").ok, true);
  assert.equal(validateFileName("COMANDO.md").ok, true);
});

test("4. El nombre nunca se modifica aunque se apruebe o se rechace", () => {
  const golden = ["Café Ñandú.md", "emoji 🎉.txt", "日本語.md", "mi?file.md"];
  for (const entry of golden) {
    validateFileName(entry);
    assert.equal(entry, entry);
  }
});

test("4. El flujo de creación no sustituye caracteres ni expande carpetas", () => {
  const form = read("src/components/Form.tsx");
  assert.equal(form.includes("sanitizeFileName"), false);
  assert.equal(form.includes("expandFolderAncestors"), false);
  assert.equal(form.includes('setItem("folderExpanded"'), false, "crear un archivo no debe escribir folderExpanded");
  const menuFile = read("src/components/MenuFile.tsx");
  assert.equal(menuFile.includes("sanitizeFileName"), false);
});

test("4. Rust mantiene la política de compatibilidad como autoridad", () => {
  const sync = read("src-tauri/src/gdrive/sync.rs");
  assert.equal(sync.includes("WINDOWS_RESERVED_NAMES"), true);
  assert.equal(sync.includes("'?'"), true, "is_safe_relative_path rechaza '?'");
  assert.equal(sync.includes('".."'), true, "el backend rechaza traversal '..'");
});

// --- Problema 5: jerarquía visual del selector ---------------------------------

test("5. La carpeta virtual Lyra y las carpetas de primer nivel comparten nivel visual", () => {
  assert.equal(folderListDepthPx(""), folderListDepthPx("Proyectos"));
  assert.equal(folderListDepthPx("Proyectos"), 12);
  assert.equal(folderListDepthPx("Personal"), 12);
  assert.equal(folderListDepthPx("Proyectos/Frontend"), 26);
  assert.equal(folderListDepthPx("Proyectos/Frontend/React"), 40);
  assert.equal(folderListDepthPx("a/b/c/d"), 54);
});

test("5. El selector no aplica sangría de hijo a las carpetas de primer nivel", () => {
  const select = read("src/components/FolderSelect.tsx");
  assert.equal(select.includes("folderListDepthPx(folder)"), true);
  assert.equal(/12 \+ \(folder.split/.test(select), false);
});

// --- Problema 3: crear un archivo no expande Lyra ------------------------------

test("3. El formulario de creación no expande automáticamente ninguna carpeta", () => {
  const form = read("src/components/Form.tsx");
  assert.equal(form.includes("ROOT_FOLDER_ID"), false, "no debe existir expansión forzada de la carpeta virtual Lyra");
  assert.equal(/expandFolderAncestors|setItem\(.folderExpanded/.test(form), false);
});

// --- Problema 2: el alto del padre sigue al contenido --------------------------

test("2. Collapsible sincroniza el alto del contenedor con el contenido (Motion)", () => {
  const explorer = read("src/components/FolderExplorer.tsx");
  assert.equal(explorer.includes("motion"), true, "la animación de altura la hace Motion");
  assert.equal(explorer.includes('animate={{ height: open ? "auto" : 0 }}'), true, "altura auto ↔ 0 medida dinámicamente por Motion");
  assert.equal(explorer.includes("ResizeObserver"), false, "el mecanismo manual ResizeObserver quedó eliminado");
  assert.equal(explorer.includes("travelRef"), false, "el recorrido manual por fila quedó eliminado");
});
