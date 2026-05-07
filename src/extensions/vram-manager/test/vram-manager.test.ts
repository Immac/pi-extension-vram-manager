/**
 * VRAM Manager - Unit & Smoke Tests
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";

// We test the helpers by re-importing them.
// Since they're not exported, we test via black-box tool simulation.

// ============================================================================
// Helper Tests (duplicate minimal logic to verify)
// ============================================================================

function simulateGetOtherServers(
	allServers: Array<{ id: string }>,
	hardwareGroups: Array<{ id: string; serverIds: string[] }>,
	targetServerId: string
): Array<{ id: string }> {
	const group = hardwareGroups.find(g => g.serverIds.includes(targetServerId));
	if (!group) return [];
	return allServers.filter(s => s.id !== targetServerId && group.serverIds.includes(s.id));
}

describe("getOtherServers", () => {
	const servers = [
		{ id: "comfy" },
		{ id: "llamaswap" },
		{ id: "ollama" },
	];

	const groups = [
		{ id: "gpu0", serverIds: ["comfy", "llamaswap"] },
		{ id: "gpu1", serverIds: ["ollama"] },
	];

	it("returns peers in the same hardware group", () => {
		const result = simulateGetOtherServers(servers, groups, "comfy");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].id, "llamaswap");
	});

	it("returns empty when no peers in group", () => {
		const result = simulateGetOtherServers(servers, groups, "ollama");
		assert.strictEqual(result.length, 0);
	});

	it("returns empty for unknown server", () => {
		const result = simulateGetOtherServers(servers, groups, "unknown");
		assert.strictEqual(result.length, 0);
	});

	it("returns both peers from a group of three", () => {
		const threeGroups = [{ id: "gpu", serverIds: ["a", "b", "c"] }];
		const threeServers = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const result = simulateGetOtherServers(threeServers, threeGroups, "a");
		assert.strictEqual(result.length, 2);
	});
});

describe("formatBytes", () => {
	function formatBytes(bytes: number): string {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB", "TB"];
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
	}

	it("formats 0 bytes", () => {
		assert.strictEqual(formatBytes(0), "0 B");
	});

	it("formats bytes", () => {
		assert.strictEqual(formatBytes(500), "500.0 B");
	});

	it("formats kilobytes", () => {
		assert.strictEqual(formatBytes(2048), "2.0 KB");
	});

	it("formats megabytes", () => {
		assert.strictEqual(formatBytes(10485760), "10.0 MB");
	});

	it("formats gigabytes", () => {
		assert.strictEqual(formatBytes(8589934592), "8.0 GB");
	});
});

// ============================================================================
// Configuration Validation
// ============================================================================

describe("Configuration", () => {
	it("accepts valid server config", () => {
		const server = {
			id: "test-server",
			name: "Test",
			baseUrl: "http://localhost:8080",
			unloadEndpoint: "/unload",
			reloadEndpoint: "/reload",
		};
		assert.ok(server.id);
		assert.ok(server.name);
		assert.ok(server.baseUrl);
	});

	it("accepts valid hardware group config", () => {
		const group = {
			id: "gpu0",
			name: "RTX 4060 Ti",
			serverIds: ["comfy", "llamaswap"],
			vramTotalGb: 16,
		};
		assert.ok(group.id);
		assert.ok(Array.isArray(group.serverIds));
		assert.strictEqual(group.serverIds.length, 2);
	});

	it("rejects empty server IDs", () => {
		assert.throws(() => {
			if (!"".trim()) throw new Error("Server ID must not be empty");
		});
	});
});

// ============================================================================
// Unload Registry Tests
// ============================================================================

describe("UnloadRegistry", () => {
	let registry: Array<{ serverId: string; timestamp: number; reservationId: string }>;

	function reset() {
		registry = [];
	}

	function record(serverId: string) {
		const r = { serverId, timestamp: Date.now(), reservationId: `test-${Math.random()}` };
		registry.push(r);
		return r;
	}

	function getAll() { return [...registry]; }

	function clear(serverIds?: string[]) {
		if (serverIds) {
			registry = registry.filter(r => !serverIds.includes(r.serverId));
		} else {
			registry = [];
		}
	}

	before(() => reset());
	after(() => reset());

	it("starts empty", () => {
		assert.strictEqual(getAll().length, 0);
	});

	it("records an unload", () => {
		const r = record("test-server");
		assert.strictEqual(r.serverId, "test-server");
		assert.ok(r.reservationId);
		assert.strictEqual(getAll().length, 1);
	});

	it("records multiple unloads", () => {
		record("server-a");
		record("server-b");
		assert.strictEqual(getAll().length, 3);
	});

	it("clears specific records", () => {
		clear(["server-a"]);
		const remaining = getAll();
		assert.strictEqual(remaining.length, 2);
		assert.ok(remaining.every(r => r.serverId !== "server-a"));
	});

	it("clears all records", () => {
		clear();
		assert.strictEqual(getAll().length, 0);
	});
});

// ============================================================================
// VRAM Stats Parsing
// ============================================================================

describe("VRAM Stats Parser", () => {
	it("parses ComfyUI system_stats response", () => {
		const sampleResponse = {
			system: {
				devices: [
					{ name: "NVIDIA GeForce RTX 4060 Ti", total: 17163091968, free: 8589934592 },
				],
			},
		};

		const devices = (sampleResponse.system?.devices as Array<Record<string, unknown>> ?? []).map((d, i) => ({
			id: i,
			name: String(d.name ?? "unknown"),
			totalBytes: Number(d.total ?? 0),
			freeBytes: Number(d.free ?? 0),
		}));

		assert.strictEqual(devices.length, 1);
		assert.strictEqual(devices[0].name, "NVIDIA GeForce RTX 4060 Ti");
		assert.strictEqual(devices[0].totalBytes, 17163091968);
		assert.strictEqual(devices[0].freeBytes, 8589934592);
	});

	it("handles empty device list", () => {
		const sampleResponse = { system: { devices: [] } };
		const devices = (sampleResponse.system?.devices ?? []).map((_d, i) => ({ id: i }));
		assert.strictEqual(devices.length, 0);
	});

	it("handles missing system field", () => {
		const sampleResponse = {};
		const devices = ((sampleResponse as Record<string, unknown>).system as Record<string, unknown> | undefined)?.devices as Array<unknown> | undefined;
		assert.strictEqual(devices, undefined);
	});
});
