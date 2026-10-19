export const MAX_TEXT_BYTES = 1024 * 1024;
export type LineEnding = 'lf' | 'crlf';
export function openText(content: string) {
  const bom = content.startsWith('\uFEFF');
  const body = bom ? content.slice(1) : content;
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/(?<!\r)\n/g) || []).length;
  return { text: body.replace(/\r\n/g, '\n'), bom, lineEnding: (crlf && !lf ? 'crlf' : 'lf') as LineEnding, mixed: !!(crlf && lf) };
}
export function saveText(text: string, bom: boolean, lineEnding: LineEnding) {
  return (bom ? '\uFEFF' : '') + (lineEnding === 'crlf' ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));
}
export const textBytes = (content: string) => new TextEncoder().encode(content).length;
