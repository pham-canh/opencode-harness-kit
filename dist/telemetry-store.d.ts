/** Rotate above this, so a long-running project cannot fill its disk. */
export declare const MAX_BYTES: number;
export declare function logPath(dir: string): string;
/** The telemetry file and its rotated predecessors, oldest first. */
export declare function logFiles(dir: string): string[];
/**
 * Append one record.
 *
 * Nothing here is allowed to throw. Telemetry must never be load-bearing: a
 * full disk or a read-only project must not break a turn.
 */
export declare function write(dir: string, record: Record<string, unknown>): void;
