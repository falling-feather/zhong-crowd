export const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const number = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
export const pad = (value: number) => String(value).padStart(2, '0');
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少界面区域 ${id}`);
  return found as T;
}
