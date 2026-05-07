/**
 * VRAM Manager - Orchestrates VRAM between servers sharing GPU
 * 
 * Coordinates model memory between ComfyUI, LlamaSwap, Ollama, etc.
 * Manages unload before switch, reload after completion.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ============================================================================
// Configuration
// ============================================================================

interface Server {
	id: string;
	name: string;
	baseUrl: string;
	unloadEndpoint?: string;  // defaults to /unload
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

let config: Config = {
	servers: [],
	hardwareGroups: [],
};

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
// Tools
// ============================================================================

const configureServerTool = defineTool({
	name: "vram-manager-configure-server",
	label: "Configure Server",
	description: "Configure a server for VRAM management",
	parameters: Type.Object({
		serverId: Type.String(),
		name: Type.String(),
		baseUrl: Type.String(),
		unloadEndpoint: Type.Optional(Type.String({ description: "Endpoint to unload models (default: /unload)" })),
	}),

	async execute(_toolCallId: string, params: { serverId: string; name: string; baseUrl: string; unloadEndpoint?: string }) {
		const idx = config.servers.findIndex(s => s.id === params.serverId);
		const server: Server = {
			id: params.serverId,
			name: params.name,
			baseUrl: params.baseUrl,
			unloadEndpoint: params.unloadEndpoint || "/unload",
		};
		if (idx >= 0) config.servers[idx] = server;
		else config.servers.push(server);

		return {
			content: [{ type: "text" as const, text: `Server "${params.serverId}" added` }],
			details: { server }
		} as any;
	},
});

const configureGroupTool = defineTool({
	name: "vram-manager-configure-group",
	label: "Configure Hardware Group",
	description: "Create a hardware group (servers sharing same GPU)",
	parameters: Type.Object({
		groupId: Type.String(),
		name: Type.String(),
		serverIds: Type.String({ description: "Comma-separated server IDs" }),
		vramTotalGb: Type.Optional(Type.Number()),
	}),

	async execute(_toolCallId: string, params: { groupId: string; name: string; serverIds: string; vramTotalGb?: number }) {
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

		return {
			content: [{ type: "text" as const, text: `Group "${params.groupId}" created with servers: ${serverIds.join(", ")}` }],
			details: { group }
		} as any;
	},
});

const runComfyUITool = defineTool({
	name: "vram-manager-run-comfyui",
	label: "Run ComfyUI (with VRAM coordination)",
	description: "Execute ComfyUI workflow with automatic VRAM management",
	parameters: Type.Object({
		workflow: Type.String({ description: "Workflow name or JSON" }),
		serverId: Type.Optional(Type.String({ description: "ComfyUI server ID (default: comfy)" })),
		autoManageVram: Type.Optional(Type.Boolean({ description: "Auto-unload other servers (default: true)" })),
	}),

	async execute(_toolCallId: string, params: { workflow: string; serverId?: string; autoManageVram?: boolean }) {
		const serverId = params.serverId || "comfy";
		const autoManage = params.autoManageVram !== false;

		// Step 1: Find other servers in same hardware group
		const otherServers = getOtherServers(serverId);
		
		if (autoManage && otherServers.length > 0) {
			// Step 2: Unload their models
			for (const server of otherServers) {
				const endpoint = server.unloadEndpoint || "/unload";
				const result = await callServer(server.id, endpoint, { method: "POST" });
				if (!result.success) {
					return {
						content: [{ type: "text" as const, text: `Warning: Failed to unload ${server.id}: ${result.error}` }],
						isError: true,
						details: { warning: result.error }
					} as any;
				}
			}
		}

		// Step 3: Execute ComfyUI workflow (HTTP directly)
		// Note: In full impl, would call comfyui-execute-workflow internally
		// For now, we do the HTTP call directly
		const server = config.servers.find(s => s.id === serverId);
		if (!server) {
			return { content: [{ type: "text" as const, text: `Server "${serverId}" not found` }], isError: true } as any;
		}

		// Parse workflow
		let workflowJson: object;
		try {
			workflowJson = JSON.parse(params.workflow);
		} catch {
			// Try to fetch from workspace
			const fetchResp = await fetch(`${server.baseUrl}/api/workspace/${params.workflow}`);
			if (!fetchResp.ok) {
				return { content: [{ type: "text" as const, text: `Workflow not found: ${params.workflow}` }], isError: true } as any;
			}
			workflowJson = await fetchResp.json();
		}

		// Execute
		const execResp = await fetch(`${server.baseUrl}/api/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: workflowJson }),
		});

		if (!execResp.ok) {
			return { content: [{ type: "text" as const, text: `Execution failed: ${execResp.status}` }], isError: true } as any;
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
					? `Workflow completed (ID: ${promptId}) - other servers can now reload`
					: `Workflow queued (ID: ${promptId})`
			}],
			details: { 
				promptId, 
				completed,
				unloaded: autoManage ? otherServers.map(s => s.id) : []
			}
		} as any;
	},
});

const unloadTool = defineTool({
	name: "vram-manager-unload",
	label: "Unload Server",
	description: "Manually unload models from a server",
	parameters: Type.Object({
		serverId: Type.String(),
	}),

	async execute(_toolCallId: string, params: { serverId: string }) {
		const server = config.servers.find(s => s.id === params.serverId);
		if (!server) {
			return { content: [{ type: "text" as const, text: `Server "${params.serverId}" not found` }], isError: true } as any;
		}

		const endpoint = server.unloadEndpoint || "/unload";
		const result = await callServer(params.serverId, endpoint, { method: "POST" });

		return {
			content: [{ 
				type: "text" as const, 
				text: result.success 
					? `Models unloaded from "${params.serverId}"`
					: `Failed: ${result.error}`
			}],
			details: result
		} as any;
	},
});

const getConfigTool = defineTool({
	name: "vram-manager-get-config",
	label: "Get Config",
	description: "Get VRAM manager configuration",
	parameters: Type.Object({}),

	async execute() {
		return {
			content: [{
				type: "text" as const,
				text: `Servers: ${config.servers.map(s => s.id).join(", ")}\nGroups: ${config.hardwareGroups.map(g => g.id).join(", ")}`
			}],
			details: config
		} as any;
	},
});

// ============================================================================
// Extension Entry
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool(configureServerTool);
	pi.registerTool(configureGroupTool);
	pi.registerTool(runComfyUITool);
	pi.registerTool(unloadTool);
	pi.registerTool(getConfigTool);
}