import { describe, expect, it } from "bun:test";
import { AbortError, exec, NonZeroExitError, spawn } from "@oh-my-pi/pi-utils/ptree";

const CHUNK = "x".repeat(64 * 1024);
const SAFETY_TIMEOUT_MS = 3_000;

/** Writes 64 KB stdout chunks forever; only an external kill ends it. */
function verboseStdout(): string[] {
	return ["bun", "-e", `for (;;) { await Bun.stdout.write(${JSON.stringify(CHUNK)}); }`];
}

/** Writes `size` ASCII bytes once and exits cleanly. */
function fixedStdout(size: number): string[] {
	return ["bun", "-e", `process.stdout.write("y".repeat(${size}))`];
}

describe("ptree maxStdoutBytes", () => {
	it("terminates a verbose child with an AbortError once stdout exceeds the cap", async () => {
		const cap = 256 * 1024;
		let error: unknown;
		try {
			await exec(verboseStdout(), { maxStdoutBytes: cap, timeout: SAFETY_TIMEOUT_MS });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AbortError);
		if (!(error instanceof AbortError)) throw new Error("Expected AbortError");
		expect(error.message).toContain(`stdout exceeded ${cap} bytes`);
	});

	it("retains exactly the cap and surfaces the abort when allowAbort is set", async () => {
		const cap = 256 * 1024;
		const result = await exec(verboseStdout(), {
			maxStdoutBytes: cap,
			allowAbort: true,
			timeout: SAFETY_TIMEOUT_MS,
		});

		expect(result.stdout.length).toBe(cap);
		expect(result.stdout).toBe("x".repeat(cap));
		expect(result.ok).toBe(false);
		expect(result.exitError).toBeInstanceOf(AbortError);
	});

	it("honors maxStdoutBytes passed directly to wait", async () => {
		const cap = 128 * 1024;
		using child = spawn(verboseStdout(), { timeout: SAFETY_TIMEOUT_MS });
		let error: unknown;
		try {
			await child.wait({ maxStdoutBytes: cap });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(AbortError);
		if (!(error instanceof AbortError)) throw new Error("Expected AbortError");
		expect(error.message).toContain(`stdout exceeded ${cap} bytes`);
	});

	it("captures the full output when it equals the cap", async () => {
		const size = 128 * 1024;
		const result = await exec(fixedStdout(size), { maxStdoutBytes: size });

		expect(result.stdout.length).toBe(size);
		expect(result.stdout).toBe("y".repeat(size));
		expect(result.ok).toBe(true);
	});

	it("captures unbounded output when no cap is set", async () => {
		const size = 512 * 1024;
		const result = await exec(fixedStdout(size));

		expect(result.stdout.length).toBe(size);
		expect(result.ok).toBe(true);
	});

	it("leaves nonzero-exit semantics intact when under the cap", async () => {
		const cmd = ["bun", "-e", `process.stdout.write("ok"); process.exitCode = 7;`];
		let error: unknown;
		try {
			await exec(cmd, { maxStdoutBytes: 64 * 1024 });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(NonZeroExitError);
		if (!(error instanceof NonZeroExitError)) throw new Error("Expected NonZeroExitError");
		expect(error.exitCode).toBe(7);
	});
});
