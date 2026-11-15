import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";

// 1. Verificación estática del código fuente de TinyEditor.tsx
test("EDITOR-001: TinyEditor.tsx no inyecta \\u200B en párrafos no vacíos con espacios finales", () => {
  const filePath = path.resolve(process.cwd(), "src/components/TinyEditor.tsx");
  const source = fs.readFileSync(filePath, "utf-8");

  // Debe tener la asignación limpia autorizada
  assert.match(
    source,
    /const safeContent = p\.length === 0 \? "\\u200B" : renderedContent;/,
    "safeContent debe usar exclusivamente p.length === 0 ? '\\u200B' : renderedContent"
  );

  // No debe contener la condición p.endsWith(" ") que provocaba la regresión
  assert.doesNotMatch(
    source,
    /p\.endsWith\(\s*["']\s*["']\s*\)/,
    "No debe existir chequeo de p.endsWith(' ') para inyectar \\u200B"
  );

  // Garantía de b512b71: los párrafos vacíos deben conservar \\u200B para evitar colapso en WebKit
  assert.ok(
    source.includes('p.length === 0 ? "\\u200B"'),
    "Garantía b512b71: párrafos vacíos deben inyectar \\u200B"
  );

  // Garantía de salto de línea final
  assert.ok(
    source.includes('content.endsWith("\\n") && <br aria-hidden="true" />'),
    "Garantía de salto de línea final con <br aria-hidden='true' /> debe conservarse"
  );
});

function isChromeAvailable(): boolean {
  try {
    execSync("google-chrome --version", { stdio: "ignore" });
    return true;
  } catch {
    try {
      execSync("chromium --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function isWebKit2Available(): boolean {
  try {
    execSync('python3 -c "import gi; gi.require_version(\'WebKit2\', \'4.1\'); from gi.repository import WebKit2"', { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Helper para detectar navegadores o motores disponibles
function getAvailableEngines(): { chrome: boolean; webkit2: boolean } {
  return {
    chrome: isChromeAvailable(),
    webkit2: isWebKit2Available(),
  };
}

// Script HTML/JS común que evalúa la geometría real con los estilos de TinyEditor
function generateLayoutFixtureHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
.editor-display-layer,
.editor-textarea {
  scrollbar-width: none !important;
  box-sizing: border-box;
  font-family: monospace;
  font-size: 20px;
  line-height: 1.9;
  letter-spacing: normal;
  padding-top: 70px;
  padding-bottom: 50px;
  padding-left: 48px;
  padding-right: 48px;
  width: 500px;
  height: 100px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: break-word;
  overflow-x: hidden;
  overflow-y: scroll;
  font-variant-ligatures: none;
}
.editor-display-layer::-webkit-scrollbar,
.editor-textarea::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
.editor-textarea {
  border: none;
  resize: none;
  outline: none;
}
</style>
</head>
<body>
<pre id="test-results"></pre>
<script>
try {
  const LF = String.fromCharCode(10);
  const ZWS = String.fromCharCode(8203);

  function buildLayers(content, useZwsOnTrailingSpace, customFont, customFontSize) {
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.width = '500px';

    const ta = document.createElement('textarea');
    ta.className = 'editor-textarea';
    ta.value = content;

    const display = document.createElement('div');
    display.className = 'editor-display-layer';

    if (customFont) {
      ta.style.fontFamily = customFont;
      display.style.fontFamily = customFont;
    }
    if (customFontSize) {
      ta.style.fontSize = customFontSize;
      display.style.fontSize = customFontSize;
    }

    const paragraphs = content.split(LF);
    paragraphs.forEach((p, i) => {
      const isLast = i === paragraphs.length - 1;
      let safeContent;
      if (useZwsOnTrailingSpace) {
        safeContent = p.length === 0 ? ZWS : (p.endsWith(' ') ? (p + ZWS) : p);
      } else {
        safeContent = p.length === 0 ? ZWS : p;
      }
      const span = document.createElement('span');
      span.className = 'editor-para';
      span.textContent = safeContent + (!isLast ? LF : '');
      display.appendChild(span);
    });

    if (content.endsWith(LF)) {
      const br = document.createElement('br');
      br.setAttribute('aria-hidden', 'true');
      display.appendChild(br);
    }

    container.appendChild(display);
    container.appendChild(ta);
    document.body.appendChild(container);

    const taScrollH = ta.scrollHeight;
    const displayScrollH = display.scrollHeight;
    document.body.removeChild(container);

    return { taScrollH, displayScrollH, diff: displayScrollH - taScrollH };
  }

  // Búsqueda del caso límite donde el espacio cuelga en textarea pero ZWS fuerza salto de línea
  let trailingSpaceOld = null;
  let trailingSpaceNew = null;
  for (let len = 30; len <= 36; len++) {
    const text = 'a'.repeat(len) + ' ';
    const oldRes = buildLayers(text, true);
    const newRes = buildLayers(text, false);
    if (oldRes.diff !== 0 && newRes.diff === 0) {
      trailingSpaceOld = { len, ...oldRes };
      trailingSpaceNew = { len, ...newRes };
      break;
    }
  }

  // Garantías b512b71
  const longText = 'Line 1' + LF + 'Line 2' + LF + 'Line 3' + LF + 'Line 4' + LF + 'Line 5' + LF + 'Line 6';
  const longDoc = buildLayers(longText, false);
  const trailingNewlineDoc = buildLayers('Hola' + LF + 'Mundo' + LF, false);
  const consecutiveEmpty = buildLayers('A' + LF + LF + LF + 'B' + LF + LF + 'C', false);
  const spacesOnly = buildLayers('   ' + LF + '      ' + LF + ' ', false);

  const results = {
    trailingSpaceOld,
    trailingSpaceNew,
    longDoc,
    trailingNewlineDoc,
    consecutiveEmpty,
    spacesOnly
  };

  window.__testResult = JSON.stringify(results);
  const pre = document.getElementById('test-results');
  if (pre) pre.textContent = window.__testResult;
} catch(e) {
  window.__testResult = JSON.stringify({ error: e.message, stack: e.stack });
  const pre = document.getElementById('test-results');
  if (pre) pre.textContent = window.__testResult;
}
</script>
</body>
</html>`;
}

interface LayoutResults {
  trailingSpaceOld: { len: number; taScrollH: number; displayScrollH: number; diff: number } | null;
  trailingSpaceNew: { len: number; taScrollH: number; displayScrollH: number; diff: number } | null;
  longDoc: { taScrollH: number; displayScrollH: number; diff: number };
  trailingNewlineDoc: { taScrollH: number; displayScrollH: number; diff: number };
  consecutiveEmpty: { taScrollH: number; displayScrollH: number; diff: number };
  spacesOnly: { taScrollH: number; displayScrollH: number; diff: number };
  error?: string;
}

function runChromeLayoutTest(fixturePath: string): LayoutResults {
  const chromeBin = fs.existsSync("/usr/bin/google-chrome") ? "google-chrome" : "chromium";
  const cmd = `${chromeBin} --headless=new --disable-gpu --virtual-time-budget=1000 --dump-dom file://${fixturePath}`;
  const stdout = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
  const match = stdout.match(/<pre id=["']test-results["']>([\s\S]*?)<\/pre>/);
  if (!match || !match[1]) {
    throw new Error("No se pudo obtener el resultado de Chromium headless");
  }
  return JSON.parse(match[1]);
}

function runWebKit2LayoutTest(fixturePath: string): LayoutResults {
  const pyScript = `
import gi
gi.require_version('WebKit2', '4.1')
from gi.repository import WebKit2, GLib
import sys

ctx = WebKit2.WebContext.get_default()
view = WebKit2.WebView.new_with_context(ctx)
loop = GLib.MainLoop()

def on_load_changed(web_view, load_event):
    if load_event == WebKit2.LoadEvent.FINISHED:
        def on_js_finished(wv, result, user_data):
            try:
                js_val = wv.run_javascript_finish(result)
                val = js_val.get_js_value()
                print(val.to_string())
            except Exception as e:
                print('{"error": "' + str(e) + '"}')
            finally:
                loop.quit()
        web_view.run_javascript('window.__testResult', None, on_js_finished, None)

view.connect('load-changed', on_load_changed)
view.load_uri('file://${fixturePath}')
loop.run()
`;
  const out = execFileSync("python3", ["-"], { input: pyScript, encoding: "utf-8", timeout: 10000 });
  const lines = out.trim().split("\n");
  const jsonLine = lines.find((l) => l.startsWith("{")) || "{}";
  return JSON.parse(jsonLine);
}

test("EDITOR-001: Validación de geometría y regresión en motores de renderizado reales", () => {
  const engines = getAvailableEngines();
  if (!engines.chrome && !engines.webkit2) {
    console.warn("ADVERTENCIA: Ni Chromium ni WebKitGTK 4.1 están disponibles en el entorno. Se omite la validación visual en vivo.");
    return;
  }

  const tmpFixture = path.resolve("/tmp", `lyra_geometry_fixture_${Date.now()}.html`);
  fs.writeFileSync(tmpFixture, generateLayoutFixtureHtml(), "utf-8");

  try {
    if (engines.chrome) {
      const res = runChromeLayoutTest(tmpFixture);
      assert.ok(!res.error, `Error en ejecución de Chromium: ${res.error}`);

      // 1. Demostración de que la implementación anterior con \\u200B fallaba (diff !== 0)
      assert.ok(
        res.trailingSpaceOld !== null,
        "Debe existir un caso límite donde \\u200B en espacios finales provoca discrepancia"
      );
      assert.equal(
        res.trailingSpaceOld.diff,
        38,
        `La implementación anterior debe provocar un desfase exacto de una línea (38px, detectado: ${res.trailingSpaceOld.diff}px)`
      );

      // 2. Demostración de que la implementación corregida pasa exactamente (diff === 0)
      assert.ok(res.trailingSpaceNew !== null);
      assert.equal(
        res.trailingSpaceNew.diff,
        0,
        "La implementación corregida debe tener exactamente diff = 0px en párrafos terminados en espacio"
      );

      // 3. Garantías de b512b71 preservadas
      assert.equal(res.longDoc.diff, 0, "Documentos largos deben sincronizar 0px de diferencia");
      assert.equal(res.trailingNewlineDoc.diff, 0, "Documentos con salto de línea final deben sincronizar 0px");
      assert.equal(res.consecutiveEmpty.diff, 0, "Líneas vacías consecutivas deben sincronizar 0px");
      assert.equal(res.spacesOnly.diff, 0, "Párrafos compuestos exclusivamente de espacios deben sincronizar 0px");
    }

    if (engines.webkit2) {
      const res = runWebKit2LayoutTest(tmpFixture);
      assert.ok(!res.error, `Error en ejecución de WebKitGTK: ${res.error}`);

      // 1. Demostración de que la implementación anterior con \\u200B fallaba en WebKitGTK
      assert.ok(
        res.trailingSpaceOld !== null,
        "WebKitGTK: Debe existir caso límite donde \\u200B causa discrepancia"
      );
      assert.equal(
        res.trailingSpaceOld.diff,
        38,
        `WebKitGTK: La implementación anterior debe provocar un desfase exacto de una línea (38px, detectado: ${res.trailingSpaceOld.diff}px)`
      );

      // 2. Demostración de que la implementación corregida pasa en WebKitGTK
      assert.ok(res.trailingSpaceNew !== null);
      assert.equal(
        res.trailingSpaceNew.diff,
        0,
        "WebKitGTK: La implementación corregida debe tener exactamente diff = 0px"
      );

      // 3. Garantías b512b71 preservadas en WebKitGTK
      assert.equal(res.longDoc.diff, 0, "WebKitGTK: Documentos largos deben sincronizar 0px");
      assert.equal(res.trailingNewlineDoc.diff, 0, "WebKitGTK: Salto de línea final debe sincronizar 0px");
      assert.equal(res.consecutiveEmpty.diff, 0, "WebKitGTK: Líneas vacías consecutivas deben sincronizar 0px");
      assert.equal(res.spacesOnly.diff, 0, "WebKitGTK: Párrafos de solo espacios deben sincronizar 0px");
    }
  } finally {
    if (fs.existsSync(tmpFixture)) {
      fs.unlinkSync(tmpFixture);
    }
  }
});
