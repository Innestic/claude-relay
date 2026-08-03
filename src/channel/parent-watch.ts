import { makeLogger } from "../logger";

const log = makeLogger("channel");

type StdinLike = { on: (event: string, cb: () => void) => unknown };

export type ParentWatchOptions = {
    /** Called once when the parent is gone. */
    onOrphaned: (reason: string) => void;
    stdin?: StdinLike;
    getPpid?: () => number;
    isAlive?: (pid: number) => boolean;
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
};

export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH: no such process. EPERM: it exists but is not ours, so alive.
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

/**
 * Exit when the parent Claude Code process goes away.
 *
 * The MCP stdio transport only subscribes to stdin `data` and `error`, never to
 * `end`/`close`. Without this watch the channel survives its parent forever,
 * holding a hub connection and keeping the hub daemon from idle-exiting.
 *
 * Primary signal is stdin EOF (immediate). The parent-pid liveness poll is a
 * backstop for the case where something else holds stdin open.
 */
export function watchParent(opts: ParentWatchOptions): void {
    const stdin = opts.stdin ?? process.stdin;
    const getPpid = opts.getPpid ?? (() => process.ppid);
    const isAlive = opts.isAlive ?? isPidAlive;
    const intervalMs = opts.intervalMs ?? 5000;
    const setIntervalFn = opts.setIntervalFn ?? setInterval;

    let fired = false;
    const fire = (reason: string): void => {
        if (fired) return;
        fired = true;
        log.info("parent_gone", { reason });
        opts.onOrphaned(reason);
    };

    stdin.on("end", () => fire("stdin_eof"));
    stdin.on("close", () => fire("stdin_closed"));

    const parentPid = getPpid();
    const timer = setIntervalFn(() => {
        if (getPpid() === 1 || !isAlive(parentPid)) fire("parent_pid_gone");
    }, intervalMs);
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
}
