import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// End-to-end guard for the leak in issue #5: the channel must not outlive the
// Claude Code process that spawned it. These tests run the real `src/main.ts`,
// which spawns a real detached hub daemon, so each gets its own data dir.

const MAIN = path.resolve(import.meta.dir, "main.ts");
const STARTUP_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 15_000;

const dataDirs: string[] = [];
const spawnedPids: number[] = [];

function makeDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-orphan-test-"));
    dataDirs.push(dir);
    return dir;
}

function logText(dataDir: string): string {
    const logs = path.join(dataDir, "logs");
    if (!fs.existsSync(logs)) return "";
    return fs
        .readdirSync(logs)
        .map((f) => fs.readFileSync(path.join(logs, f), "utf8"))
        .join("");
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
}

const waitForStartup = (dataDir: string): Promise<boolean> =>
    waitFor(() => logText(dataDir).includes("channel_start"), STARTUP_TIMEOUT_MS);

function kill(pid: number): void {
    try {
        process.kill(pid, "SIGKILL");
    } catch {}
}

/** Daemon pids from `daemon_start {"socketPath":"…","pid":N}` log lines. */
function hubDaemonPids(dataDir: string): number[] {
    return [...logText(dataDir).matchAll(/daemon_start[^\n]*?pid\\":(\d+)/g)].map((m) =>
        Number(m[1]),
    );
}

// Leave nothing running: a regression here means the channel does NOT exit.
afterEach(() => {
    while (spawnedPids.length) kill(spawnedPids.pop()!);
    while (dataDirs.length) {
        const dir = dataDirs.pop()!;
        for (const pid of hubDaemonPids(dir)) kill(pid);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe("channel exits when its parent goes away", () => {
    test("exits on stdin EOF", async () => {
        const dataDir = makeDataDir();
        const child = spawn("bun", ["run", MAIN], {
            env: { ...process.env, NODE_ENV: "", CLAUDE_PLUGIN_DATA: dataDir },
            stdio: ["pipe", "ignore", "ignore"],
        });
        if (child.pid) spawnedPids.push(child.pid);
        let exited = false;
        child.on("exit", () => {
            exited = true;
        });

        expect(await waitForStartup(dataDir)).toBe(true);
        child.stdin.end();

        expect(await waitFor(() => exited, EXIT_TIMEOUT_MS)).toBe(true);
        expect(logText(dataDir)).toContain("parent_gone");
    }, 40_000);

    test("exits when the spawning process is killed", async () => {
        const dataDir = makeDataDir();
        const harness = path.join(dataDir, "harness.ts");
        fs.writeFileSync(
            harness,
            [
                `import { spawn } from "node:child_process";`,
                `import * as fs from "node:fs";`,
                `const c = spawn("bun", ["run", ${JSON.stringify(MAIN)}], {`,
                `    env: { ...process.env, NODE_ENV: "", CLAUDE_PLUGIN_DATA: ${JSON.stringify(dataDir)} },`,
                `    stdio: ["pipe", "ignore", "ignore"],`,
                `});`,
                `fs.writeFileSync(${JSON.stringify(path.join(dataDir, "child.pid"))}, String(c.pid));`,
                `setInterval(() => {}, 1000);`,
                ``,
            ].join("\n"),
        );

        const parent = spawn("bun", ["run", harness], { stdio: "ignore" });
        if (parent.pid) spawnedPids.push(parent.pid);
        expect(await waitForStartup(dataDir)).toBe(true);

        const childPid = Number(fs.readFileSync(path.join(dataDir, "child.pid"), "utf8"));
        spawnedPids.push(childPid);
        expect(isAlive(childPid)).toBe(true);

        // SIGKILL, so the parent gets no chance to clean up its children.
        parent.kill("SIGKILL");

        expect(await waitFor(() => !isAlive(childPid), EXIT_TIMEOUT_MS)).toBe(true);
    }, 40_000);
});
