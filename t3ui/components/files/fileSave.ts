// Saving an edited file (files/fileSaveCoordinator.ts and fileSaveSessions.ts in the web app). Edits are written through
// `projects.writeFile` after a 500 ms pause (the web's debounce), one ordered write queue per file. A session that cannot write
// (no `filesystem:write`) keeps the draft and writes it when write access returns; a surface that goes away flushes at once.
// Pure of the engine apart from `fileSaveSessions`, the shared instance, so it is tested with fake dependencies.

export interface FileSaveCoordinatorOptions {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  /** Resolves true when the server took the write. */
  readonly persist: (contents: string) => Promise<boolean>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
  /** Called when a write pass ends with nothing further scheduled. */
  readonly onSettled?: () => void;
}

export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private flushing = false;

  constructor(private readonly options: FileSaveCoordinatorOptions) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  /** The newest contents not yet written, which is the last write this coordinator will make. */
  get unconfirmedContents(): string | null {
    return this.latestRevision === this.confirmedRevision ? null : this.latestContents;
  }

  /** Writes the newest draft now instead of after the debounce, then any draft queued behind it. */
  flush(): void {
    this.clearTimer();
    this.flushing = true;
    void this.persistLatest();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving) return;
    if (this.latestRevision === this.confirmedRevision || this.options.canPersist?.() === false) {
      this.settle();
      return;
    }
    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const succeeded = await this.options.persist(contents);
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }
    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) this.options.onPendingChange(false);
      this.settle();
      return;
    }
    const remaining = Math.max(0, this.options.debounceMs - (Date.now() - this.lastChangeAt));
    if (this.disposed || this.flushing) void this.persistLatest();
    else this.schedule(remaining);
  }

  private settle(): void {
    this.flushing = false;
    this.options.onSettled?.();
  }
}

export interface FileSaveTarget {
  readonly cwd: string;
  readonly relativePath: string;
}

export type FilePendingListener = (relativePath: string, pending: boolean) => void;

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly persist: (target: FileSaveTarget, contents: string) => Promise<boolean>;
  readonly confirm: (target: FileSaveTarget, contents: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
}

interface FileSaveSession {
  readonly coordinator: FileSaveCoordinator;
  /** Lease count per listener; surfaces may share one listener. */
  readonly listeners: Map<FilePendingListener, number>;
  readonly unsubscribeWritable: () => void;
  leases: number;
  /** The last release flushed, and the session stays open until that settles. */
  flushingOnRelease: boolean;
}

function fileSaveKey({ cwd, relativePath }: FileSaveTarget): string {
  return `${cwd}\u0000${relativePath}`;
}

/**
 * One save session, so one ordered write queue, per file. A released session stays open until its flush settles, so a surface
 * rejoining meanwhile reuses it instead of racing the flush. A session that cannot write closes at once, and the next one, or
 * regained write access, resumes the unsaved draft.
 */
export function createFileSaveSessions(deps: FileSaveSessionDeps) {
  const sessions = new Map<string, FileSaveSession>();

  const recover = (target: FileSaveTarget, coordinator: FileSaveCoordinator) => {
    if (!deps.canPersist(target)) return;
    const unsaved = deps.readUnsaved(target);
    if (unsaved !== null) coordinator.change(unsaved);
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Map<FilePendingListener, number>();
    const coordinator: FileSaveCoordinator = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => deps.canPersist(target),
      // The last surface's listeners outlive it: a flush that settles after the session is released still has to clear the marker.
      onPendingChange: (pending) => { for (const listener of listeners.keys()) listener(target.relativePath, pending); },
      persist: (contents) => deps.persist(target, contents),
      onConfirmed: (contents) => deps.confirm(target, contents),
      onSettled: () => {
        if (!session.flushingOnRelease) return;
        session.flushingOnRelease = false;
        if (session.leases === 0) {
          if (sessions.get(key) === session) sessions.delete(key);
          session.unsubscribeWritable();
        } else if (coordinator.unconfirmedContents !== null) {
          // A surface rejoined while the release flush failed; retry it once.
          recover(target, coordinator);
        }
      },
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () => recover(target, coordinator));
    const session: FileSaveSession = { coordinator, listeners, unsubscribeWritable, leases: 0, flushingOnRelease: false };
    return session;
  };

  const acquire = (target: FileSaveTarget, onPendingChange: FilePendingListener): (() => void) => {
    const key = fileSaveKey(target);
    const existing = sessions.get(key);
    const session = existing ?? create(key, target);
    sessions.set(key, session);
    session.leases += 1;
    session.listeners.set(onPendingChange, (session.listeners.get(onPendingChange) ?? 0) + 1);
    if (!existing) recover(target, session.coordinator);
    else if (session.coordinator.unconfirmedContents !== null) onPendingChange(target.relativePath, true);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.leases -= 1;
      if (session.leases > 0) {
        const count = (session.listeners.get(onPendingChange) ?? 1) - 1;
        if (count > 0) session.listeners.set(onPendingChange, count);
        else session.listeners.delete(onPendingChange);
        return;
      }
      session.flushingOnRelease = true;
      session.coordinator.flush();
    };
  };

  return {
    /** Holds the file's session open until the returned release runs. */
    acquire,
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      const session = sessions.get(fileSaveKey(target));
      if (session && session.leases > 0) session.coordinator.change(contents);
    },
    /** The files whose session still holds a draft the server has not taken. */
    pendingPaths(): string[] {
      return [...sessions.entries()].filter(([, session]) => session.coordinator.unconfirmedContents !== null).map(([key]) => key.split("\u0000")[1]!);
    },
  };
}
