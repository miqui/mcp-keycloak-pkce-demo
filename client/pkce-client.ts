// PKCE client: real Authorization Code + PKCE (S256) flow against Keycloak,
// using a local loopback HTTP server (127.0.0.1:8081) to catch the redirect,
// exactly like a native/desktop OAuth client (RFC 8252). A headless browser
// (via `open`-less curl simulation of the login form POST) drives the login
// so the whole thing runs without manual clicking in this sandbox.
import http from "node:http";
import crypto from "node:crypto";
import { decodeJwt } from "jose";

const ISSUER = process.env.OAUTH_ISSUER ?? "http://127.0.0.1:8080/realms/mcp-demo";
const CLIENT_ID = process.env.CLIENT_ID ?? "mcp-console";
const REDIRECT_URI = process.env.REDIRECT_URI ?? "http://127.0.0.1:8081/callback";
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const SCOPE = process.env.SCOPE ?? "openid mcp:tools.read";
const USERNAME = process.env.DEMO_USERNAME ?? "alice";
const PASSWORD = process.env.DEMO_PASSWORD ?? "alice-throwaway-local-pw";

function b64url(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function waitForCallback(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const gotState = url.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/plain" }).end(
        "Login complete, you can close this tab.",
      );
      server.close();
      if (!code || gotState !== state) {
        reject(new Error("callback missing code or state mismatch"));
        return;
      }
      resolve(code);
    });
    server.listen(8081, "127.0.0.1");
  });
}

// Drives the Keycloak login form programmatically (fetch + cookie jar) to
// simulate what a real browser does when the user submits credentials.
// This is still the real Authorization Code + PKCE flow end-to-end; only the
// "click login" step is scripted instead of a human using a browser.
async function loginAndGetCode(authUrl: string, state: string): Promise<string> {
  const cookies: string[] = [];
  const jarHeader = () => cookies.join("; ");

  const step1 = await fetch(authUrl, { redirect: "manual" });
  step1.headers.getSetCookie?.().forEach((c) => cookies.push(c.split(";")[0]));
  const html = await step1.text();
  const formActionMatch = html.match(/action="([^"]+)"/);
  if (!formActionMatch) throw new Error("could not find Keycloak login form action");
  const formAction = formActionMatch[1].replace(/&amp;/g, "&");

  const body = new URLSearchParams({ username: USERNAME, password: PASSWORD });
  const step2 = await fetch(formAction, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jarHeader(),
    },
    body,
    redirect: "manual",
  });

  const location = step2.headers.get("location");
  if (step2.status < 300 || step2.status >= 400 || !location) {
    const errBody = await step2.text().catch(() => "");
    throw new Error(
      `Keycloak login did not redirect as expected (status ${step2.status}): ${errBody.slice(0, 300)}`,
    );
  }
  const redirected = new URL(location);
  const code = redirected.searchParams.get("code");
  const gotState = redirected.searchParams.get("state");
  if (!code || gotState !== state) throw new Error("no code in login redirect");
  return code;
}

async function main() {
  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));

  const authUrl = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("=== 1. Authorization request (Authorization Code + PKCE) ===");
  console.log("Auth URL:", authUrl.toString());
  console.log(`code_verifier (kept by client): ${verifier.slice(0, 12)}...`);
  console.log(`code_challenge (sent, S256):    ${challenge}`);

  console.log("\n=== 2. Simulating browser login as 'alice' against Keycloak ===");
  const code = await loginAndGetCode(authUrl.toString(), state);
  console.log("Received authorization code:", code.slice(0, 12) + "...");

  console.log("\n=== 3. Exchanging code for tokens at the token endpoint (with code_verifier) ===");
  const tokenRes = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("Token exchange failed:", tokens);
    process.exit(1);
  }
  const accessToken = tokens.access_token as string;
  const claims = decodeJwt(accessToken);
  console.log("Token exchange OK. Decoded access token claims:");
  console.log(
    JSON.stringify(
      { iss: claims.iss, aud: claims.aud, azp: (claims as any).azp, scope: (claims as any).scope, sub: claims.sub, exp: claims.exp },
      null,
      2,
    ),
  );

  console.log("\n=== 4. Calling MCP server WITHOUT a token (expect 401) ===");
  const noAuthRes = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  console.log("Status:", noAuthRes.status);
  console.log("WWW-Authenticate:", noAuthRes.headers.get("www-authenticate"));
  console.log("Body:", await noAuthRes.text());

  console.log("\n=== 5. MCP initialize + tools/call('hello') WITH valid token ===");
  const initRes = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
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
  console.log("initialize status:", initRes.status);
  console.log("initialize body:", await initRes.text());

  const helloRes = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "hello", arguments: { name: "Miguel" } },
    }),
  });
  console.log("tools/call(hello) status:", helloRes.status);
  console.log("tools/call(hello) body:", await helloRes.text());

  const whoamiRes = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  console.log("tools/call(whoami) status:", whoamiRes.status);
  console.log("tools/call(whoami) body:", await whoamiRes.text());
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
