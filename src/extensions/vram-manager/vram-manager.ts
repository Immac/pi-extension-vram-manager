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
		}),

		async execute(_toolCallId: string, params: { serverId: string; name: string; baseUrl: string; unloadEndpoint?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			loadConfig(ctx);

			const idx = config.servers.findIndex(s => s.id === params.serverId);
			const server: Server = {
				id: params.serverId,
				name: params.name,
				baseUrl: params.baseUrl,
				unloadEndpoint: params.unloadEndpoint || "/unload",
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

function createRunComfyUITool(pi: ExtensionAPI) {
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

function createUnloadTool(pi: ExtensionAPI) {
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

function createGetConfigTool(pi: ExtensionAPI) {
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
	pi.registerTool(createClearConfigTool(pi));

	// Load persisted config on session start
	pi.on("session_start", async (_event, ctx) => {
		loadConfig(ctx);
	});
}
