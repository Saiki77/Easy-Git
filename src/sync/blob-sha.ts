const BASE64_CHUNK = 0x8000;

export async function computeGitBlobShaFromBytes(bytes: Uint8Array): Promise<string> {
  const header = `blob ${bytes.byteLength}\0`;
  const headerBytes = new TextEncoder().encode(header);
  const combined = new Uint8Array(headerBytes.byteLength + bytes.byteLength);
  combined.set(headerBytes, 0);
  combined.set(bytes, headerBytes.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", combined);
  return bytesToHex(new Uint8Array(digest));
}

export async function computeGitBlobShaFromString(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  return computeGitBlobShaFromBytes(bytes);
}

export async function computeGitBlobShaFromArrayBuffer(
  buf: ArrayBuffer,
): Promise<string> {
  return computeGitBlobShaFromBytes(new Uint8Array(buf));
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += BASE64_CHUNK) {
    const end = Math.min(i + BASE64_CHUNK, bytes.byteLength);
    const chunk = bytes.subarray(i, end);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export function stringToBase64(content: string): string {
  const bytes = new TextEncoder().encode(content);
  return arrayBufferToBase64(bytes.buffer);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const cleaned = b64.replace(/\s/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out.buffer;
}

export function base64ToString(b64: string): string {
  const buf = base64ToArrayBuffer(b64);
  return new TextDecoder().decode(buf);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

const TEXT_EXTENSIONS = new Set([
  "md", "markdown", "txt", "text", "json", "jsonc",
  "yaml", "yml", "toml", "ini", "cfg", "conf",
  "csv", "tsv",
  "html", "htm", "xml", "svg",
  "css", "scss", "sass", "less",
  "js", "mjs", "cjs", "jsx",
  "ts", "tsx",
  "py", "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "fish",
  "log",
  "gitignore", "gitattributes", "editorconfig", "npmrc",
]);

export function isLikelyTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    if (base === "readme" || base === "license" || base === "changelog") return true;
    return false;
  }
  const ext = path.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}
