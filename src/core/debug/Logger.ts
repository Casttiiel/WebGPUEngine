export type LogTag = 'ENGINE' | 'RENDER' | 'PHYSICS' | 'MODULES' | 'INPUT';

const BASE = 'font-weight:bold;padding:1px 6px;border-radius:3px;font-family:monospace;background:#313244;color:';

const STYLES: Record<LogTag, string> = {
  ENGINE:  BASE + '#cba6f7',
  RENDER:  BASE + '#89b4fa',
  PHYSICS: BASE + '#fab387',
  MODULES: BASE + '#a6e3a1',
  INPUT:   BASE + '#89dceb',
};

export class Logger {
  static info(tag: LogTag, message: string): void {
    console.log(`%c ${tag} %c ${message}`, STYLES[tag], '');
  }

  static warn(tag: LogTag, message: string): void {
    console.warn(`%c ${tag} %c ${message}`, STYLES[tag], '');
  }

  static error(tag: LogTag, message: string, error?: unknown): void {
    if (error !== undefined) {
      console.error(`%c ${tag} %c ${message}`, STYLES[tag], '', error);
    } else {
      console.error(`%c ${tag} %c ${message}`, STYLES[tag], '');
    }
  }
}
