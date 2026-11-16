/**
 * An in-memory Obsidian vault: the subset of Vault, DataAdapter,
 * FileManager and MetadataCache that SyncEngine and the keychain use. It
 * mirrors one Obsidian behavior the engine depends on: the vault layer hides
 * dotfiles (TFolder.children, getFileByPath), the adapter does not.
 */

import { TFile, TFolder } from "obsidian";

interface Entry {
  data: Uint8Array;
  mtime: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function norm(path: string): string {
  return path === "/" ? "" : path.replace(/^\/+|\/+$/g, "");
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

export class FakeVault {
  private files = new Map<string, Entry>();
  private folders = new Set<string>([""]);
  private clock = 1_700_000_000_000;

  // ---- test helpers --------------------------------------------------

  /** An empty folder, as a user creates before mapping it on a new device. */
  mkdir(path: string): void {
    this.ensureFolder(norm(path));
  }

  put(path: string, content: string | Uint8Array): void {
    this.ensureFolder(parentOf(path));
    this.clock += 10_000;
    const data = typeof content === "string" ? enc.encode(content) : content.slice();
    this.files.set(path, { data, mtime: this.clock });
  }

  text(path: string): string {
    return dec.decode(this.bytes(path));
  }

  bytes(path: string): Uint8Array {
    const e = this.files.get(path);
    if (!e) throw new Error(`no such file: ${path}`);
    return e.data;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  move(from: string, to: string): void {
    const e = this.files.get(from);
    if (!e) throw new Error(`no such file: ${from}`);
    this.files.delete(from);
    this.ensureFolder(parentOf(to));
    this.files.set(to, e);
  }

  /** Every file under a folder, as vault paths, sorted. */
  filesUnder(folder: string): string[] {
    const prefix = norm(folder) + "/";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  // ---- Obsidian Vault API subset ---------------------------------------

  getName(): string {
    return "e2e-vault";
  }

  getRoot(): TFolder {
    return this.folderObj("");
  }

  getFolderByPath(path: string): TFolder | null {
    const p = norm(path);
    return this.folders.has(p) ? this.folderObj(p) : null;
  }

  getAllFolders(): TFolder[] {
    return [...this.folders].filter((p) => p !== "").map((p) => this.folderObj(p));
  }

  getFileByPath(path: string): TFile | null {
    if (baseName(path).startsWith(".")) return null;
    return this.files.has(path) ? this.fileObj(path) : null;
  }

  getFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((p) => !baseName(p).startsWith("."))
      .map((p) => this.fileObj(p));
  }

  async read(file: TFile): Promise<string> {
    return this.text(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return toBuffer(this.bytes(file.path));
  }

  async create(path: string, text: string): Promise<TFile> {
    if (this.files.has(path)) throw new Error("File already exists.");
    this.put(path, text);
    return this.fileObj(path);
  }

  async createBinary(path: string, buf: ArrayBuffer): Promise<TFile> {
    if (this.files.has(path)) throw new Error("File already exists.");
    this.put(path, new Uint8Array(buf));
    return this.fileObj(path);
  }

  async modify(file: TFile, text: string): Promise<void> {
    this.put(file.path, text);
  }

  async modifyBinary(file: TFile, buf: ArrayBuffer): Promise<void> {
    this.put(file.path, new Uint8Array(buf));
  }

  async createFolder(path: string): Promise<void> {
    const p = norm(path);
    if (this.folders.has(p)) throw new Error("Folder already exists.");
    this.ensureFolder(p);
  }

  adapter = {
    exists: async (path: string): Promise<boolean> =>
      this.files.has(norm(path)) || this.folders.has(norm(path)),
    read: async (path: string): Promise<string> => this.text(norm(path)),
    readBinary: async (path: string): Promise<ArrayBuffer> => toBuffer(this.bytes(norm(path))),
    write: async (path: string, text: string): Promise<void> => this.put(norm(path), text),
    writeBinary: async (path: string, buf: ArrayBuffer): Promise<void> =>
      this.put(norm(path), new Uint8Array(buf)),
    list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
      const p = norm(path);
      const prefix = p ? p + "/" : "";
      const direct = (q: string) => q.startsWith(prefix) && !q.slice(prefix.length).includes("/");
      return {
        files: [...this.files.keys()].filter(direct),
        folders: [...this.folders].filter((f) => f !== p && direct(f)),
      };
    },
    stat: async (path: string) => {
      const e = this.files.get(norm(path));
      return e ? { type: "file", size: e.data.byteLength, mtime: e.mtime, ctime: e.mtime } : null;
    },
    rmdir: async (path: string, recursive: boolean): Promise<void> => {
      const p = norm(path);
      const inside = (q: string) => q.startsWith(p + "/");
      if (!recursive && ([...this.files.keys()].some(inside) || [...this.folders].some(inside))) {
        throw new Error("Directory not empty");
      }
      for (const f of [...this.files.keys()]) if (inside(f)) this.files.delete(f);
      for (const f of [...this.folders]) if (f === p || inside(f)) this.folders.delete(f);
    },
    trashSystem: async (path: string): Promise<boolean> => {
      this.files.delete(norm(path));
      return true;
    },
    trashLocal: async (path: string): Promise<void> => {
      this.files.delete(norm(path));
    },
  };

  fileManager = {
    trashFile: async (file: TFile): Promise<void> => {
      this.files.delete(file.path);
    },
    renameFile: async (file: TFile, newPath: string): Promise<void> => {
      this.move(file.path, newPath);
    },
  };

  metadataCache = {
    getFirstLinkpathDest: (): null => null,
  };

  // ---- internals -------------------------------------------------------

  private ensureFolder(path: string): void {
    let p = norm(path);
    while (p !== "" && !this.folders.has(p)) {
      this.folders.add(p);
      p = parentOf(p);
    }
  }

  private fileObj(path: string): TFile {
    const e = this.files.get(path)!;
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    return Object.assign(new TFile(), {
      path,
      name,
      basename: dot > 0 ? name.slice(0, dot) : name,
      extension: dot > 0 ? name.slice(dot + 1) : "",
      stat: { size: e.data.byteLength, mtime: e.mtime, ctime: e.mtime },
    });
  }

  private folderObj(path: string): TFolder {
    const prefix = path ? path + "/" : "";
    const isChild = (q: string) =>
      q.startsWith(prefix) && q !== path && !q.slice(prefix.length).includes("/");
    const children = [
      ...[...this.folders].filter((f) => f !== "" && isChild(f)).map((f) => this.folderObj(f)),
      ...[...this.files.keys()].filter(isChild).map((f) => this.fileObj(f)),
    ].filter((c) => !c.name.startsWith("."));
    return Object.assign(new TFolder(), {
      path,
      name: path ? baseName(path) : "",
      children,
    });
  }
}
