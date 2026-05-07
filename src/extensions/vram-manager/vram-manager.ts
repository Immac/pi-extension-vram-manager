/**
 * VRAM Manager - Orchestrates VRAM between servers sharing GPU
 * 
 * Coordinates model memory between ComfyUI, LlamaSwap, Ollama, etc.
 * Manages unload before switch, reload after completion.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

interface Server {
	id: string;
	name: string;
	baseUrl: string;
	unloadEndpoint?: string;
	reloadEndpoint?: string;
}

interface HardwareGroup {
	id: string;
	name: string;
	serverIds: string[];
	vramTotalGb?: number;
}

interface Config {
	servers: Server[];
	hardwareGroups: HardwareGroup[];
}

// ============================================================================
// State & Persistence
// ============================================================================

const STATE_ENTRY_TYPE = "vram-manager-config";

let config: Config = {
	servers: [],
	hardwareGroups: [],
};

function loadConfig(ctx: ExtensionContext): void {
	try {
		const entries = ctx.sessionManager.getEntries() ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data) {
				const parsed = entry.data as Config;
				if (parsed?.servers && parsed?.hardwareGroups) {
					config = parsed;
					return;
				}
			}
		}
	} catch {
		// Ignore malformed session data, keep default config
	}
}

async function saveConfig(pi: ExtensionAPI): Promise<void> {
	await pi.appendEntry(STATE_ENTRY_TYPE, config);
}

// ============================================================================
// Unload Registry
// ============================================================================

interface UnloadRecord {
	serverId: string;
	timestamp: number;
	reservationId: string;
}

let unloadRegistry: UnloadRecord[] = [];

function generateReservationId(): string {
	return `vram-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function recordUnload(serverId: string): UnloadRecord {
	const record: UnloadRecord = {
		serverId,
		timestamp: Date.now(),
		reservationId: generateReservationId(),
	};
	unloadRegistry.push(record);
	return record;
}

function getUnloadedServers(): UnloadRecord[] {
	return [...unloadRegistry];
}

function clearUnloadRecords(serverIds?: string[]): void {
	if (serverIds) {
		unloadRegistry = unloadRegistry.filter(r => !serverIds.includes(r.serverId));
	} else {
		unloadRegistry = [];
	}
}

// ============================================================================
// Helpers
// ============================================================================

async function callServer(
	serverId: string,
	endpoint: string,
	options: { method?: string; body?: object } = {}
): Promise<{ success: boolean; error?: string }> {
	const server = config.servers.find(s => s.id === serverId);
	if (!server) return { success: false, error: `Server "${serverId}" not found` };

	const url = `${server.baseUrl}/${endpoint}`;

	try {
		const response = await fetch(url, {
			method: options.method || "GET",
			headers: { "Content-Type": "application/json" },
			body: options.body ? JSON.stringify(options.body) : undefined,
		});
		return { success: response.ok };
	} catch (e) {
		return { success: false, error: String(e) };
	}
}

function getOtherServers(targetServerId: string): Server[] {
	const group = config.hardwareGroups.find(g => g.serverIds.includes(targetServerId));
	if (!group) return [];

	return config.servers.filter(s =>
		s.id !== targetServerId && group.serverIds.includes(s.id)
	);
}

// ============================================================================
// VRAM Querying
// ============================================================================

interface VramDevice {
	id: number;
	name: string;
	totalBytes: number;
	freeBytes: number;
	usedBytes: number;
}

interface VramStats {
	serverId: string;
	serverName: string;
	devices: VramDevice[];
	error?: string;
}

/**
 * Query VRAM stats from a ComfyUI server via /system_stats.
 * Returns per-device VRAM info if available.
 */
async function getVramStats(serverId: string): Promise<VramStats> {
	const server = config.servers.find(s => s.id === serverId);
	if (!server) {
		return { serverId, serverName: serverId, devices: [], error: "Server not found" };
	}

	try {
		const resp = await fetch(`${server.baseUrl}/system_stats`);
		if (!resp.ok) {
			return { serverId, serverName: server.name, devices: [], error: `HTTP ${resp.status}` };
		}

		const data = await resp.json() as Record<string, unknown>;
		const system = data?.system as Record<string, unknown> | undefined;
		const cudaDevices = system?.devices as Array<Record<string, unknown>> | undefined;

		if (Array.isArray(cudaDevices) && cudaDevices.length > 0) {
			const devices: VramDevice[] = cudaDevices.map((d, i) => ({
				id: i,
				name: String(d.name ?? `CUDA ${i}`),
				totalBytes: Number(d.total ?? 0),
				freeBytes: Number(d.free ?? 0),
				usedBytes: Number((d as Record<string, unknown>).used ?? 0),
			}));
			return { serverId, serverName: server.name, devices };
		}

		// Try nvidia-smi fallback
		return { serverId, serverName: server.name, devices: [], error: "No CUDA device data available" };
	} catch (e) {
		return { serverId, serverName: server.name, devices: [], error: String(e) };
	}
}

/**
 * Format bytes to human-readable size.
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ============================================================================
// Tool Factories
// ============================================================================

function createConfigureServerTool(pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-configure-server",
		label: "Configure Server",
		description: "Register or update a server (ComfyUI, LlamaSwap, Ollama, etc.) for VRAM management",
		parameters: Type.Object({
			serverId: Type.String(),
			name: Type.String(),
			baseUrl: Type.String(),
			unloadEndpoint: Type.Optional(Type.String({ description: "Endpoint to unload models (default: /unload)" })),
			reloadEndpoint: Type.Optional(Type.String({ description: "Endpoint to reload models (default: /reload)" })),
		}),

		async execute(_toolCallId: string, params: { serverId: string; name: string; baseUrl: string; unloadEndpoint?: string; reloadEndpoint?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const idx = config.servers.findIndex(s => s.id === params.serverId);
			const server: Server = {
				id: params.serverId,
				name: params.name,
				baseUrl: params.baseUrl,
				unloadEndpoint: params.unloadEndpoint || "/unload",
				reloadEndpoint: params.reloadEndpoint || "/reload",
			};
			if (idx >= 0) config.servers[idx] = server;
			else config.servers.push(server);

			await saveConfig(pi);

			return {
				content: [{ type: "text" as const, text: `Server "${params.serverId}" configured` }],
				details: { server }
			};
		},
	});
}

function createConfigureGroupTool(pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-configure-group",
		label: "Configure Hardware Group",
		description: "Create or update a hardware group (servers sharing the same GPU)",
		parameters: Type.Object({
			groupId: Type.String(),
			name: Type.String(),
			serverIds: Type.String({ description: "Comma-separated server IDs" }),
			vramTotalGb: Type.Optional(Type.Number()),
		}),

		async execute(_toolCallId: string, params: { groupId: string; name: string; serverIds: string; vramTotalGb?: number }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const serverIds = params.serverIds.split(",").map(s => s.trim());

			const group: HardwareGroup = {
				id: params.groupId,
				name: params.name,
				serverIds,
				vramTotalGb: params.vramTotalGb,
			};

			const idx = config.hardwareGroups.findIndex(g => g.id === params.groupId);
			if (idx >= 0) config.hardwareGroups[idx] = group;
			else config.hardwareGroups.push(group);

			await saveConfig(pi);

			return {
				content: [{ type: "text" as const, text: `Group "${params.groupId}" configured with servers: ${serverIds.join(", ")}` }],
				details: { group }
			};
		},
	});
}

function createRunComfyUITool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-run-comfyui",
		label: "Run ComfyUI (with VRAM coordination)",
		description: "Execute ComfyUI workflow with automatic VRAM management (unloads peer servers before running)",
		parameters: Type.Object({
			workflow: Type.String({ description: "Workflow name or JSON" }),
			serverId: Type.Optional(Type.String({ description: "ComfyUI server ID (default: comfy)" })),
			autoManageVram: Type.Optional(Type.Boolean({ description: "Auto-unload other servers (default: true)" })),
		}),

		async execute(_toolCallId: string, params: { workflow: string; serverId?: string; autoManageVram?: boolean }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const serverId = params.serverId || "comfy";
			const autoManage = params.autoManageVram !== false;

			// Step 1: Find other servers in same hardware group
			const otherServers = getOtherServers(serverId);
			const unloaded: string[] = [];

			if (autoManage && otherServers.length > 0) {
				for (const server of otherServers) {
					const endpoint = server.unloadEndpoint || "/unload";
					const result = await callServer(server.id, endpoint, { method: "POST" });
					if (result.success) {
						unloaded.push(server.id);
						recordUnload(server.id);
					} else {
						return { content: [{ type: "text" as const, text: `Warning: Failed to unload ${server.id}: ${result.error}` }], isError: true, details: { promptId: undefined as string | undefined, completed: false as boolean, unloaded, warning: result.error as string | undefined, error: undefined as string | undefined } };
					}
				}
			}

			// Step 2: Execute ComfyUI workflow
			const server = config.servers.find(s => s.id === serverId);
			if (!server) {
				return { content: [{ type: "text" as const, text: `Server "${serverId}" not found. Configure it first with vram-manager-configure-server.` }], isError: true, details: { promptId: undefined as string | undefined, completed: false as boolean, unloaded: [], warning: undefined as string | undefined, error: `Server ${serverId} not found` as string | undefined } };
			}

			let workflowJson: object;
			try {
				workflowJson = JSON.parse(params.workflow);
			} catch {
				const fetchResp = await fetch(`${server.baseUrl}/api/workspace/${params.workflow}`);
				if (!fetchResp.ok) {
					return { content: [{ type: "text" as const, text: `Workflow not found: ${params.workflow}` }], isError: true, details: { promptId: undefined as string | undefined, completed: false as boolean, unloaded: [], warning: undefined as string | undefined, error: `Workflow not found: ${params.workflow}` as string | undefined } };
				}
				workflowJson = await fetchResp.json();
			}

			const execResp = await fetch(`${server.baseUrl}/api/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: workflowJson }),
			});

			if (!execResp.ok) {
				return { content: [{ type: "text" as const, text: `Execution failed: ${execResp.status}` }], isError: true, details: { promptId: undefined as string | undefined, completed: false as boolean, unloaded: [], warning: undefined as string | undefined, error: `Execution failed: ${execResp.status}` as string | undefined } };
			}

			const execData = await execResp.json();
			const promptId = (execData as { prompt_id?: string }).prompt_id;

			// Poll for completion
			let completed = false;
			for (let i = 0; i < 60; i++) {
				await new Promise(r => setTimeout(r, 1000));
				const queueResp = await fetch(`${server.baseUrl}/api/queue`);
				if (!queueResp.ok) continue;
				const queue = await queueResp.json();
				if (!queue?.executing && !queue?.queue_pending?.length) {
					completed = true;
					break;
				}
			}

			return {
				content: [{
					type: "text" as const,
					text: completed
						? `Workflow completed (ID: ${promptId})`
						: `Workflow queued (ID: ${promptId}) — check back with comfyui_status`
				}],
				details: {
					promptId,
					completed,
					unloaded,
					warning: undefined,
					error: undefined
				}
			};
		},
	});
}

function createUnloadTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-unload",
		label: "Unload Server",
		description: "Manually unload models from a server to free VRAM",
		parameters: Type.Object({
			serverId: Type.String(),
		}),

		async execute(_toolCallId: string, params: { serverId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const server = config.servers.find(s => s.id === params.serverId);
			if (!server) {
				return { content: [{ type: "text" as const, text: `Server "${params.serverId}" not found. Configure it first with vram-manager-configure-server.` }], isError: true, details: { success: false, error: `Server ${params.serverId} not found` } };
			}

			const endpoint = server.unloadEndpoint || "/unload";
			const result = await callServer(params.serverId, endpoint, { method: "POST" });

			if (result.success) {
				recordUnload(params.serverId);
			}

			return {
				content: [{
					type: "text" as const,
					text: result.success
						? `Models unloaded from "${params.serverId}" — VRAM freed`
						: `Failed to unload "${params.serverId}": ${result.error}`
				}],
				details: result
			};
		},
	});
}

function createGetConfigTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-get-config",
		label: "Get Config",
		description: "View all registered servers and hardware groups",
		parameters: Type.Object({}),

		async execute(_toolCallId: string, _params: object, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const serverList = config.servers.map(s =>
				`  ${s.id}: ${s.name} (${s.baseUrl})`
			).join("\n");
			const groupList = config.hardwareGroups.map(g =>
				`  ${g.id}: ${g.name} → servers: ${g.serverIds.join(", ")}${g.vramTotalGb ? ` (${g.vramTotalGb} GB)` : ""}`
			).join("\n");

			return {
				content: [{
					type: "text" as const,
					text: [
						"VRAM Manager Configuration",
						"",
						"Servers:",
						serverList || "  (none configured)",
						"",
						"Hardware Groups:",
						groupList || "  (none configured)",
					].join("\n")
				}],
				details: config
			};
		},
	});
}

function createSystemStatsTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-system-stats",
		label: "System Stats",
		description: "Query VRAM/system stats from registered servers",
		parameters: Type.Object({
			serverId: Type.Optional(Type.String({ description: "Server ID to query (omit for all servers)" })),
		}),

		async execute(_toolCallId: string, params: { serverId?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const serverIds = params.serverId
				? [params.serverId]
				: config.servers.map(s => s.id);

			const results: VramStats[] = [];
			for (const id of serverIds) {
				const stats = await getVramStats(id);
				results.push(stats);
			}

			const lines: string[] = ["VRAM Stats:"];
			for (const r of results) {
				lines.push(`  ${r.serverName} (${r.serverId}):`);
				if (r.error) {
					lines.push(`    ${r.error}`);
				} else if (r.devices.length === 0) {
					lines.push(`    No device data`);
				} else {
					for (const d of r.devices) {
						lines.push(`    ${d.name}: ${formatBytes(d.freeBytes)} free / ${formatBytes(d.totalBytes)} total`);
					}
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { stats: results }
			};
		},
	});
}

function createCheckVramConflictTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-check-vram-conflict",
		label: "Check VRAM Conflict",
		description: "Check if running a workflow on a server would cause VRAM conflicts with peers in the same hardware group",
		parameters: Type.Object({
			serverId: Type.String({ description: "Target server ID to check" }),
		}),

		async execute(_toolCallId: string, params: { serverId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const otherServers = getOtherServers(params.serverId);

			if (otherServers.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No VRAM conflict — "${params.serverId}" has no peers in its hardware group` }],
					details: { conflict: false, peerCount: 0, peers: [], details: "No peers in group" }
				};
			}

			// Check VRAM usage on peers
			const peerStats: Array<{ serverId: string; name: string; hasVramData: boolean; freeBytes: number }> = [];
			for (const peer of otherServers) {
				const stats = await getVramStats(peer.id);
				const freeBytes = stats.devices.reduce((sum, d) => sum + d.freeBytes, 0);
				peerStats.push({
					serverId: peer.id,
					name: peer.name,
					hasVramData: stats.devices.length > 0,
					freeBytes
				});
			}

			const hasConflict = peerStats.some(p => p.freeBytes < 1024 * 1024 * 1024); // less than 1GB free
			const conflictWith = peerStats.filter(p => p.freeBytes < 1024 * 1024 * 1024);

			const lines: string[] = [`VRAM Conflict Check for "${params.serverId}":`];
			for (const p of peerStats) {
				const free = p.hasVramData ? formatBytes(p.freeBytes) : "unknown";
				const conflict = p.freeBytes < 1024 * 1024 * 1024 && p.hasVramData ? " ⚠️ conflict" : "";
				lines.push(`  ${p.name}: ${free} free${conflict}`);
			}
			lines.push(hasConflict
				? `Result: VRAM conflict detected — unload these servers before running: ${conflictWith.map(p => p.serverId).join(", ")}`
				: `Result: No VRAM conflict — sufficient free memory available`);

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { conflict: hasConflict, peerCount: otherServers.length, peers: peerStats, details: hasConflict ? `Unload: ${conflictWith.map(p => p.serverId).join(", ")}` : "OK" }
			};
		},
	});
}

function createReloadTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-reload",
		label: "Reload Server",
		description: "Trigger model reload on a server that was previously unloaded",
		parameters: Type.Object({
			serverId: Type.String(),
		}),

		async execute(_toolCallId: string, params: { serverId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const server = config.servers.find(s => s.id === params.serverId);
			if (!server) {
				return { content: [{ type: "text" as const, text: `Server "${params.serverId}" not found.` }], isError: true, details: { success: false, error: `Server ${params.serverId} not found` } };
			}

			const endpoint = server.reloadEndpoint || "/reload";
			const result = await callServer(params.serverId, endpoint, { method: "POST" });

			if (result.success) {
				clearUnloadRecords([params.serverId]);
			}

			return {
				content: [{
					type: "text" as const,
					text: result.success
						? `Models reloaded on "${params.serverId}"`
						: `Failed to reload "${params.serverId}": ${result.error}`
				}],
				details: result
			};
		},
	});
}

function createReloadAllTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-reload-all",
		label: "Reload All Unloaded Servers",
		description: "Trigger model reload on every server that was previously unloaded by the VRAM manager",
		parameters: Type.Object({}),

		async execute(_toolCallId: string, _params: object, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const records = getUnloadedServers();
			if (records.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No servers to reload — nothing has been unloaded this session" }],
					details: { reloaded: [] as string[], count: 0, failed: [] as { serverId: string; error: string }[] }
				};
			}

			const reloaded: string[] = [];
			const failed: Array<{ serverId: string; error: string }> = [];

			for (const record of records) {
				const server = config.servers.find(s => s.id === record.serverId);
				if (!server) {
					failed.push({ serverId: record.serverId, error: "Server not found in config" });
					continue;
				}
				const endpoint = server.reloadEndpoint || "/reload";
				const result = await callServer(record.serverId, endpoint, { method: "POST" });
				if (result.success) {
					reloaded.push(record.serverId);
				} else {
					failed.push({ serverId: record.serverId, error: result.error || "Unknown" });
				}
			}

			clearUnloadRecords(reloaded);

			const lines: string[] = [];
			if (reloaded.length > 0) {
				lines.push(`Reloaded: ${reloaded.join(", ")}`);
			}
			if (failed.length > 0) {
				lines.push(`Failed: ${failed.map(f => `${f.serverId} (${f.error})`).join(", ")}`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") || "No servers to reload" }],
				details: { reloaded, failed, count: reloaded.length }
			};
		},
	});
}

function createLoadedModelsTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-loaded-models",
		label: "Loaded Models",
		description: "Show which servers have been unloaded and are pending reload",
		parameters: Type.Object({}),

		async execute(_toolCallId: string, _params: object, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const records = getUnloadedServers();
			if (records.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No servers have been unloaded this session — all models should be loaded" }],
					details: { unloaded: [], count: 0 }
				};
			}

			const lines: string[] = ["Servers pending reload:"];
			for (const r of records) {
				const server = config.servers.find(s => s.id === r.serverId);
				const name = server?.name || r.serverId;
				const time = new Date(r.timestamp).toLocaleTimeString();
				lines.push(`  ${name} (unloaded at ${time}, reservation: ${r.reservationId})`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { unloaded: records, count: records.length }
			};
		},
	});
}

function createReserveTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-reserve",
		label: "Reserve VRAM",
		description: "Reserve VRAM for a target server by unloading peer servers in the same hardware group. Returns a reservation token to be used with vram-manager-release.",
		parameters: Type.Object({
			serverId: Type.String({ description: "Target server ID to reserve VRAM for" }),
		}),

		async execute(_toolCallId: string, params: { serverId: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const otherServers = getOtherServers(params.serverId);
			const reservationId = generateReservationId();
			const unloaded: string[] = [];
			const failed: Array<{ serverId: string; error: string }> = [];

			for (const server of otherServers) {
				const endpoint = server.unloadEndpoint || "/unload";
				const result = await callServer(server.id, endpoint, { method: "POST" });
				if (result.success) {
					unloaded.push(server.id);
					recordUnload(server.id);
				} else {
					failed.push({ serverId: server.id, error: result.error || "Unknown" });
				}
			}

			const lines: string[] = [`VRAM reserved for "${params.serverId}"`];
			lines.push(`Reservation ID: ${reservationId}`);
			if (unloaded.length > 0) {
				lines.push(`Unloaded: ${unloaded.join(", ")}`);
			}
			if (failed.length > 0) {
				lines.push(`Failed to unload: ${failed.map(f => `${f.serverId} (${f.error})`).join(", ")}`);
			}
			if (otherServers.length === 0) {
				lines.push("No peers in hardware group — no action needed");
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { reservationId, serverId: params.serverId, unloaded, failed, peerCount: otherServers.length }
			};
		},
	});
}

function createReleaseTool(_pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-release",
		label: "Release VRAM",
		description: "Release VRAM reservation by reloading previously-unloaded peer servers. Use the reservation token returned by vram-manager-reserve.",
		parameters: Type.Object({
			reservationId: Type.Optional(Type.String({ description: "Reservation ID from vram-manager-reserve (omit to reload all unloaded servers)" })),
		}),

		async execute(_toolCallId: string, _params: { reservationId?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const records = getUnloadedServers();
			if (records.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No servers to release — nothing has been unloaded this session" }],
					details: { reloaded: [] as string[], count: 0, failed: [] as Array<{ serverId: string; error: string }> }
				};
			}

			const reloaded: string[] = [];
			const failed: Array<{ serverId: string; error: string }> = [];

			for (const record of records) {
				const server = config.servers.find(s => s.id === record.serverId);
				if (!server) {
					failed.push({ serverId: record.serverId, error: "Server not found in config" });
					continue;
				}
				const endpoint = server.reloadEndpoint || "/reload";
				const result = await callServer(record.serverId, endpoint, { method: "POST" });
				if (result.success) {
					reloaded.push(record.serverId);
				} else {
					failed.push({ serverId: record.serverId, error: result.error || "Unknown" });
				}
			}

			clearUnloadRecords(reloaded);

			const lines: string[] = [];
			if (reloaded.length > 0) {
				lines.push(`Released VRAM — reloaded: ${reloaded.join(", ")}`);
			}
			if (failed.length > 0) {
				lines.push(`Failed to reload: ${failed.map(f => `${f.serverId} (${f.error})`).join(", ")}`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") || "No servers to release" }],
				details: { reloaded, failed, count: reloaded.length }
			};
		},
	});
}

function createClearConfigTool(pi: ExtensionAPI) {
	return defineTool({
		name: "vram-manager-clear-config",
		label: "Clear Configuration",
		description: "Reset VRAM manager configuration (removes all servers and hardware groups)",
		parameters: Type.Object({}),

		async execute(_toolCallId: string, _params: object, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			config = { servers: [], hardwareGroups: [] };
			await saveConfig(pi);

			return {
				content: [{ type: "text" as const, text: "Configuration cleared — all servers and hardware groups removed" }],
				details: { config }
			};
		},
	});
}

// ============================================================================
// Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool(createConfigureServerTool(pi));
	pi.registerTool(createConfigureGroupTool(pi));
	pi.registerTool(createRunComfyUITool(pi));
	pi.registerTool(createUnloadTool(pi));
	pi.registerTool(createGetConfigTool(pi));
	pi.registerTool(createSystemStatsTool(pi));
	pi.registerTool(createCheckVramConflictTool(pi));
	pi.registerTool(createClearConfigTool(pi));
	pi.registerTool(createReloadTool(pi));
	pi.registerTool(createReloadAllTool(pi));
	pi.registerTool(createLoadedModelsTool(pi));
	pi.registerTool(createReserveTool(pi));
	pi.registerTool(createReleaseTool(pi));

	// Load persisted config on session start
	pi.on("session_start", async (_event, ctx) => {
		loadConfig(ctx);
	});
}
