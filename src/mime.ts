// Enough of a media-type table for the container header. The receiver only
// uses this to name and label the file, so an unknown extension is harmless.
const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html",
  ".js": "text/javascript", ".ts": "text/plain", ".css": "text/css",
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".zip": "application/zip", ".gz": "application/gzip",
  ".tar": "application/x-tar", ".7z": "application/x-7z-compressed",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".doc": "application/msword", ".key": "application/octet-stream",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}
