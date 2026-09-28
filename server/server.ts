// MCP resource server: validates OAuth2 access tokens (RFC 8707 audience,
// RFC 9728 protected resource metadata) before serving MCP tool calls.
// This server NEVER issues tokens — Keycloak is the sole authorization server.
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 3000);
const MCP_RESOURCE = process.env.MCP_RESOURCE ?? "http://127.0.0.1:3000/mcp";
const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? "http://127.0.0.1:8080/realms/mcp-demo";
const OAUTH_JWKS_URI =
  process.env.OAUTH_JWKS_URI ?? `${OAUTH_ISSUER}/protocol/openid-connect/certs`;
const REQUIRED_SCOPE = process.env.REQUIRED_SCOPE ?? "mcp:tools.read";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://127.0.0.1:8081")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
const jwks = createRemoteJWKSet(new URL(OAUTH_JWKS_URI));

function wwwAuthHeader(reason: "invalid_token" | "insufficient_scope", extra = "") {
  const prmUrl = `${MCP_RESOURCE.replace(/\/mcp$/, "")}${PRM_PATH}`;
  return `Bearer resource_metadata="${prmUrl}", error="${reason}"${extra}`;
}

type AuthedRequest = Request & {
  auth?: { sub: string; scopes: string[]; claims: Record<string, unknown> };
};

// --- Origin check: DNS-rebinding defense (RFC / MCP guidance) ---
function originGuard(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: "forbidden_origin" });
    return;
  }
  next();
}

// --- Bearer token validation: issuer, audience (RFC 8707), expiry, signature, scope ---
async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res
      .status(401)
      .set("WWW-Authenticate", wwwAuthHeader("invalid_token"))
      .json({ error: "unauthorized", error_description: "Missing bearer token" });
    return;
  }
  const token = header.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: OAUTH_ISSUER,
      audience: MCP_RESOURCE,
    });
    const scopeClaim = typeof payload.scope === "string" ? payload.scope : "";
    const scopes = scopeClaim.split(" ").filter(Boolean);
    if (!scopes.includes(REQUIRED_SCOPE)) {
      res
        .status(403)
        .set("WWW-Authenticate", wwwAuthHeader("insufficient_scope", ` scope="${REQUIRED_SCOPE}"`))
        .json({ error: "insufficient_scope", required_scope: REQUIRED_SCOPE });
      return;
    }
    req.auth = { sub: String(payload.sub), scopes, claims: payload as Record<string, unknown> };
    next();
  } catch (err) {
    res
      .status(401)
      .set("WWW-Authenticate", wwwAuthHeader("invalid_token"))
      .json({ error: "invalid_token", error_description: (err as Error).message });
  }
}

function buildMcpServer(auth: NonNullable<AuthedRequest["auth"]>) {
  const server = new McpServer({ name: "mcp-keycloak-pkce-demo", version: "1.0.0" });

  server.registerTool(
    "hello",
    {
      title: "Hello",
      description: "Says hello to the authenticated caller",
      inputSchema: { name: z.string().min(1).max(100).optional() },
    },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `Hello${name ? `, ${name}` : ""}! Authenticated as sub=${auth.sub}`,
        },
      ],
    }),
  );

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "Returns the validated token subject and granted scopes",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ sub: auth.sub, scopes: auth.scopes }, null, 2),
        },
      ],
    }),
  );

  return server;
}

const app = express();
app.use(express.json());

// RFC 9728 Protected Resource Metadata — tells clients where the AS is.
app.get(PRM_PATH, (_req, res) => {
  res.json({
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [REQUIRED_SCOPE],
    bearer_methods_supported: ["header"],
  });
});

app.post("/mcp", originGuard, requireAuth, async (req: AuthedRequest, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(req.auth!);
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", originGuard, requireAuth, async (_req, res) => {
  res.status(405).json({ error: "method_not_allowed" });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`MCP resource server listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`Resource: ${MCP_RESOURCE}`);
  console.log(`Issuer:   ${OAUTH_ISSUER}`);
  console.log(`JWKS:     ${OAUTH_JWKS_URI}`);
  console.log(`Required scope: ${REQUIRED_SCOPE}`);
  console.log(`PRM: http://127.0.0.1:${PORT}${PRM_PATH}`);
});
