import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import type { Settings, TerminalEvent } from './types';

export interface TerminalController {
  write(event: TerminalEvent): void;
  paste(data: string): void;
  search(query: string): boolean;
  size(): { cols: number; rows: number };
  focus(): void;
  log(): string;
}
interface Props {
  id: string; active: boolean; settings: Settings;
  onReady(id: string, terminal: TerminalController): void;
  onDispose(id: string): void;
  onInput(id: string, data: string): void;
  onResize(id: string, cols: number, rows: number): void;
  onPaste(id: string, data: string): void;
}
function terminalTheme(theme: Settings['theme']) { return theme === 'dark' ? { background: '#111419', foreground: '#dce1ea', cursor: '#66d9b0', selectionBackground: '#304f48', black: '#20252e', red: '#ef8282', green: '#78dcb6', yellow: '#e9b56f', blue: '#91b4f5', magenta: '#bd9bf0', cyan: '#7bd6df', white: '#dce1ea' } : { background: '#ffffff', foreground: '#26303d', cursor: '#12765c', selectionBackground: '#d2e6df' }; }

export function TerminalPane({ id, active, settings, onReady, onDispose, onInput, onResize, onPaste }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null);
  const handlers = useRef({ onReady, onDispose, onInput, onResize, onPaste }); handlers.current = { onReady, onDispose, onInput, onResize, onPaste };
  useEffect(() => {
    const el = container.current!;
    const terminal = new Terminal({ theme: terminalTheme(settings.theme), cursorBlink: true, convertEol: false, allowProposedApi: false, scrollback: settings.scrollback, fontFamily: settings.fontFamily, fontSize: settings.fontSize });
    const fitter = new FitAddon(), searcher = new SearchAddon();
    terminal.loadAddon(fitter); terminal.loadAddon(searcher); terminal.open(el); term.current = terminal; fit.current = fitter;
    const frame = requestAnimationFrame(() => { if (el.clientWidth && el.clientHeight) fitter.fit(); });
    const resize = new ResizeObserver(() => { if (el.clientWidth && el.clientHeight) { fitter.fit(); handlers.current.onResize(id, terminal.cols, terminal.rows); } }); resize.observe(el);
    const input = terminal.onData(data => handlers.current.onInput(id, data));
    const paste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text && /[\r\n]/.test(text)) { e.preventDefault(); e.stopImmediatePropagation(); handlers.current.onPaste(id, text); }
    };
    el.addEventListener('paste', paste, true);
    handlers.current.onReady(id, {
      write(event) {
        if (event.type === 'data' && event.data) {
          const binary = atob(event.data); terminal.write(Uint8Array.from(binary, c => c.charCodeAt(0)));
        } else if (event.type === 'error') terminal.writeln('\r\n\x1b[31m' + (event.data || '连接失败') + '\x1b[0m');
        else if (event.type === 'closed') terminal.writeln('\r\n\x1b[90m连接已结束\x1b[0m');
      },
      paste(data) { terminal.paste(data); }, search(query) { return searcher.findNext(query); },
      size() { return { cols: terminal.cols, rows: terminal.rows }; }, focus() { terminal.focus(); },
      log() { const buffer = terminal.buffer.active; const lines: string[] = []; for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || ''); return lines.join('\n'); },
    });
    return () => { cancelAnimationFrame(frame); resize.disconnect(); input.dispose(); el.removeEventListener('paste', paste, true); handlers.current.onDispose(id); terminal.dispose(); term.current = null; fit.current = null; };
  }, [id]);
  useEffect(() => {
    const terminal = term.current; if (!terminal) return;
    terminal.options.fontSize = settings.fontSize; terminal.options.fontFamily = settings.fontFamily; terminal.options.scrollback = settings.scrollback;
    terminal.options.theme = terminalTheme(settings.theme);
    if (container.current?.clientWidth) fit.current?.fit();
  }, [settings]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (container.current?.clientWidth) {
        fit.current?.fit();
        // Preserve keyboard/native dropdown focus while choosing a panel tab.
        if (!container.current.parentElement?.querySelector('.pane-label select:focus')) term.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div className="terminal-container" ref={container} aria-label={`终端 ${id}`} />;
}
