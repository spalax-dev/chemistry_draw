import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs';

const BINARY_EXTS = new Set(['png', 'jpeg', 'jpg', 'gif', 'bmp', 'pdf', 'cdx']);

function isTextMime(mime: string): boolean {
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'image/svg+xml' ||
    mime === 'application/xml'
  ) return true;
  if (mime.startsWith('chemical/')) return true;
  return false;
}

export async function saveAs(
  blobOrUrl: Blob | string,
  filename?: string,
  _opts?: { autoBom?: boolean },
): Promise<void> {
  if (typeof blobOrUrl === 'string') {
    const a = document.createElement('a');
    a.href = blobOrUrl;
    a.download = filename || 'download';
    a.click();
    return;
  }

  const name = filename || 'download';
  const ext = name.split('.').pop() ?? '';

  try {
    const filePath = await save({
      defaultPath: name,
      filters: [{ name: `${ext.toUpperCase()} Files`, extensions: [ext] }],
    });
    if (!filePath) return;

    if (!BINARY_EXTS.has(ext) && isTextMime(blobOrUrl.type)) {
      await writeTextFile(filePath, await blobOrUrl.text());
    } else {
      await writeFile(filePath, new Uint8Array(await blobOrUrl.arrayBuffer()));
    }
  } catch {
    const url = URL.createObjectURL(blobOrUrl);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}
