#!/usr/bin/env node
/**
 * google-auth.mjs: one-time Google Calendar authorisation.
 *
 * Run manually during setup (not by the agent):
 *
 *   node --env-file=.env scripts/google-auth.mjs
 *
 * Uses the OAuth2 loopback flow for installed apps: starts a throwaway HTTP
 * server on 127.0.0.1, prints the consent URL for you to open, receives the
 * redirect with the authorisation code, exchanges it for a refresh token, and
 * writes data/google-token.json (gitignored). scripts/calendar.mjs then mints
 * short-lived access tokens from it transparently.
 *
 * Prerequisites (once, in Google Cloud Console):
 *   1. Create a project, enable the "Google Calendar API".
 *   2. Configure the OAuth consent screen (External, add yourself as a test
 *      user; publishing is not needed for personal use).
 *   3. Create an OAuth client of type "Desktop app" and put its id/secret in
 *      .env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 *
 * For scale-to-zero deployments, copy the printed refresh token into Secret
 * Manager and expose it as GOOGLE_REFRESH_TOKEN; the token file is only the
 * local convenience store.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Full calendar scope (not .events) so the agent can also create a dedicated
// "Training" calendar via `calendar.mjs use-calendar --create`.
const SCOPE = "https://www.googleapis.com/auth/calendar";
const TOKEN_FILE = path.resolve(
  process.cwd(),
  process.env.GOOGLE_TOKEN_FILE ?? path.join("data", "google-token.json"),
);

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Create a Desktop-app " +
      "OAuth client in Google Cloud Console, add both to .env, then re-run with:\n" +
      "  node --env-file=.env scripts/google-auth.mjs",
  );
  process.exit(1);
}

const server = http.createServer();
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    // Force the consent screen so Google always returns a refresh token, even
    // if the app was authorised before.
    prompt: "consent",
  }).toString();

  console.log("Open this URL in your browser and grant calendar access:\n");
  console.log(url.toString());
  console.log("\nWaiting for Google to redirect back...");

  server.on("request", async (req, res) => {
    const reqUrl = new URL(req.url, redirectUri);
    const code = reqUrl.searchParams.get("code");
    const error = reqUrl.searchParams.get("error");
    if (!code && !error) {
      // Favicon or stray request; ignore and keep waiting.
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      error
        ? `<h3>Authorisation failed: ${error}</h3>You can close this tab.`
        : "<h3>Authorised.</h3>You can close this tab and return to the terminal.",
    );
    server.close();
    if (error) {
      console.error(`Authorisation failed: ${error}`);
      process.exit(1);
    }
    try {
      await exchange(code, redirectUri);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });
});

async function exchange(code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Token exchange failed (${res.status}): ${json.error_description ?? json.error ?? "no refresh token returned"}`,
    );
  }
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      {
        refresh_token: json.refresh_token,
        access_token: json.access_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
      },
      null,
      2,
    ),
  );
  console.log(`\nRefresh token saved to ${path.relative(process.cwd(), TOKEN_FILE)}.`);
  console.log("Google Calendar is ready. Try: node scripts/calendar.mjs status");
  console.log(
    "\nDeploying to a host without this file? Store the refresh token as the " +
      "GOOGLE_REFRESH_TOKEN secret instead (it is the refresh_token field in that file).",
  );
}
