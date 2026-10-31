import { Store } from "./store";
import type { Draft } from "./sender";

/** Items staged on the home screen before a share starts. */
export const draft = new Store<Draft>({ files: [], texts: [] });

function key(f: { file: File; path?: string }) {
  return `${f.path ?? f.file.name}:${f.file.size}:${f.file.lastModified}`;
}

export function addFiles(
  files: Iterable<File | { file: File; path?: string }>,
) {
  const incoming = [...files].map((f) =>
    f instanceof File
      ? { file: f, path: f.webkitRelativePath || undefined }
      : f,
  );
  draft.set((d) => {
    const seen = new Set(d.files.map(key));
    return {
      files: [
        ...d.files,
        ...incoming.filter((f) => !seen.has(key(f)) && seen.add(key(f))),
      ],
    };
  });
}

export function addText(text: string) {
  const t = text.trim();
  if (t) draft.set((d) => ({ texts: [...d.texts, t] }));
}

export function removeFile(i: number) {
  draft.set((d) => ({ files: d.files.filter((_, j) => j !== i) }));
}

export function removeText(i: number) {
  draft.set((d) => ({ texts: d.texts.filter((_, j) => j !== i) }));
}

export function clearDraft() {
  draft.set({ files: [], texts: [] });
}

/** Expand dropped folders (Chromium, Safari and Firefox support webkitGetAsEntry). */
export async function filesFromDataTransfer(
  dt: DataTransfer,
): Promise<{ file: File; path?: string }[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) return [...dt.files].map((file) => ({ file }));

  const out: { file: File; path?: string }[] = [];
  const walk = async (
    entry: FileSystemEntry,
    prefix: string,
  ): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) =>
        (entry as FileSystemFileEntry).file(res, rej),
      );
      out.push({ file, path: prefix ? `${prefix}/${file.name}` : undefined });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const dir = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
          reader.readEntries(res, rej),
        );
        if (batch.length === 0) break;
        for (const e of batch) await walk(e, dir);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}
