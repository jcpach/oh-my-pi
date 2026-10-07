import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { FileEntry, SearchRoot } from "@oh-my-pi/pi-coding-agent/tools/jfind/tree";
import * as piUtils from "@oh-my-pi/pi-utils";
import { colgrepCandidates } from "@oh-my-pi/pi-coding-agent/tools/jfind/colgrep";

interface ExecCall {
	cmd: string[];
	opts: piUtils.ptree.ExecOptions | undefined;
}

/**
 * Replace the process boundary (`ptree.exec`) with an in-process peer so argv,
 * cwd, timeout, signal, and every exit shape are asserted without spawning. The
 * shared namespace is spied on (not `mock.module`, which leaks across files).
 */
function installExec(handler: (call: ExecCall) => piUtils.ptree.ExecResult): ExecCall[] {
	const calls: ExecCall[] = [];
	vi.spyOn(piUtils.ptree, "exec").mockImplementation((async (cmd, opts) => {
		const call = { cmd, opts };
		calls.push(call);
		return handler(call);
	}) as typeof piUtils.ptree.exec);
	return calls;
}

function ok(stdout: string): piUtils.ptree.ExecResult {
	return { stdout, stderr: "", exitCode: 0, ok: true };
}

function killed(): piUtils.ptree.ExecResult {
	return {
		stdout: "",
		stderr: "",
		exitCode: null,
		ok: false,
		exitError: new piUtils.ptree.TimeoutError(5_000, ""),
	};
}

function row(file: string, line: number, endLine: number, score: unknown): unknown {
	return { unit: { file, line, end_line: endLine }, score };
}

const ROOT: SearchRoot = { path: "/repo", type: "directory" };

function entries(...paths: string[]): FileEntry[] {
	return paths.map(p => ({ path: p, rel: path.relative(ROOT.path, p), size: 10 }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("jfind colgrep", () => {
	it("maps eligible rows onto entry nodes, deduping and sorting by score", async () => {
		const calls = installExec(() =>
			ok(
				JSON.stringify([
					row("/repo/a.ts", 10, 12, 0.5),
					row("/repo/b.ts", 5, 5, 0.9),
					row("/repo/a.ts", 10, 12, 0.7),
					row("/repo/c.ts", 3, 1, 0.99),
					row("/repo/secret.env", 1, 2, 0.99),
					row("/repo/b.ts", 5, 5, Number.NaN),
					row("/repo/malformed.ts", 1.5, 2, 0.5),
				]),
			),
		);
		const result = await colgrepCandidates({
			root: ROOT,
			entries: entries("/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo/malformed.ts"),
			query: "retry budget",
			limit: 8,
		});
		expect(result).toEqual([
			{ node: 1, start: 5, end: 5, score: 0.9 },
			{ node: 0, start: 10, end: 12, score: 0.7 },
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.cmd).toEqual([
			"colgrep",
			"search",
			"--json",
			"--no-update",
			"-k",
			"8",
			"--",
			"retry budget",
			"/repo",
		]);
		expect(calls[0]!.opts?.cwd).toBe("/repo");
	});

	it("caps results at the requested limit", async () => {
		installExec(() =>
			ok(JSON.stringify([row("/repo/a.ts", 1, 1, 0.9), row("/repo/b.ts", 2, 2, 0.8), row("/repo/c.ts", 3, 3, 0.7)])),
		);
		const result = await colgrepCandidates({
			root: ROOT,
			entries: entries("/repo/a.ts", "/repo/b.ts", "/repo/c.ts"),
			query: "q",
			limit: 2,
		});
		expect(result?.map(candidate => candidate.node)).toEqual([0, 1]);
	});

	it("searches from a file root's directory with an explicit file scope", async () => {
		const calls = installExec(() => ok("[]"));
		const root: SearchRoot = { path: "/repo/src/a.ts", type: "file", size: 10 };
		await expect(
			colgrepCandidates({ root, entries: entries("/repo/src/a.ts"), query: "q", limit: 5 }),
		).resolves.toBeUndefined();
		expect(calls[0]!.cmd).toEqual([
			"colgrep",
			"search",
			"--json",
			"--no-update",
			"-k",
			"5",
			"--",
			"q",
			"/repo/src/a.ts",
		]);
		expect(calls[0]!.opts?.cwd).toBe("/repo/src");
	});

	it("rejects an already-aborted signal before spawning", async () => {
		const calls = installExec(() => ok("[]"));
		const controller = new AbortController();
		controller.abort();
		await expect(
			colgrepCandidates({
				root: ROOT,
				entries: entries("/repo/a.ts"),
				query: "q",
				limit: 5,
				signal: controller.signal,
			}),
		).rejects.toThrow("Operation aborted");
		expect(calls).toHaveLength(0);
	});

	it("returns undefined for internal URL roots without spawning", async () => {
		const calls = installExec(() => ok("[]"));
		const result = await colgrepCandidates({
			root: { path: "omp://", type: "directory" },
			entries: [],
			query: "q",
			limit: 5,
		});
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("falls back with a warning on malformed JSON, nonzero exit, timeout, and missing binary", async () => {
		const warn = vi.spyOn(piUtils.logger, "warn").mockImplementation(() => {});
		const cases: piUtils.ptree.ExecResult[] = [
			ok("not json"),
			ok("{}"),
			{
				stdout: "",
				stderr: "boom",
				exitCode: 2,
				ok: false,
				exitError: new piUtils.NonZeroExitError(2, "boom"),
			},
			killed(),
			{
				stdout: "",
				stderr: "",
				exitCode: null,
				ok: false,
				exitError: new piUtils.AbortError(new Error("stdout byte limit exceeded"), ""),
			},
			{ stdout: "", stderr: "colgrep: command not found", exitCode: null, ok: false },
		];
		installExec(() => cases.shift()!);
		for (let i = 0, count = cases.length; i < count; i++) {
			await expect(colgrepCandidates({ root: ROOT, entries: [], query: "q", limit: 5 })).resolves.toBeUndefined();
		}
		expect(warn).toHaveBeenCalledTimes(6);
	});

	it("falls back when spawning a missing binary throws", async () => {
		installExec(() => {
			throw new Error("ENOENT: colgrep");
		});
		await expect(
			colgrepCandidates({ root: ROOT, entries: entries("/repo/a.ts"), query: "q", limit: 5 }),
		).resolves.toBeUndefined();
	});

	it("returns undefined when the only rows are ineligible or empty", async () => {
		const results = [ok(JSON.stringify([row("/repo/secret.env", 1, 2, 0.9)])), ok("[]")];
		installExec(() => results.shift()!);
		for (let i = 0, count = results.length; i < count; i++) {
			await expect(
				colgrepCandidates({ root: ROOT, entries: entries("/repo/a.ts"), query: "q", limit: 5 }),
			).resolves.toBeUndefined();
		}
	});

	it("propagates a caller abort instead of falling back", async () => {
		const controller = new AbortController();
		installExec(() => {
			controller.abort();
			return ok(JSON.stringify([row("/repo/a.ts", 1, 1, 0.9)]));
		});
		await expect(
			colgrepCandidates({
				root: ROOT,
				entries: entries("/repo/a.ts"),
				query: "q",
				limit: 5,
				signal: controller.signal,
			}),
		).rejects.toThrow("Operation aborted");
	});
});
