import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { expect, test as base } from "vitest";
import type { McpCliOptions } from "./parse-args.js";
import { startMcpHttpServer, type McpHttpServerHandle } from "./run-mcp.js";

const httpOptions: McpCliOptions = {
	provider: "local",
	headless: true,
	allowedDomains: [],
	blockedDomains: [],
	transport: "streamable-http",
	host: "127.0.0.1",
	// Port 0 lets the OS pick a free port so parallel test files never collide.
	port: 0,
	path: "/mcp",
};

const test = base.extend<{
	server: McpHttpServerHandle;
	connect: () => Promise<Client>;
}>({
	server: async ({}, use) => {
		const started = await startMcpHttpServer(httpOptions);
		if (started instanceof Error) throw started;
		await use(started);
		await started.close();
	},
	connect: async ({ server }, use) => {
		const clients: Client[] = [];
		await use(async () => {
			const client = new Client({
				name: "libretto-browser-tools-http-test",
				version: "1.0.0",
			});
			await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
			clients.push(client);
			return client;
		});
		await Promise.all(clients.map((client) => client.close()));
	},
});

const MCP_ACCEPT = "application/json, text/event-stream";

async function initializeSession(url: string): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: MCP_ACCEPT },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "raw-test-client", version: "1.0.0" },
			},
		}),
	});
	const sessionId = response.headers.get("mcp-session-id");
	expect(response.status).toBe(200);
	if (!sessionId) throw new Error("initialize did not return a session ID");
	await response.body?.cancel();
	return sessionId;
}

function textPayload(result: { content: { type: string; text?: string }[] }): {
	ok: boolean;
	sessionId: string;
	result?: unknown;
} {
	const text = result.content.find((content) => content.type === "text");
	if (text?.type !== "text" || text.text === undefined) {
		throw new Error("Expected text content");
	}
	return JSON.parse(text.text) as {
		ok: boolean;
		sessionId: string;
		result?: unknown;
	};
}

test("HTTP clients discover the browser tools over Streamable HTTP", async ({
	connect,
}) => {
	const client = await connect();
	const listed = await client.listTools();

	expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
		"browser_close",
		"browser_connect",
		"browser_exec",
		"browser_open",
		"browser_snapshot",
		"browser_status",
	]);
});

test("an HTTP session drives a real browser", async ({ connect }) => {
	const client = await connect();

	const opened = textPayload(
		CallToolResultSchema.parse(
			await client.callTool({
				name: "browser_open",
				arguments: { url: "data:text/html,<title>hello over http</title>" },
			}),
		),
	);
	expect(opened).toMatchObject({ ok: true, sessionId: expect.any(String) });

	const executed = textPayload(
		CallToolResultSchema.parse(
			await client.callTool({
				name: "browser_exec",
				arguments: {
					sessionId: opened.sessionId,
					code: "return await page.title();",
				},
			}),
		),
	);
	expect(executed).toMatchObject({ ok: true, result: "hello over http" });
});

test("concurrent HTTP sessions each get their own browser", async ({
	connect,
}) => {
	const [first, second] = await Promise.all([connect(), connect()]);

	// browser_open without authProfile must not make both sessions contend for
	// the same persistent Chromium profile directory.
	const [openedFirst, openedSecond] = await Promise.all([
		first
			.callTool({
				name: "browser_open",
				arguments: { url: "data:text/html,<title>first</title>" },
			})
			.then((result) => textPayload(CallToolResultSchema.parse(result))),
		second
			.callTool({
				name: "browser_open",
				arguments: { url: "data:text/html,<title>second</title>" },
			})
			.then((result) => textPayload(CallToolResultSchema.parse(result))),
	]);

	expect(openedFirst).toMatchObject({ ok: true });
	expect(openedSecond).toMatchObject({ ok: true });

	const [titleFirst, titleSecond] = await Promise.all([
		first
			.callTool({
				name: "browser_exec",
				arguments: {
					sessionId: openedFirst.sessionId,
					code: "return await page.title();",
				},
			})
			.then((result) => textPayload(CallToolResultSchema.parse(result))),
		second
			.callTool({
				name: "browser_exec",
				arguments: {
					sessionId: openedSecond.sessionId,
					code: "return await page.title();",
				},
			})
			.then((result) => textPayload(CallToolResultSchema.parse(result))),
	]);

	expect(titleFirst.result).toBe("first");
	expect(titleSecond.result).toBe("second");

	// Each MCP session sees only its own browser session.
	const status = textPayload(
		CallToolResultSchema.parse(
			await first.callTool({ name: "browser_status", arguments: {} }),
		),
	) as unknown as { sessions: { sessionId: string }[] };
	expect(status.sessions.map((entry) => entry.sessionId)).toEqual([
		openedFirst.sessionId,
	]);
});

test("an unknown session ID is rejected instead of starting a new session", async ({
	server,
}) => {
	const response = await fetch(server.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: MCP_ACCEPT,
			"mcp-session-id": "not-a-real-session",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "raw-test-client", version: "1.0.0" },
			},
		}),
	});

	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({
		error: expect.stringContaining("initialize request"),
	});
});

test("a request without a session gets an actionable error", async ({
	server,
}) => {
	const response = await fetch(server.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: MCP_ACCEPT },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});

	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		error: expect.stringContaining("initialize"),
	});
});

test("malformed JSON is a client error, not a server error", async ({
	server,
}) => {
	const response = await fetch(server.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: MCP_ACCEPT },
		body: "{",
	});

	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({
		error: expect.stringContaining("valid JSON"),
	});
});

test("request bodies above the size limit are refused", async ({ server }) => {
	const response = await fetch(server.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: MCP_ACCEPT },
		body: "x".repeat(1_048_577),
	});

	expect(response.status).toBe(413);
	expect(await response.json()).toMatchObject({
		error: expect.stringContaining("1 MiB"),
	});
});

test("requests to another path do not reach the MCP transport", async ({
	server,
}) => {
	const response = await fetch(server.url.replace("/mcp", "/nope"), {
		method: "POST",
		headers: { "content-type": "application/json", accept: MCP_ACCEPT },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});

	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({
		error: expect.stringContaining("/mcp"),
	});
});

test("DELETE ends the session and later requests are rejected", async ({
	server,
}) => {
	const sessionId = await initializeSession(server.url);

	const deleted = await fetch(server.url, {
		method: "DELETE",
		headers: { accept: MCP_ACCEPT, "mcp-session-id": sessionId },
	});
	expect(deleted.status).toBe(200);
	await deleted.body?.cancel();

	const afterDelete = await fetch(server.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: MCP_ACCEPT,
			"mcp-session-id": sessionId,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
	});
	expect(afterDelete.status).toBe(404);
	await afterDelete.body?.cancel();
});

test("closing the server stops the listener", async () => {
	const started = await startMcpHttpServer(httpOptions);
	if (started instanceof Error) throw started;
	const { url } = started;
	await started.close();

	await expect(fetch(url, { method: "POST" })).rejects.toThrow();
});

test("a port already in use returns an error the CLI can print", async ({
	server,
}) => {
	const second = await startMcpHttpServer({ ...httpOptions, port: server.port });

	expect(second).toBeInstanceOf(Error);
	if (!(second instanceof Error)) {
		await second.close();
		throw new Error("expected a busy port to return an Error");
	}
	expect(second.message).toContain("--port");
});

test("an explicit authProfile overrides the HTTP default", async ({
	connect,
}) => {
	const client = await connect();

	// The HTTP server defaults to a throwaway profile, but a caller that names a
	// profile must still get the persistent one.
	const opened = textPayload(
		CallToolResultSchema.parse(
			await client.callTool({
				name: "browser_open",
				arguments: {
					url: "data:text/html,<title>named profile</title>",
					authProfile: "http-test-profile",
				},
			}),
		),
	);
	expect(opened).toMatchObject({ ok: true });

	const status = textPayload(
		CallToolResultSchema.parse(
			await client.callTool({ name: "browser_status", arguments: {} }),
		),
	) as unknown as { sessions: { authProfile?: string }[] };
	expect(status.sessions[0]?.authProfile).toBe("http-test-profile");
});

test("requests with an unexpected Host header are refused", async ({
	server,
}) => {
	// fetch() will not send a forged Host header, so use the raw client.
	const status = await new Promise<number>((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port: server.port,
				path: "/mcp",
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: MCP_ACCEPT,
					Host: "attacker.example",
				},
			},
			(response: IncomingMessage) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode ?? 0));
			},
		);
		request.on("error", reject);
		request.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "rebind", version: "1.0.0" },
				},
			}),
		);
	});

	expect(status).toBe(403);
});

test("an IPv6 bind address produces a usable URL", async () => {
	const started = await startMcpHttpServer({ ...httpOptions, host: "::1" });
	if (started instanceof Error) throw started;

	try {
		expect(started.url).toContain("[::1]");
		const response = await fetch(started.url, {
			method: "POST",
			headers: { "content-type": "application/json", accept: MCP_ACCEPT },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "ipv6", version: "1.0.0" },
				},
			}),
		});
		expect(response.status).toBe(200);
		await response.body?.cancel();
	} finally {
		await started.close();
	}
});

test("an unusable bind address explains how to fix --host", async () => {
	const started = await startMcpHttpServer({
		...httpOptions,
		host: "203.0.113.1",
	});

	expect(started).toBeInstanceOf(Error);
	if (!(started instanceof Error)) {
		await started.close();
		throw new Error("expected an unassigned address to return an Error");
	}
	expect(started.message).toContain("--host");
});

test("an abandoned session is closed after it goes idle", async () => {
	// A client that crashes never sends DELETE, and the transport keeps the
	// session alive across connection loss, so the server must expire it.
	const started = await startMcpHttpServer(httpOptions, {
		idleMs: 50,
		sweepMs: 10,
	});
	if (started instanceof Error) throw started;

	try {
		const sessionId = await initializeSession(started.url);

		await expect
			.poll(
				async () => {
					const response = await fetch(started.url, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: MCP_ACCEPT,
							"mcp-session-id": sessionId,
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							method: "tools/list",
						}),
					});
					await response.body?.cancel();
					return response.status;
				},
				{ timeout: 5_000 },
			)
			.toBe(404);
	} finally {
		await started.close();
	}
});
