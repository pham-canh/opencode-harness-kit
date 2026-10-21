/** Rotate above this, so a long-running project cannot fill its disk. */
export declare const MAX_BYTES: number;
export declare function logPath(dir: string): string;
/** The telemetry file and its rotated predecessors, oldest first. */
export declare function logFiles(dir: string): string[];
/**
 * Rotate by size so a long-running project cannot fill its disk.
 *
 * THREE generations are kept: the current file, `.1` and `.2`. The reader
 * enumerates all three, so the writer has to produce all three.
 *
 * The rotation used to rename the current file straight to `.1`, and a
 * rename REPLACES the destination on POSIX - so the previous generation was
 * destroyed on every rotation and `.2` never came into existence. Two
 * rotations after the fact, the oldest history was gone and the third
 * generation the reader looks for was missing: the history a project lost
 * was lost on a schedule nobody was watching.
 *
 * So the oldest is shifted out of the way first, and the oldest of the
 * three is dropped - the disk use stays bounded at three files, and the
 * generation that is dropped is the one that was already two rotations
 * old.
 *
 * @param file the file to rotate
 * @param maxBytes the size above which it is rotated
 */
export declare function rotate(file: string, maxBytes?: number): void;
/**
 * Append one record.
 *
 * Nothing here is allowed to throw. Telemetry must never be load-bearing: a
 * full disk or a read-only project must not break a turn.
 */
export declare function write(dir: string, record: Record<string, unknown>): void;
