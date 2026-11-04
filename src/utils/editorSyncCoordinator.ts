import { getUpdateInstallInProgress } from "./editorPersistence.ts";

export interface EditorSyncCoordinatorOptions {
  fileName: string;
  initialContent: string;
  saveFileContent: (name: string, content: string) => Promise<void>;
  readFileContent: (name: string) => Promise<string>;
  writeDraft?: (name: string, content: string) => void;
  clearDraft?: (name: string) => void;
  onSaveSuccess?: (fileName: string, previousContent: string, currentContent: string) => void;
  onSaveError?: (fileName: string, content: string, error: unknown) => void;
  onContentReloaded?: (newContent: string) => void;
  onConflictCreated?: (conflictFileName: string, userEdits: string) => void;
  onRemoteDeleted?: (fileName: string, wasDirty: boolean) => void;
  scheduleCloudSync?: () => void;
  autosaveDebounceMs?: number;
  draftDebounceMs?: number;
  checkFileExists?: (name: string) => Promise<boolean>;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function generateConflictFileName(
  originalFileName: string,
  dateTag?: string,
  counter?: number
): string {
  const tag = dateTag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dotIdx = originalFileName.lastIndexOf(".");
  const stem = dotIdx !== -1 ? originalFileName.slice(0, dotIdx) : originalFileName;
  const ext = dotIdx !== -1 ? originalFileName.slice(dotIdx) : ".txt";
  const suffix = counter && counter > 0 ? ` (${counter})` : "";
  return `${stem} (edición local ${tag})${suffix}${ext}`;
}

export async function resolveUniqueConflictFileName(
  originalFileName: string,
  checkExists: (name: string) => Promise<boolean>,
  dateTag?: string
): Promise<string> {
  const fixedTag = dateTag ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = generateConflictFileName(originalFileName, fixedTag);
  if (!(await checkExists(baseName))) {
    return baseName;
  }

  let counter = 1;
  while (counter < 1000) {
    const candidateName = generateConflictFileName(originalFileName, fixedTag, counter);
    if (!(await checkExists(candidateName))) {
      return candidateName;
    }
    counter++;
  }
  return generateConflictFileName(originalFileName, fixedTag, counter);
}

export class EditorSyncCoordinator {
  private fileName: string;
  private initialContent: string;
  private latestContent: string;
  private latestPersistedContent: string;
  private lastSyncedContent: string;
  private isDirty: boolean;
  private hasUnsyncedLocalChanges: boolean = false;

  private editRevision = 0;
  private persistedRevision = 0;
  private inFlightSyncRevision = 0;
  private syncedRevision = 0;
  private inFlightSyncContent = "";

  private saveSeq = 0;
  private inFlightSeq = 0;
  private saveQueue: Promise<void> = Promise.resolve();

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  private options: EditorSyncCoordinatorOptions;

  constructor(options: EditorSyncCoordinatorOptions) {
    this.options = options;
    this.fileName = options.fileName;
    this.initialContent = options.initialContent;
    this.latestContent = options.initialContent;
    this.latestPersistedContent = options.initialContent;
    this.lastSyncedContent = options.initialContent;
    this.isDirty = false;
    this.hasUnsyncedLocalChanges = false;
    this.editRevision = 0;
    this.persistedRevision = 0;
    this.inFlightSyncRevision = 0;
    this.syncedRevision = 0;
    this.inFlightSyncContent = "";
  }

  public getIsDirty(): boolean {
    return this.isDirty;
  }

  public getHasUnsyncedChanges(): boolean {
    if (this.isDirty) {
      return true;
    }
    if (normalizeText(this.latestPersistedContent) === normalizeText(this.lastSyncedContent)) {
      return false;
    }
    if (this.persistedRevision > this.syncedRevision) {
      return true;
    }
    return this.hasUnsyncedLocalChanges;
  }

  public markSyncInFlight(): void {
    this.inFlightSyncRevision = this.persistedRevision;
    this.inFlightSyncContent = this.latestPersistedContent;
  }

  public handleSyncError(): void {
    this.inFlightSyncRevision = 0;
    this.inFlightSyncContent = "";
  }

  public markSynced(): void {
    if (!this.isDirty) {
      this.syncedRevision = this.persistedRevision;
      this.lastSyncedContent = this.latestPersistedContent;
      this.hasUnsyncedLocalChanges = false;
      this.inFlightSyncRevision = 0;
      this.inFlightSyncContent = "";
    }
  }

  public getEditRevision(): number {
    return this.editRevision;
  }

  public getPersistedRevision(): number {
    return this.persistedRevision;
  }

  public getSyncedRevision(): number {
    return this.syncedRevision;
  }

  public getLastSyncedContent(): string {
    return this.lastSyncedContent;
  }

  public getFileName(): string {
    return this.fileName;
  }

  public getLatestContent(): string {
    return this.latestContent;
  }

  public getLatestPersistedContent(): string {
    return this.latestPersistedContent;
  }

  public getInitialContent(): string {
    return this.initialContent;
  }

  public updateOptions(options: Partial<EditorSyncCoordinatorOptions>): void {
    if (options.fileName && options.fileName !== this.fileName) {
      throw new Error("Changing documents requires a new editor session");
    }
    this.options = { ...this.options, ...options };
  }

  public setCleanContent(content: string, fileName?: string): void {
    if (fileName && fileName !== this.fileName) {
      throw new Error("Clean content belongs to another editor session");
    }
    this.initialContent = content;
    this.latestContent = content;
    this.latestPersistedContent = content;
    this.lastSyncedContent = content;
    this.editRevision = 0;
    this.persistedRevision = 0;
    this.inFlightSyncRevision = 0;
    this.syncedRevision = 0;
    this.inFlightSyncContent = "";
    this.isDirty = false;
    this.hasUnsyncedLocalChanges = false;
  }

  public handleUserContentChange(nextContent: string): void {
    if (getUpdateInstallInProgress()) return;
    this.editRevision++;
    this.isDirty = true;
    this.hasUnsyncedLocalChanges = true;
    this.latestContent = nextContent;

    // Programar guardado en borrador
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
    }
    const draftMs = this.options.draftDebounceMs ?? 250;
    this.draftTimer = setTimeout(() => {
      if (this.isDirty && this.options.writeDraft) {
        this.options.writeDraft(this.fileName, this.latestContent);
      }
      this.draftTimer = null;
    }, draftMs);

    // Programar autoguardado en disco
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
    }
    const autosaveMs = this.options.autosaveDebounceMs ?? 400;
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.persistLatestToDisk();
    }, autosaveMs);
  }

  public persistLatestToDisk(): Promise<boolean> {
    const targetFileName = this.fileName;
    if (!targetFileName || !this.isDirty) {
      return Promise.resolve(true);
    }

    const snapshotToPersist = this.latestContent;
    const currentEditRev = this.editRevision;

    if (normalizeText(snapshotToPersist) === normalizeText(this.latestPersistedContent)) {
      this.isDirty = false;
      if (normalizeText(this.latestPersistedContent) === normalizeText(this.lastSyncedContent)) {
        this.hasUnsyncedLocalChanges = false;
      }
      if (this.options.clearDraft) {
        this.options.clearDraft(targetFileName);
      }
      return Promise.resolve(true);
    }

    const currentSeq = ++this.saveSeq;

    let writeSucceeded = false;
    this.saveQueue = this.saveQueue.then(async () => {
      // Si la secuencia fue invalidada (por sincronización concurrente), omitir escritura
      if (currentSeq < this.inFlightSeq) {
        return;
      }
      this.inFlightSeq = currentSeq;

      try {
        await this.options.saveFileContent(targetFileName, snapshotToPersist);
        writeSucceeded = true;
        const previousSnapshot = this.initialContent;
        this.initialContent = snapshotToPersist;

        if (this.fileName === targetFileName) {
          this.latestPersistedContent = snapshotToPersist;
          this.persistedRevision = Math.max(this.persistedRevision, currentEditRev);
          if (this.latestContent === snapshotToPersist) {
            this.isDirty = false;
            if (this.options.clearDraft) {
              this.options.clearDraft(targetFileName);
            }
          }
          if (this.options.onSaveSuccess) {
            this.options.onSaveSuccess(targetFileName, previousSnapshot, snapshotToPersist);
          }
          if (this.options.scheduleCloudSync) {
            this.options.scheduleCloudSync();
          }
        }
      } catch (err) {
        writeSucceeded = false;
        if (this.options.writeDraft) {
          this.options.writeDraft(targetFileName, snapshotToPersist);
        }
        if (this.options.onSaveError) {
          this.options.onSaveError(targetFileName, snapshotToPersist, err);
        }
      }
    });

    return this.saveQueue.then(() => writeSucceeded);
  }

  public flushAutosave(): Promise<boolean> {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (!this.isDirty) return this.saveQueue.then(() => !this.isDirty);
    return this.persistLatestToDisk();
  }

  public flushDraft(): void {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    if (this.isDirty && this.options.writeDraft) {
      this.options.writeDraft(this.fileName, this.latestContent);
    }
  }

  public async handleSyncFinished(payload: {
    downloaded: string[];
    deleted_remote: string[];
    uploaded?: string[];
  }): Promise<void> {
    const currentFile = this.fileName;
    if (!currentFile) return;

    // Si nuestro archivo local fue subido exitosamente a Google Drive
    if (payload.uploaded && payload.uploaded.includes(currentFile)) {
      const revisionSynced =
        this.inFlightSyncRevision > 0 ? this.inFlightSyncRevision : this.persistedRevision;
      const contentSynced = this.inFlightSyncContent || this.latestPersistedContent;

      this.syncedRevision = Math.max(this.syncedRevision, revisionSynced);
      this.lastSyncedContent = contentSynced;

      if (!this.isDirty && this.persistedRevision <= this.syncedRevision) {
        this.hasUnsyncedLocalChanges = false;
      }
    }
    this.inFlightSyncRevision = 0;
    this.inFlightSyncContent = "";

    // 1. Archivo eliminado remotamente
    if (payload.deleted_remote.includes(currentFile)) {
      if (this.options.onRemoteDeleted) {
        this.options.onRemoteDeleted(currentFile, this.isDirty);
      }
      if (!this.isDirty) {
        return;
      }
    }

    // 2. Archivo descargado o actualizado desde Drive
    if (payload.downloaded.includes(currentFile)) {
      this.flushDraft();
      // Paso 1: Cancelar inmediatamente temporizadores pendientes
      if (this.autosaveTimer) {
        clearTimeout(this.autosaveTimer);
        this.autosaveTimer = null;
      }
      if (this.draftTimer) {
        clearTimeout(this.draftTimer);
        this.draftTimer = null;
      }

      // Paso 2: Invalidar cualquier escritura encolada previa
      this.inFlightSeq = ++this.saveSeq;

      // Paso 3: Esperar que cualquier escritura física en curso concluya
      await this.saveQueue;

      if (this.fileName !== currentFile) return;

      // Paso 4: Leer el contenido remoto fresco desde el disco
      const freshContent = await this.options.readFileContent(currentFile);

      if (this.fileName !== currentFile) return;

      if (!this.isDirty) {
        // Caso A: El usuario no tenía ediciones pendientes
        this.latestContent = freshContent;
        this.latestPersistedContent = freshContent;
        this.initialContent = freshContent;
        this.lastSyncedContent = freshContent;
        this.editRevision = 0;
        this.persistedRevision = 0;
        this.syncedRevision = 0;
        this.inFlightSyncRevision = 0;
        this.inFlightSyncContent = "";
        this.isDirty = false;
        this.hasUnsyncedLocalChanges = false;
        if (this.options.clearDraft) {
          this.options.clearDraft(currentFile);
        }
        if (this.options.onContentReloaded) {
          this.options.onContentReloaded(freshContent);
        }
      } else {
        // Caso B: El usuario tenía cambios en curso (carrera concurrente).
        // Se preservan los cambios locales en un archivo de conflicto único separado
        const checkExists =
          this.options.checkFileExists ??
          (async (name: string) => {
            try {
              const res = await this.options.readFileContent(name);
              return typeof res === "string";
            } catch {
              return false;
            }
          });
        const conflictName = await resolveUniqueConflictFileName(currentFile, checkExists);
        const dirtySnapshot = this.latestContent;
        const snapshotRevision = this.editRevision;

        await this.options.saveFileContent(conflictName, dirtySnapshot);
        if (this.options.onConflictCreated) {
          this.options.onConflictCreated(conflictName, dirtySnapshot);
        }
        if (this.editRevision !== snapshotRevision) {
          return;
        }

        // Cargar en la nota activa la versión remota
        this.latestContent = freshContent;
        this.latestPersistedContent = freshContent;
        this.initialContent = freshContent;
        this.lastSyncedContent = freshContent;
        this.editRevision = 0;
        this.persistedRevision = 0;
        this.syncedRevision = 0;
        this.inFlightSyncRevision = 0;
        this.inFlightSyncContent = "";
        this.isDirty = false;
        this.hasUnsyncedLocalChanges = false;
        if (this.options.clearDraft) {
          this.options.clearDraft(currentFile);
        }
        if (this.options.onContentReloaded) {
          this.options.onContentReloaded(freshContent);
        }
      }
    }
  }

  public handleUnmount(): Promise<boolean> {
    this.flushDraft();
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    return this.saveQueue.then(() => this.isDirty ? this.persistLatestToDisk() : true);
  }
}
