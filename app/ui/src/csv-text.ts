/** Keep text literal in spreadsheets; numeric columns choose their own serialization. */
export function csvText(text: string): string {
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\u0000-\u001f]/.test(text)) return `'${text}`;
  return text;
}
