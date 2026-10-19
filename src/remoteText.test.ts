import { describe, it, expect } from 'vitest';
import { openText, saveText, textBytes, MAX_TEXT_BYTES } from './remoteText';
describe('remote text encoding', () => {
  it('round trips UTF-8 BOM, CRLF, Chinese, trailing newline and empty files', () => {
    for (const content of ['\uFEFF中文\r\n第二行\r\n', 'hello\n', '', '\uFEFF', 'no newline']) {
      const opened = openText(content);
      expect(saveText(opened.text, opened.bom, opened.lineEnding)).toBe(content);
    }
  });
  it('detects mixed line endings and converts deliberately', () => {
    const opened = openText('a\r\nb\nc');
    expect(opened.mixed).toBe(true);
    expect(saveText(opened.text, false, 'crlf')).toBe('a\r\nb\r\nc');
    expect(saveText(opened.text, false, 'lf')).toBe('a\nb\nc');
  });
  it('counts UTF-8 bytes rather than characters for the edit limit', () => {
    expect(textBytes('中文')).toBe(6);
    expect(textBytes('\uFEFF')).toBe(3);
    expect(textBytes('中'.repeat(Math.ceil(MAX_TEXT_BYTES / 3)))).toBeGreaterThan(MAX_TEXT_BYTES);
  });
});
