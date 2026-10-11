export type LogLevel =
  | 'log'
  | 'info'
  | 'debug'
  | 'warn'
  | 'error'
  | 'pageerror'
  | 'network'
  | 'vite';

export interface LogEntry {
  seq: number;
  time: number;
  level: LogLevel;
  text: string;
  location?: string;
  /** Nº de carga de página en la que se produjo (se incrementa en cada navegación). */
  load: number;
}

const MAX_ENTRIES = 3000;
const MAX_TEXT = 600;

/** Buffer circular de logs del navegador y del dev server. */
export class LogBuffer {
  private entries: LogEntry[] = [];
  private seq = 0;
  public load = 0;

  public push(level: LogLevel, text: string, location?: string): void {
    const entry: LogEntry = { seq: ++this.seq, time: Date.now(), level, text, load: this.load };
    if (location) entry.location = location;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES)
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  public newLoad(): void {
    this.load++;
  }

  public get lastSeq(): number {
    return this.seq;
  }

  public query(opts: {
    levels?: LogLevel[];
    sinceSeq?: number;
    currentLoadOnly?: boolean;
    contains?: string;
    limit?: number;
  }): LogEntry[] {
    const needle = opts.contains?.toLowerCase();
    const filtered = this.entries.filter(
      (e) =>
        (!opts.levels || opts.levels.includes(e.level)) &&
        (opts.sinceSeq === undefined || e.seq > opts.sinceSeq) &&
        (!opts.currentLoadOnly || e.load === this.load) &&
        (!needle || e.text.toLowerCase().includes(needle)),
    );
    const limit = opts.limit ?? 200;
    return filtered.slice(-limit);
  }

  public errorsSince(seq: number): LogEntry[] {
    return this.entries.filter(
      (e) =>
        e.seq > seq && (e.level === 'error' || e.level === 'pageerror' || e.level === 'network'),
    );
  }
}

export function formatLogs(entries: LogEntry[]): string {
  if (!entries.length) return '(no log entries)';
  return entries
    .map((e) => {
      const t = new Date(e.time).toISOString().slice(11, 23);
      const loc = e.location ? `  @ ${e.location}` : '';
      const body =
        e.text.length > MAX_TEXT
          ? `${e.text.slice(0, MAX_TEXT)}… (+${e.text.length - MAX_TEXT} chars)`
          : e.text;
      return `#${e.seq} ${t} [${e.level}] ${body}${loc}`;
    })
    .join('\n');
}
