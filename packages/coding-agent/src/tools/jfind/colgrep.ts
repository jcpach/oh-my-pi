/**
 * Optional `colgrep` backend for `find`: replaces the native lexical prior with
 * `colgrep search` results mapped onto the eligible file set. Every failure
 * mode (no binary, no index, timeout, malformed output, no usable rows) returns
 * `undefined` so the caller falls back to the lexical scan; a caller abort
 * propagates as {@link ToolAbortError} instead.
 */
import * as path from "node:path";
import { isRecord, logger, ptree } from "@oh-my-pi/pi-utils";
import { isFilesystemSourcePath } from "../path-utils";
import { throwIfAborted, ToolAbortError } from "../tool-errors";
import type { FileEntry, SearchRoot } from "./tree";

/** Wall-clock budget for one `colgrep` call. */
const COLGREP_TIMEOUT_MS = 10_000;
const COLGREP_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** One `colgrep` hit mapped onto the eligible file set: `node` indexes `entries`. */
export interface ColgrepCandidate {
	node: number;
	/** 1-based first line of the unit, inclusive. */
	start: number;
	/** 1-based last line of the unit, inclusive. */
	end: number;
	score: number;
}

export interface ColgrepOptions {
	root: SearchRoot;
	entries: readonly FileEntry[];
	query: string;
	limit: number;
	signal?: AbortSignal;
}

/** Parse the `colgrep search --json` payload: a JSON array of result rows. */
function parseRows(stdout: string): unknown[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error("colgrep output is not a JSON array");
	return parsed;
}

/** A validated 1-based inclusive line range, or `undefined` when malformed. */
function lineRange(start: unknown, end: unknown): { start: number; end: number } | undefined {
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
	if (start < 1 || end < start) return undefined;
	return { start, end };
}

/** Log the fallback reason and return `undefined`; a set abort throws instead. */
function fallback(reason: string, signal?: AbortSignal): undefined {
	throwIfAborted(signal);
	logger.warn("colgrep search failed", { reason });
	return undefined;
}

/**
 * Run `colgrep search` for `query` and map its hits onto {@link ColgrepOptions.entries}.
 * `undefined` means "use the lexical backend"; unusable rows are discarded and
 * surviving rows are deduplicated by `(node, start, end)` and sorted by score.
 */
export async function colgrepCandidates(options: ColgrepOptions): Promise<ColgrepCandidate[] | undefined> {
	const { root, entries, query, limit, signal } = options;
	throwIfAborted(signal);
	// Internal URL roots (`omp://`, `local://`, …) have no host cwd to spawn
	// colgrep in; the lexical scan already reads them through the URL filesystem.
	if (!isFilesystemSourcePath(root.path)) return undefined;
	const cwd = root.type === "directory" ? root.path : path.dirname(root.path);
	const byPath = new Map<string, number>();
	for (let node = 0; node < entries.length; node++) byPath.set(path.resolve(entries[node]!.path), node);
	try {
		const result = await ptree.exec(
			["colgrep", "search", "--json", "--no-update", "-k", String(limit), "--", query, root.path],
			{
				cwd,
				timeout: COLGREP_TIMEOUT_MS,
				maxStdoutBytes: COLGREP_MAX_STDOUT_BYTES,
				signal,
				stderr: "buffer",
				allowNonZero: true,
				allowAbort: true,
			},
		);
		throwIfAborted(signal);
		if (result.exitError != null) return fallback(result.exitError.message, signal);
		if (result.exitCode !== 0) return fallback(`exit code ${result.exitCode}`, signal);

		const best = new Map<string, ColgrepCandidate>();
		for (const row of parseRows(result.stdout)) {
			if (!isRecord(row)) continue;
			const unit = row.unit;
			if (!isRecord(unit)) continue;
			const file = unit.file;
			const range = lineRange(unit.line, unit.end_line);
			const score = row.score;
			if (typeof file !== "string" || file.length === 0 || range == null) continue;
			if (typeof score !== "number" || !Number.isFinite(score)) continue;
			const node = byPath.get(path.resolve(cwd, file));
			if (node === undefined) continue;
			const key = `${node}:${range.start}:${range.end}`;
			const existing = best.get(key);
			if (existing === undefined || score > existing.score) {
				best.set(key, { node, start: range.start, end: range.end, score });
			}
		}
		const candidates = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
		if (candidates.length === 0) return fallback("no usable results", signal);
		return candidates;
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		throwIfAborted(signal);
		return fallback(error instanceof Error ? error.message : String(error), signal);
	}
}
