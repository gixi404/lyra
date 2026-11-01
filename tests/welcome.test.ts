import test from "node:test";
import assert from "node:assert";
import {
  ensureWelcomeFileState,
  autoArchiveWelcomeOnSync,
  handleWelcomeFileDeleted,
  isDefaultWelcomeContent,
  isWelcomeDismissed,
  isWelcomeFileName,
  WELCOME_FILE_NAME,
  type WelcomeFsOps,
  type WelcomeStorageOps,
} from "../src/utils/welcome.ts";
import { INTRO_ES } from "../src/utils/consts.ts";
import { setNotesDir } from "../src/utils/workspacePaths.ts";

const MAIN_FOLDER = "lyra/workspaces/ws_001";

test("FIX-001 edited welcome content is not treated as original", () => {
  assert.equal(isDefaultWelcomeContent(INTRO_ES), true);
  assert.equal(isDefaultWelcomeContent(`${INTRO_ES}\nPersonal note`), false);
  assert.equal(isDefaultWelcomeContent(INTRO_ES.replace("Bienvenido", "BIENVENIDO")), false);
});

function createMockEnvironment(initialFiles: Record<string, string> = {}, initialStorage: Record<string, string> = {}) {
  setNotesDir(MAIN_FOLDER);
  const fileMap = new Map<string, string>();
  for (const [k, v] of Object.entries(initialFiles)) {
    const fullKey = k.startsWith(`${MAIN_FOLDER}/`) ? k : `${MAIN_FOLDER}/${k}`;
    fileMap.set(fullKey, v);
  }

  const storageMap = new Map<string, string>(Object.entries(initialStorage));
  let tombstoneCount = 0;

  const fsOps: WelcomeFsOps = {
    exists: async (path: string) => {
      if (path === MAIN_FOLDER) return true;
      return fileMap.has(path);
    },
    mkdir: async (_path: string) => {},
    readDir: async (_path: string) => {
      const results: { name: string; isFile: boolean }[] = [];
      for (const key of fileMap.keys()) {
        if (key.startsWith(`${MAIN_FOLDER}/`)) {
          const name = key.slice(MAIN_FOLDER.length + 1);
          if (!name.includes("/")) {
            results.push({ name, isFile: true });
          }
        }
      }
      return results;
    },
    readTextFile: async (path: string) => {
      const content = fileMap.get(path);
      if (content === undefined) {
        throw new Error(`File not found: ${path}`);
      }
      return content;
    },
    writeTextFile: async (path: string, content: string, options?: any) => {
      if (options?.createNew && fileMap.has(path)) {
        throw new Error(`AlreadyExists: ${path}`);
      }
      fileMap.set(path, content);
    },
  };

  const storageOps: WelcomeStorageOps = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageMap.set(key, value);
    },
    removeItem: (key: string) => {
      storageMap.delete(key);
    },
  };

  // Simular la llamada a eliminación que generaría un tombstone
  const simulateDeleteFile = async (name: string) => {
    handleWelcomeFileDeleted(name, storageOps);
    fileMap.delete(`${MAIN_FOLDER}/${name}`);
    tombstoneCount++;
  };

  return {
    fileMap,
    storageMap,
    fsOps,
    storageOps,
    simulateDeleteFile,
    getTombstoneCount: () => tombstoneCount,
  };
}

test("1. Carpeta local vacía: se crea automáticamente el archivo de bienvenida", async () => {
  const env = createMockEnvironment();
  const res = await ensureWelcomeFileState(env.fsOps, env.storageOps);

  assert.strictEqual(res.created, true);
  assert.strictEqual(res.activeWelcome, WELCOME_FILE_NAME);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);
  assert.strictEqual(env.fileMap.get(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), INTRO_ES);
});

test("2. El archivo de bienvenida aparece y puede abrirse y leerse", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  const dir = await env.fsOps.readDir(MAIN_FOLDER);
  const welcomeEntry = dir.find(f => isWelcomeFileName(f.name));
  assert.ok(welcomeEntry, "El archivo de bienvenida debe estar presente en el directorio");
  assert.strictEqual(welcomeEntry.name, WELCOME_FILE_NAME);

  const readContent = await env.fsOps.readTextFile(`${MAIN_FOLDER}/${welcomeEntry.name}`);
  assert.strictEqual(readContent, INTRO_ES);
  assert.strictEqual(isDefaultWelcomeContent(readContent), true);
});

test("3. Reiniciar Lyra no crea duplicados del archivo de bienvenida", async () => {
  const env = createMockEnvironment();
  // Primer inicio
  await ensureWelcomeFileState(env.fsOps, env.storageOps);
  const filesFirst = await env.fsOps.readDir(MAIN_FOLDER);
  assert.strictEqual(filesFirst.length, 1);

  // Segundo inicio (reinicio de Lyra)
  const resSecond = await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(resSecond.created, false);
  assert.strictEqual(resSecond.activeWelcome, WELCOME_FILE_NAME);

  const filesSecond = await env.fsOps.readDir(MAIN_FOLDER);
  assert.strictEqual(filesSecond.length, 1);
  assert.strictEqual(filesSecond[0].name, WELCOME_FILE_NAME);
});

test("4. Carpeta local con notas existentes: no se crea el archivo de bienvenida", async () => {
  const env = createMockEnvironment({
    "Mi primera nota.txt": "Contenido de usuario",
  });
  const res = await ensureWelcomeFileState(env.fsOps, env.storageOps);

  assert.strictEqual(res.created, false);
  assert.strictEqual(res.activeWelcome, null);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), false);
  const dir = await env.fsOps.readDir(MAIN_FOLDER);
  assert.strictEqual(dir.length, 1);
  assert.strictEqual(dir[0].name, "Mi primera nota.txt");
});

test("5. Google Drive vacío: permanece sin archivar y visible", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  // Sincronización con Drive vacío (0 notas descargadas)
  const autoArchived = await autoArchiveWelcomeOnSync([], env.fsOps, env.storageOps);
  assert.strictEqual(autoArchived, false);

  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.deepStrictEqual(paper, []);
});

test("6. Google Drive con notas: se archiva automáticamente tras descargarlas correctamente", async () => {
  const env = createMockEnvironment();
  // Inicialmente carpeta vacía: se crea bienvenida
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  // Sincronización descarga notas reales
  env.fileMap.set(`${MAIN_FOLDER}/Capitulo 1.txt`, "Texto del capítulo 1");
  const downloadedFiles = ["Capitulo 1.txt"];

  const autoArchived = await autoArchiveWelcomeOnSync(downloadedFiles, env.fsOps, env.storageOps);
  assert.strictEqual(autoArchived, true);

  // El archivo físico no fue borrado
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);

  // Figura en paper (archivados)
  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.ok(paper.includes(WELCOME_FILE_NAME));
});

test("7. Sin conexión: el archivo de bienvenida permanece visible y sin archivar", async () => {
  const env = createMockEnvironment();
  const res = await ensureWelcomeFileState(env.fsOps, env.storageOps);

  assert.strictEqual(res.created, true);
  assert.strictEqual(res.activeWelcome, WELCOME_FILE_NAME);

  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.deepStrictEqual(paper, []);
});

test("8. Error de sincronización: no se archiva prematuramente ni se elimina", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  // Simulación de error de sync (descargas vacías / fallo de red)
  const autoArchived = await autoArchiveWelcomeOnSync([], env.fsOps, env.storageOps);
  assert.strictEqual(autoArchived, false);

  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);
  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.deepStrictEqual(paper, []);
});

test("9. Sincronización repetida: no recrea ni desarchiva el archivo de bienvenida", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  // Primera sincronización
  env.fileMap.set(`${MAIN_FOLDER}/Nota A.txt`, "Nota A");
  await autoArchiveWelcomeOnSync(["Nota A.txt"], env.fsOps, env.storageOps);

  let paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.ok(paper.includes(WELCOME_FILE_NAME));

  // Segunda sincronización con más notas
  env.fileMap.set(`${MAIN_FOLDER}/Nota B.txt`, "Nota B");
  const secondArchiveAttempt = await autoArchiveWelcomeOnSync(["Nota B.txt"], env.fsOps, env.storageOps);
  assert.strictEqual(secondArchiveAttempt, false); // Ya estaba archivado

  // Verificar estado con ensureWelcomeFileState
  const stateCheck = await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(stateCheck.created, false);
  assert.strictEqual(stateCheck.activeWelcome, null); // Sigue archivado, no activo

  paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.ok(paper.includes(WELCOME_FILE_NAME));
});

test("10. Archivo de bienvenida modificado por el usuario: se preservan los cambios y no se autoarchiva", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  // El usuario modifica el archivo
  const userText = "Mis notas personales escritas dentro del archivo de bienvenida.";
  env.fileMap.set(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`, userText);
  assert.strictEqual(isDefaultWelcomeContent(userText), false);

  // Sincronización descarga notas reales
  env.fileMap.set(`${MAIN_FOLDER}/Nota Remota.txt`, "Remoto");
  const autoArchived = await autoArchiveWelcomeOnSync(["Nota Remota.txt"], env.fsOps, env.storageOps);
  assert.strictEqual(autoArchived, false); // No debe autoarchivarse porque fue modificado

  // El archivo permanece con el texto del usuario
  assert.strictEqual(env.fileMap.get(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), userText);
  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.strictEqual(paper.includes(WELCOME_FILE_NAME), false);
});

test("11. Archivado automático: no genera tombstones incorrectos", async () => {
  const env = createMockEnvironment();
  await ensureWelcomeFileState(env.fsOps, env.storageOps);

  env.fileMap.set(`${MAIN_FOLDER}/Nota Remota.txt`, "Remoto");
  await autoArchiveWelcomeOnSync(["Nota Remota.txt"], env.fsOps, env.storageOps);

  // Verificar que el autoarchivado no involucró el canal de eliminación destructiva / tombstones
  assert.strictEqual(env.getTombstoneCount(), 0);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);
});

test("F3: a delayed sync welcome check cannot archive after switching workspaces", async () => {
  const env = createMockEnvironment({
    [WELCOME_FILE_NAME]: INTRO_ES,
    "Remote.md": "remote content",
  });
  const originalReadDir = env.fsOps.readDir;
  let signalStarted: () => void = () => {};
  let releaseRead: () => void = () => {};
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releaseRead = resolve; });
  env.fsOps.readDir = async path => {
    signalStarted();
    await blocked;
    return originalReadDir(path);
  };

  const pending = autoArchiveWelcomeOnSync(["Remote.md"], env.fsOps, env.storageOps);
  await started;
  setNotesDir("lyra/workspaces/ws_002");
  releaseRead();
  assert.equal(await pending, false);
  assert.equal(env.storageOps.getItem("paper"), null);
  setNotesDir(MAIN_FOLDER);
});

test("12. Eliminación intencional del archivo: no provoca recreaciones infinitas", async () => {
  const env = createMockEnvironment();
  // Se crea bienvenida inicialmente
  await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);

  // El usuario elimina intencionalmente el archivo de bienvenida
  await env.simulateDeleteFile(WELCOME_FILE_NAME);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), false);
  assert.strictEqual(isWelcomeDismissed(env.storageOps), true);

  // Aunque la carpeta quede completamente vacía, Lyra NO debe recrearlo
  const recreateAttempt1 = await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(recreateAttempt1.created, false);
  assert.strictEqual(recreateAttempt1.activeWelcome, null);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), false);

  const recreateAttempt2 = await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(recreateAttempt2.created, false);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), false);
});

test("13. Residuo de 'paper' en localStorage con carpeta vacía: se crea el archivo de bienvenida y se limpia de archivados", async () => {
  // Simular el caso reportado por el usuario: localStorage retiene un nombre legacy de bienvenida en paper
  const env = createMockEnvironment({}, {
    paper: JSON.stringify(["Bienvenido a Lyra.txt", "nota_vieja.txt"]),
  });

  const res = await ensureWelcomeFileState(env.fsOps, env.storageOps);
  assert.strictEqual(res.created, true, "Debe crear el archivo de bienvenida a pesar de nombres legacy en paper residual");
  assert.strictEqual(res.activeWelcome, WELCOME_FILE_NAME);
  assert.strictEqual(env.fileMap.has(`${MAIN_FOLDER}/${WELCOME_FILE_NAME}`), true);

  // Verificar que paper quedó limpio de cualquier nombre de bienvenida
  const paper = JSON.parse(env.storageOps.getItem("paper") || "[]");
  assert.strictEqual(paper.some((n: string) => isWelcomeFileName(n)), false);
});
