// Demonstrates the 403 insufficient_scope path: gets a token via direct
// grant (Resource Owner Password) for the SAME user/client but requesting
// only 'openid' (no mcp:tools.read scope), then calls /mcp and expects 403.
// NOTE: direct grant is used here ONLY as a shortcut to mint a low-scope
// token for this negative-path demo — the real flow demonstrated in
// pkce-client.ts is Authorization Code + PKCE.
const ISSUER = process.env.OAUTH_ISSUER ?? "http://127.0.0.1:8080/realms/mcp-demo";
const CLIENT_ID = process.env.CLIENT_ID ?? "mcp-console";
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const USERNAME = process.env.DEMO_USERNAME ?? "alice";
const PASSWORD = process.env.DEMO_PASSWORD ?? "alice-throwaway-local-pw";

async function main() {
  const tokenRes = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: CLIENT_ID,
      username: USERNAME,
      password: PASSWORD,
      scope: "openid",
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("Low-scope token request failed:", tokens);
    process.exit(1);
  }
  console.log("Got low-scope token (no mcp:tools.read).");

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pkce-demo-client", version: "1.0.0" },
      },
    }),
  });
  console.log("Status:", res.status);
  console.log("WWW-Authenticate:", res.headers.get("www-authenticate"));
  console.log("Body:", await res.text());
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
