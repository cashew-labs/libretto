import {
	formatCliProviderList,
	isCliProviderName,
	type CliProviderName,
} from "./create-cli-provider.js";

export type McpCliOptions = {
	provider: CliProviderName;
	headless: boolean;
	allowedDomains: string[];
	blockedDomains: string[];
	transport: "stdio" | "streamable-http";
	host: string;
	port: number;
	path: string;
};

export type ParsedCli =
	| { kind: "help" }
	| { kind: "error"; message: string; recovery: string }
	| { kind: "mcp"; options: McpCliOptions };

const HELP = `Start an MCP server that exposes Libretto browser tools.

Usage:
  libretto-browser-tools [mcp] [options]

Options:
  --provider <name>        Browser provider (default: local)
                           ${formatCliProviderList()}
  --headed                 Show the browser window (default: headless)
  --allowed-domain <host>  Allow http(s) navigation to this host (repeatable)
  --blocked-domain <host>  Block http(s) navigation to this host (repeatable)
  --transport <name>       MCP transport: stdio or streamable-http (default: stdio)
  --host <address>         HTTP bind address (default: 127.0.0.1)
  --port <number>          HTTP port (default: 40103)
  --path <path>            HTTP MCP path (default: /mcp)
  -h, --help               Show this help

Cloud providers read API keys from the environment (for example KERNEL_API_KEY).
--headed applies to local, kernel, and libretto-cloud.

Examples:
  npx -y libretto-browser-tools
  npx -y libretto-browser-tools mcp --headed
  npx -y libretto-browser-tools --provider kernel
  npx -y libretto-browser-tools --allowed-domain example.com

Configure an MCP client with command "npx" and args ["-y", "libretto-browser-tools"].
Install Chromium once for --provider local: npx playwright install chromium
`;

export function getHelpText(): string {
	return HELP;
}

function missingFlagValue(
	flag: string,
	example: string,
): Extract<ParsedCli, { kind: "error" }> {
	return {
		kind: "error",
		message: `Missing value for ${flag}.`,
		recovery: `Pass a value after the flag, for example \`${example}\`.`,
	};
}

/**
 * Parse CLI argv (without the node executable or script path).
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
	const tokens = [...argv];
	if (tokens[0] === "mcp") {
		tokens.shift();
	}

	let provider: CliProviderName = "local";
	let headless = true;
	const allowedDomains: string[] = [];
	const blockedDomains: string[] = [];
	let transport: "stdio" | "streamable-http" = "stdio";
	let host = "127.0.0.1";
	let port = 40103;
	let path = "/mcp";

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === undefined) break;

		if (token === "-h" || token === "--help" || token === "help") {
			return { kind: "help" };
		}

		if (token === "--headed") {
			headless = false;
			continue;
		}

		if (token === "--headless") {
			headless = true;
			continue;
		}

		if (token === "--provider") {
			const value = tokens[++i];
			if (value === undefined || value.startsWith("-")) {
				return missingFlagValue(
					"--provider",
					`--provider kernel`,
				);
			}
			if (!isCliProviderName(value)) {
				return {
					kind: "error",
					message: `Unknown provider: ${value}`,
					recovery: `Use one of: ${formatCliProviderList()}.`,
				};
			}
			provider = value;
			continue;
		}

		if (token.startsWith("--provider=")) {
			const value = token.slice("--provider=".length);
			if (value.length === 0) {
				return missingFlagValue(
					"--provider",
					`--provider=kernel`,
				);
			}
			if (!isCliProviderName(value)) {
				return {
					kind: "error",
					message: `Unknown provider: ${value}`,
					recovery: `Use one of: ${formatCliProviderList()}.`,
				};
			}
			provider = value;
			continue;
		}

		if (token === "--allowed-domain") {
			const value = tokens[++i];
			if (value === undefined || value.startsWith("-")) {
				return missingFlagValue(
					"--allowed-domain",
					`--allowed-domain example.com`,
				);
			}
			allowedDomains.push(value);
			continue;
		}

		if (token.startsWith("--allowed-domain=")) {
			const value = token.slice("--allowed-domain=".length);
			if (value.length === 0) {
				return missingFlagValue(
					"--allowed-domain",
					`--allowed-domain=example.com`,
				);
			}
			allowedDomains.push(value);
			continue;
		}

		if (token === "--blocked-domain") {
			const value = tokens[++i];
			if (value === undefined || value.startsWith("-")) {
				return missingFlagValue(
					"--blocked-domain",
					`--blocked-domain ads.example.com`,
				);
			}
			blockedDomains.push(value);
			continue;
		}

		if (token.startsWith("--blocked-domain=")) {
			const value = token.slice("--blocked-domain=".length);
			if (value.length === 0) {
				return missingFlagValue(
					"--blocked-domain",
					`--blocked-domain=ads.example.com`,
				);
			}
			blockedDomains.push(value);
			continue;
		}

		if (token === "--transport" || token === "--host" || token === "--port" || token === "--path") {
			const value = tokens[++i];
			if (value === undefined || (token !== "--port" && value.startsWith("-"))) {
				return missingFlagValue(token, `${token} ${token === "--transport" ? "streamable-http" : token === "--port" ? "40103" : token === "--path" ? "/mcp" : "127.0.0.1"}`);
			}
			if (token === "--transport") {
				if (value !== "stdio" && value !== "streamable-http") return { kind: "error", message: `Unknown transport: ${value}`, recovery: "Use `stdio` or `streamable-http`." };
				transport = value;
			} else if (token === "--host") host = value;
			else if (token === "--path") path = value.startsWith("/") ? value : `/${value}`;
			else {
				const parsedPort = Number(value);
				if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) return { kind: "error", message: `Invalid port: ${value}`, recovery: "Use a number from 0 through 65535." };
				port = parsedPort;
			}
			continue;
		}

		return {
			kind: "error",
			message: `Unknown argument: ${token}`,
			recovery:
				"Remove the unknown argument, or run `libretto-browser-tools --help` for usage.",
		};
	}

	return {
		kind: "mcp",
		options: { provider, headless, allowedDomains, blockedDomains, transport, host, port, path },
	};
}
