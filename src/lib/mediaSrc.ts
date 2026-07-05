import { convertFileSrc } from "@tauri-apps/api/core";

export function mediaFileSrc(path: string, version?: string): string {
  const src = convertFileSrc(path);
  if (!version) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}v=${encodeURIComponent(version)}`;
}
