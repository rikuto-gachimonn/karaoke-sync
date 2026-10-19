import { settings } from '../config/settings';

export interface LogEntry {
  sequence: number;
  timeMs: number;
  generation: number;
  event: string;
  detail: string;
}

export class DiagnosticLog {
  private entries: { entry: LogEntry; bytes: number }[] = [];
  private bytes = 0;
  private sequence = 0;
  private listeners = new Set<() => void>();
  dropped = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.sequence;

  constructor(
    private now: () => number = () => performance.now(),
    private maxEntries: number = settings.logMaxEntries,
    private maxBytes: number = settings.logMaxBytes,
  ) {}

  time = () => this.now();

  add(generation: number, event: string, detail = ''): LogEntry {
    const entry = { sequence: ++this.sequence, timeMs: this.now(), generation, event, detail };
    const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
    this.entries.push({ entry, bytes });
    this.bytes += bytes;
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed) { this.bytes -= removed.bytes; this.dropped++; }
    }
    this.listeners.forEach(listener => listener());
    return entry;
  }

  snapshot(): readonly LogEntry[] { return this.entries.map(({ entry }) => ({ ...entry })); }
}
