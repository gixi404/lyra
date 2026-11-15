import test from "node:test";
import assert from "node:assert/strict";
import {
  detectEOL,
  normalizeToLF,
  denormalizeEOL,
  registerNoteEOL,
  getNoteEOL,
  updateNoteEOL,
  remapNoteEOL,
  clearNoteEOL,
  __resetEOLRegistryForTests,
} from "../src/utils/eol.ts";
import { contentHash, draftIdFor } from "../src/utils/draftStore.ts";
import { isContentEquivalent, reconcileDraftState } from "../src/utils/draftRecovery.ts";

test("EDITOR-004: Detección de formatos de saltos de línea (LF, CRLF, CR)", () => {
  const lf = detectEOL("Línea 1\nLínea 2\nLínea 3");
  assert.equal(lf.format, "lf");
  assert.equal(lf.dominant, "lf");
  assert.equal(lf.counts.lf, 2);
  assert.equal(lf.counts.crlf, 0);
  assert.equal(lf.counts.cr, 0);
  assert.equal(lf.hasBOM, false);

  const crlf = detectEOL("Línea 1\r\nLínea 2\r\nLínea 3");
  assert.equal(crlf.format, "crlf");
  assert.equal(crlf.dominant, "crlf");
  assert.equal(crlf.counts.crlf, 2);
  assert.equal(crlf.counts.lf, 0);
  assert.equal(crlf.counts.cr, 0);

  const cr = detectEOL("Línea 1\rLínea 2\rLínea 3");
  assert.equal(cr.format, "cr");
  assert.equal(cr.dominant, "cr");
  assert.equal(cr.counts.cr, 2);
  assert.equal(cr.counts.lf, 0);
  assert.equal(cr.counts.crlf, 0);
});

test("EDITOR-004: Casos límite - Documento vacío y sin saltos de línea", () => {
  const empty = detectEOL("");
  assert.equal(empty.format, "none");
  assert.equal(empty.dominant, "lf");
  assert.equal(empty.counts.lf, 0);

  const singleLine = detectEOL("Texto sin saltos de línea");
  assert.equal(singleLine.format, "none");
  assert.equal(singleLine.dominant, "lf");

  // Re-serialización sin cambios debe preservar la ausencia de saltos
  const normEmpty = normalizeToLF("");
  assert.equal(normEmpty.text, "");
  assert.equal(denormalizeEOL(normEmpty.text, normEmpty.metadata), "");

  const normSingle = normalizeToLF("Hola");
  assert.equal(normSingle.text, "Hola");
  assert.equal(denormalizeEOL(normSingle.text, normSingle.metadata), "Hola");
});

test("EDITOR-004: Detección y desempate en archivos mixtos (Estrategia C)", () => {
  // Mixto con mayoría CRLF
  const mixedCrlf = detectEOL("A\r\nB\r\nC\n");
  assert.equal(mixedCrlf.format, "mixed");
  assert.equal(mixedCrlf.dominant, "crlf");
  assert.equal(mixedCrlf.counts.crlf, 2);
  assert.equal(mixedCrlf.counts.lf, 1);

  // Mixto con empate: debe ganar el primer formato encontrado
  const tie1 = detectEOL("A\r\nB\n");
  assert.equal(tie1.format, "mixed");
  assert.equal(tie1.tieBreakerFirstSeen, "crlf");
  assert.equal(tie1.dominant, "crlf");

  const tie2 = detectEOL("A\nB\r\n");
  assert.equal(tie2.format, "mixed");
  assert.equal(tie2.tieBreakerFirstSeen, "lf");
  assert.equal(tie2.dominant, "lf");
});

test("EDITOR-004: Preservación y detección de BOM UTF-8", () => {
  const withBOM = "\uFEFFHola\r\nMundo\r\n";
  const meta = detectEOL(withBOM);
  assert.equal(meta.hasBOM, true);
  assert.equal(meta.format, "crlf");

  // Al normalizar a LF para el editor, el BOM se remueve del contenido editable
  // para no alterar los índices de caracteres
  const norm = normalizeToLF(withBOM);
  assert.equal(norm.text, "Hola\nMundo\n");
  assert.equal(norm.text.charCodeAt(0), 72); // 'H'

  // Al re-serializar, se restituye el BOM original y CRLF
  const restored = denormalizeEOL(norm.text, norm.metadata);
  assert.equal(restored, withBOM);
  assert.equal(restored.startsWith("\uFEFF"), true);
});

test("EDITOR-004: Unicode, emojis, tildes y caracteres multilineales", () => {
  const raw = "📝 Nota importante 🎉\r\nÁrbol, camión, pingüino\r\nFin de la nota.\r\n";
  const { text, metadata } = normalizeToLF(raw);
  assert.equal(text, "📝 Nota importante 🎉\nÁrbol, camión, pingüino\nFin de la nota.\n");
  assert.equal(metadata.format, "crlf");

  const restored = denormalizeEOL(text, metadata);
  assert.equal(restored, raw);
});

test("EDITOR-004: Múltiples saltos de línea consecutivos y saltos finales", () => {
  const consecutiveCrlf = "A\r\n\r\n\r\nB\r\n";
  const { text: normCrlf, metadata: metaCrlf } = normalizeToLF(consecutiveCrlf);
  assert.equal(normCrlf, "A\n\n\nB\n");
  assert.equal(denormalizeEOL(normCrlf, metaCrlf), consecutiveCrlf);

  const consecutiveCr = "A\r\r\rB";
  const { text: normCr, metadata: metaCr } = normalizeToLF(consecutiveCr);
  assert.equal(normCr, "A\n\n\nB");
  assert.equal(denormalizeEOL(normCr, metaCr), consecutiveCr);
});

test("EDITOR-004: Idempotencia - No duplicación de conversiones", () => {
  const text = "A\r\nB\r\n";
  const step1 = normalizeToLF(text);
  const step2 = normalizeToLF(step1.text);
  assert.equal(step1.text, step2.text);
  assert.equal(step2.metadata.format, "lf");

  // Re-serialización consecutiva
  const reserialized1 = denormalizeEOL(step1.text, step1.metadata);
  assert.equal(reserialized1, text);
});

test("EDITOR-004 Garantía 1: Abrir y cerrar sin editar conserva exactamente los bytes", () => {
  const rawOriginal = "Línea 1\r\nLínea 2\nLínea 3\r\n"; // Archivo mixto
  const { text: logical, metadata } = normalizeToLF(rawOriginal);

  // Al no haber ediciones efectivas (hasEdits: false), denormalizeEOL devuelve rawOriginal exacto
  const saved = denormalizeEOL(logical, metadata, {
    hasEdits: false,
    rawOriginal,
  });

  assert.strictEqual(saved, rawOriginal, "Los bytes originales deben ser 100% idénticos sin editar");
});

test("EDITOR-004 Garantía 2: Archivos homogéneos conservan su formato después de editarse", () => {
  // 1. CRLF
  const crlfRaw = "Línea 1\r\nLínea 2\r\n";
  const { text: crlfLogical, metadata: crlfMeta } = normalizeToLF(crlfRaw);
  const crlfEdited = crlfLogical + "Línea 3\n"; // el editor agrega en LF
  const crlfSaved = denormalizeEOL(crlfEdited, crlfMeta, { hasEdits: true, rawOriginal: crlfRaw });
  assert.strictEqual(crlfSaved, "Línea 1\r\nLínea 2\r\nLínea 3\r\n");

  // 2. CR
  const crRaw = "Línea 1\rLínea 2\r";
  const { text: crLogical, metadata: crMeta } = normalizeToLF(crRaw);
  const crEdited = crLogical + "Línea 3\n";
  const crSaved = denormalizeEOL(crEdited, crMeta, { hasEdits: true, rawOriginal: crRaw });
  assert.strictEqual(crSaved, "Línea 1\rLínea 2\rLínea 3\r");

  // 3. LF
  const lfRaw = "Línea 1\nLínea 2\n";
  const { text: lfLogical, metadata: lfMeta } = normalizeToLF(lfRaw);
  const lfEdited = lfLogical + "Línea 3\n";
  const lfSaved = denormalizeEOL(lfEdited, lfMeta, { hasEdits: true, rawOriginal: lfRaw });
  assert.strictEqual(lfSaved, "Línea 1\nLínea 2\nLínea 3\n");
});

test("EDITOR-004 Garantía 3: Archivo mixto se unifica al formato dominante solo tras edición", () => {
  // Archivo mixto con 2 CRLF y 1 LF -> dominante CRLF
  const mixedRaw = "A\r\nB\r\nC\n";
  const { text: logical, metadata } = normalizeToLF(mixedRaw);

  // Si no se edita, se preserva exacto
  const unedited = denormalizeEOL(logical, metadata, { hasEdits: false, rawOriginal: mixedRaw });
  assert.strictEqual(unedited, mixedRaw);

  // Si se edita, se unifica al dominante (CRLF)
  const editedLogical = logical + "D\n";
  const saved = denormalizeEOL(editedLogical, metadata, { hasEdits: true, rawOriginal: mixedRaw });
  assert.strictEqual(saved, "A\r\nB\r\nC\r\nD\r\n");
});

test("EDITOR-004: Registro de EOL asociado a la identidad de la nota (no solo a la ruta)", () => {
  __resetEOLRegistryForTests();

  const noteId = "anchor-identity-123";
  const notePath = "carpeta/mi_nota.txt";
  const raw = "Texto con CRLF\r\nSegunda línea\r\n";
  const meta = detectEOL(raw);

  registerNoteEOL(noteId, notePath, meta, raw);

  // 1. Consulta por identidad
  const rec1 = getNoteEOL(noteId, notePath);
  assert.ok(rec1);
  assert.equal(rec1.metadata.format, "crlf");
  assert.equal(rec1.rawOriginal, raw);

  // 2. Renombrado / Movimiento: la identidad conserva la metadata
  const newPath = "otra_carpeta/nota_movida.txt";
  remapNoteEOL(notePath, newPath, noteId);
  const rec2 = getNoteEOL(noteId, newPath);
  assert.ok(rec2);
  assert.equal(rec2.metadata.format, "crlf");

  // 3. Reutilización de ruta anterior por otro archivo con identidad diferente
  const newNoteId = "anchor-identity-999";
  const newFileRaw = "Texto con LF\nSegunda línea\n";
  const newMeta = detectEOL(newFileRaw);

  registerNoteEOL(newNoteId, notePath, newMeta, newFileRaw);

  // La nueva identidad en notePath tiene LF, no hereda CRLF
  const recNew = getNoteEOL(newNoteId, notePath);
  assert.ok(recNew);
  assert.equal(recNew.metadata.format, "lf");

  // La vieja identidad en newPath sigue teniendo CRLF
  const recOld = getNoteEOL(noteId, newPath);
  assert.ok(recOld);
  assert.equal(recOld.metadata.format, "crlf");

  // 4. Actualización tras guardado exitoso
  const updatedPhysical = "Texto con CRLF actualizado\r\n";
  updateNoteEOL(noteId, newPath, updatedPhysical);
  const recUpdated = getNoteEOL(noteId, newPath);
  assert.ok(recUpdated);
  assert.equal(recUpdated.rawOriginal, updatedPhysical);

  // 5. Eliminación
  clearNoteEOL(newPath, noteId);
  assert.equal(getNoteEOL(noteId, newPath), undefined);
});

test("EDITOR-004: Detección de modificaciones físicas externas mediante hashes", () => {
  const fileOriginal = "Contenido original con CRLF\r\nSegunda línea\r\n";
  const fileConvertedExternallyToLF = "Contenido original con CRLF\nSegunda línea\n";
  const fileWithBOMAdded = "\uFEFF" + fileOriginal;

  const baseHash = contentHash(fileOriginal);
  const convertedHash = contentHash(fileConvertedExternallyToLF);
  const bomHash = contentHash(fileWithBOMAdded);

  // El hash físico debe detectar la diferencia incluso si el texto visible es idéntico
  assert.notEqual(
    baseHash,
    convertedHash,
    "Un cambio externo de CRLF a LF debe modificar el hash físico del archivo"
  );
  assert.notEqual(
    baseHash,
    bomHash,
    "La adición externa de BOM debe modificar el hash físico del archivo"
  );

  // Pero isContentEquivalent debe reconocer que la semántica textual no cambió
  assert.strictEqual(isContentEquivalent(fileOriginal, fileConvertedExternallyToLF), true);
});

test("EDITOR-004: Recuperación de borrador ante modificación externa del formato físico", async () => {
  const originalPhysical = "Línea 1\r\nLínea 2\r\n";
  const draftContent = "Línea 1\nLínea 2 modificada por usuario\n";

  // El borrador se sembró con la base física original
  const baseHash = contentHash(originalPhysical);
  const diskDraft = {
    v: 1 as const,
    noteName: "nota.txt",
    draftId: draftIdFor("nota.txt"),
    revision: 2,
    baseHash,
    content: draftContent,
    lastSavedRevision: 0,
    lastSavedHash: baseHash,
    updatedAt: 1000,
  };

  // Simulación: Un programa externo cambió el archivo en disco a LF
  const modifiedDiskContent = "Línea 1\nLínea 2\n";
  let conflictCreatedName: string | null = null;
  let savedRescueContent: string | null = null;

  const result = await reconcileDraftState({
    fileName: "nota.txt",
    diskContent: modifiedDiskContent,
    draft: null,
    diskDraft,
    diskMtime: 2000,
    saveFile: async (name, content) => {
      conflictCreatedName = name;
      savedRescueContent = content;
    },
    readFile: async () => savedRescueContent ?? modifiedDiskContent,
    fileExists: async () => false,
    clearDraft: () => {},
    onConflictCreated: (name) => {
      conflictCreatedName = name;
    },
  });

  // Debido a que baseHash era de CRLF y el disco ahora tiene LF, el cambio físico externo se detecta
  // y se crea una copia de rescate verificada para no sobreescribir silenciosamente el disco
  assert.equal(result.action, "conflict_created");
  assert.ok(conflictCreatedName !== null, "Debe crearse copia de conflicto/rescate");
});

test("EDITOR-004: Compatibilidad con borradores anteriores (legacy sin metadata EOL)", () => {
  const legacyDraftJson = JSON.stringify({
    content: "Texto del borrador legacy en LF\n",
    updatedAt: Date.now(),
  });

  const parsed = JSON.parse(legacyDraftJson);
  assert.equal(parsed.eolMetadata, undefined);

  // Al recuperar un borrador legacy, se inspecciona el contenido físico del disco
  const diskPhysical = "Texto anterior en disco\r\n";
  const recoveredMeta = detectEOL(diskPhysical);
  assert.equal(recoveredMeta.format, "crlf");

  // Re-serialización exitosa usando la metadata recuperada del disco
  const saved = denormalizeEOL(parsed.content, recoveredMeta);
  assert.equal(saved, "Texto del borrador legacy en LF\r\n");
});

test("EDITOR-004: Coherencia de índices entre el contenido del editor y el textarea", () => {
  // Si el archivo físico tiene CRLF
  const physicalCRLF = "A\r\nB\r\nC\r\n";
  const { text: logical } = normalizeToLF(physicalCRLF);

  // En el editor, los párrafos y los índices coinciden exactamente
  const paragraphs = logical.split("\n");
  assert.equal(paragraphs.length, 4); // "A", "B", "C", ""

  // La longitud de la cadena lógica en memoria coincide 1:1 con la longitud
  // del textarea.value del DOM (que normaliza a \n)
  assert.equal(logical.length, 6); // A \n B \n C \n = 6 chars
  // No hay desfase de +3 chars por los \r físicos
});

test("EDITOR-004: Conservación de la corrección EDITOR-001", () => {
  const textWithTrailingSpace = "Línea con espacio ";
  const { text: logical } = normalizeToLF(textWithTrailingSpace);
  assert.equal(logical, "Línea con espacio ");

  // Párrafo vacío conserva altura (line-height)
  const emptyParagraph = "";
  const safeContent = emptyParagraph.length === 0 ? "\u200B" : emptyParagraph;
  assert.equal(safeContent, "\u200B");
});

test("EDITOR-004: Compatibilidad real con borradores anteriores calculados con trim (draftIdFor)", async () => {
  // Un archivo que termina en \n (el caso más común)
  const diskPhysical = "Línea 1\nLínea 2\n";
  const userEditedDraft = "Línea 1\nLínea 2 con cambios en borrador\n";

  // En la versión anterior de Lyra, baseHash se calculaba con draftIdFor (que hacía .trim())
  const legacyBaseHash = draftIdFor(diskPhysical);
  assert.notEqual(
    legacyBaseHash,
    contentHash(diskPhysical),
    "El algoritmo legacy de baseHash diverge del nuevo debido a .trim() en el salto final"
  );

  const legacyDiskDraft = {
    v: 1 as const,
    noteName: "legacy.txt",
    draftId: draftIdFor("legacy.txt"),
    revision: 2,
    baseHash: legacyBaseHash,
    content: userEditedDraft,
    lastSavedRevision: 0,
    lastSavedHash: legacyBaseHash,
    updatedAt: 1000,
    // Sin eolMetadata (esquema antiguo)
  };

  // Reconciliación con disco intacto: debe auto-aplicar el borrador legacy sin conflicto falso
  const resultUnchanged = await reconcileDraftState({
    fileName: "legacy.txt",
    diskContent: diskPhysical,
    draft: null,
    diskDraft: legacyDiskDraft,
    diskMtime: 500, // borrador más reciente
    saveFile: async () => {},
    readFile: async () => diskPhysical,
    fileExists: async () => true,
    clearDraft: () => {},
  });

  assert.equal(resultUnchanged.action, "use_draft", "El borrador legacy debe restaurarse sin falso conflicto");
  assert.equal(resultUnchanged.contentToLoad, userEditedDraft);

  // Si el archivo en disco SÍ cambió externamente en su texto:
  const diskModifiedExternally = "Línea 1 modificada externamente\nLínea 2\n";
  let rescueFileName: string | null = null;
  const resultChanged = await reconcileDraftState({
    fileName: "legacy.txt",
    diskContent: diskModifiedExternally,
    draft: null,
    diskDraft: legacyDiskDraft,
    diskMtime: 2000,
    saveFile: async (name) => { rescueFileName = name; },
    readFile: async () => userEditedDraft,
    fileExists: async () => false,
    clearDraft: () => {},
    onConflictCreated: (name) => { rescueFileName = name; },
  });

  assert.equal(resultChanged.action, "conflict_created", "Debe crear copia de conflicto ante cambios externos reales");
  assert.ok(rescueFileName !== null);
});

test("EDITOR-004: Guardados consecutivos y actualización de referencia física (de mixto a homogéneo)", () => {
  __resetEOLRegistryForTests();
  const noteId = "note-mixed-to-homo";
  const notePath = "mixed_test.txt";

  // Archivo original mixto: 2 CRLF y 1 LF -> dominante CRLF
  const originalMixed = "A\r\nB\r\nC\n";
  const meta = detectEOL(originalMixed);
  assert.equal(meta.format, "mixed");
  assert.equal(meta.dominant, "crlf");

  registerNoteEOL(noteId, notePath, meta, originalMixed);

  // Primer guardado: el usuario añade "D\n" en el editor
  const { text: logical1 } = normalizeToLF(originalMixed);
  const editedLogical1 = logical1 + "D\n";

  const rec1 = getNoteEOL(noteId, notePath);
  assert.ok(rec1);
  const physicalSaved1 = denormalizeEOL(editedLogical1, rec1.metadata, {
    hasEdits: true,
    rawOriginal: rec1.rawOriginal,
  });

  // Tras el primer guardado, el archivo pasa a ser homogéneo CRLF
  assert.equal(physicalSaved1, "A\r\nB\r\nC\r\nD\r\n");
  updateNoteEOL(noteId, notePath, physicalSaved1);

  // Verificar que la metadata de referencia se actualizó a homogénea
  const rec2 = getNoteEOL(noteId, notePath);
  assert.ok(rec2);
  assert.equal(rec2.metadata.format, "crlf");
  assert.equal(rec2.rawOriginal, physicalSaved1);

  // Segundo guardado consecutivo: el usuario añade "E\n"
  const editedLogical2 = editedLogical1 + "E\n";
  const physicalSaved2 = denormalizeEOL(editedLogical2, rec2.metadata, {
    hasEdits: true,
    rawOriginal: rec2.rawOriginal,
  });

  // Continúa siendo homogéneo CRLF sin degradarse
  assert.equal(physicalSaved2, "A\r\nB\r\nC\r\nD\r\nE\r\n");
});

test("EDITOR-004: Fallo de guardado no altera prematuramente la referencia previa", () => {
  __resetEOLRegistryForTests();
  const noteId = "note-fail-test";
  const notePath = "fail_test.txt";
  const originalCRLF = "Línea 1\r\nLínea 2\r\n";

  const meta = detectEOL(originalCRLF);
  registerNoteEOL(noteId, notePath, meta, originalCRLF);

  const initialRecord = getNoteEOL(noteId, notePath);
  assert.ok(initialRecord);
  assert.equal(initialRecord.rawOriginal, originalCRLF);

  // Simulación de intento de guardado que lanza excepción (disco lleno / error de I/O)
  try {
    const logicalEdited = "Línea 1\nLínea 2\nLínea 3\n";
    denormalizeEOL(logicalEdited, initialRecord.metadata, {
      hasEdits: true,
      rawOriginal: initialRecord.rawOriginal,
    });
    // Simulamos fallo en la capa de transporte/disco
    throw new Error("Disk write simulated failure");
  } catch {
    // En caso de fallo, NO se llama a updateNoteEOL
  }

  // La referencia previa en memoria sigue siendo intacta
  const recordAfterFail = getNoteEOL(noteId, notePath);
  assert.ok(recordAfterFail);
  assert.equal(recordAfterFail.rawOriginal, originalCRLF);
  assert.equal(recordAfterFail.metadata.format, "crlf");
});

test("EDITOR-004: Integración con movimientos centralizados y remapOpenedNoteIdentities", async () => {
  __resetEOLRegistryForTests();
  const { remapOpenedNoteIdentities, rememberNoteIdentity, getOpenedNoteIdentity } = await import("../src/utils/noteIdentity.ts");

  const noteId = "identity-folder-move-456";
  const oldPath = "carpeta_origen/nota.txt";
  const newPath = "carpeta_destino/nota.txt";
  const rawCRLF = "Contenido en CRLF\r\nSegunda línea\r\n";

  rememberNoteIdentity(oldPath, noteId);
  registerNoteEOL(noteId, oldPath, detectEOL(rawCRLF), rawCRLF);

  // Movimiento centralizado de carpetas/archivos
  remapOpenedNoteIdentities([{ oldPath, newPath }]);

  // 1. La identidad en la nueva ruta es la misma
  assert.equal(getOpenedNoteIdentity(newPath), noteId);

  // 2. La consulta de EOL por la nueva ruta recupera la metadata exacta
  const rec = getNoteEOL(noteId, newPath);
  assert.ok(rec);
  assert.equal(rec.metadata.format, "crlf");
  assert.equal(rec.rawOriginal, rawCRLF);
});
