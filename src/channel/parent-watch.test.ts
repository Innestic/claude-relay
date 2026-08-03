import { describe, expect, test } from "bun:test";
import { isPidAlive, watchParent } from "./parent-watch";

type Handlers = Record<string, Array<() => void>>;

function fakeStdin() {
    const handlers: Handlers = {};
    return {
        handlers,
        on(event: string, cb: () => void) {
            (handlers[event] ??= []).push(cb);
            return this;
        },
        emit(event: string) {
            for (const cb of handlers[event] ?? []) cb();
        },
    };
}

function setup(opts: { ppid?: () => number; isAlive?: (pid: number) => boolean } = {}) {
    const reasons: string[] = [];
    const stdin = fakeStdin();
    let intervalCb: (() => void) | null = null;
    let unrefCalls = 0;

    const setIntervalFn = ((cb: () => void) => {
        intervalCb = cb;
        return {
            unref() {
                unrefCalls += 1;
            },
        };
    }) as unknown as typeof setInterval;

    watchParent({
        onOrphaned: (reason) => reasons.push(reason),
        stdin,
        getPpid: opts.ppid ?? (() => 42),
        isAlive: opts.isAlive ?? (() => true),
        setIntervalFn,
    });

    return {
        reasons,
        stdin,
        tick: () => intervalCb?.(),
        get unrefCalls() {
            return unrefCalls;
        },
    };
}

describe("watchParent", () => {
    test("fires on stdin end", () => {
        const h = setup();
        h.stdin.emit("end");
        expect(h.reasons).toEqual(["stdin_eof"]);
    });

    test("fires on stdin close", () => {
        const h = setup();
        h.stdin.emit("close");
        expect(h.reasons).toEqual(["stdin_closed"]);
    });

    test("fires when the process is reparented to pid 1", () => {
        let ppid = 42;
        const h = setup({ ppid: () => ppid });
        h.tick();
        expect(h.reasons).toEqual([]);
        ppid = 1;
        h.tick();
        expect(h.reasons).toEqual(["parent_pid_gone"]);
    });

    test("fires when the parent pid is no longer alive", () => {
        let alive = true;
        const h = setup({ isAlive: () => alive });
        h.tick();
        expect(h.reasons).toEqual([]);
        alive = false;
        h.tick();
        expect(h.reasons).toEqual(["parent_pid_gone"]);
    });

    test("stays quiet while the parent is alive", () => {
        const h = setup();
        h.tick();
        h.tick();
        h.tick();
        expect(h.reasons).toEqual([]);
    });

    test("polls the pid captured at startup, not the current ppid", () => {
        const seen: number[] = [];
        setup({ ppid: () => 42, isAlive: (pid) => (seen.push(pid), true) }).tick();
        expect(seen).toEqual([42]);
    });

    test("fires at most once", () => {
        const h = setup({ ppid: () => 1 });
        h.stdin.emit("end");
        h.stdin.emit("close");
        h.tick();
        expect(h.reasons).toEqual(["stdin_eof"]);
    });

    test("unrefs the poll timer so it never keeps the process alive", () => {
        expect(setup().unrefCalls).toBe(1);
    });
});

describe("isPidAlive", () => {
    test("true for this process", () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });

    test("true for pid 1, which exists but is not ours (EPERM)", () => {
        expect(isPidAlive(1)).toBe(true);
    });

    test("false for a pid that does not exist (ESRCH)", () => {
        // Above the default macOS/Linux pid_max, so it can never be assigned.
        expect(isPidAlive(0x7ffffffe)).toBe(false);
    });
});
