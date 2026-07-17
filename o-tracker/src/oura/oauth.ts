import { config, OURA_REDIRECT_URI } from "../config.js";

/**
 * Oura OAuth2 authorization-code flow.
 *
 * Personal access tokens were discontinued by Oura in Dec 2025, so a public
 * multi-user app MUST use OAuth2. Register the app at
 * https://cloud.ouraring.com/oauth/applications to obtain client id/secret and
 * to register the redirect URI (OURA_REDIRECT_URI).
 */

const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";

// Scopes needed for the metrics the product shows. `personal` covers profile,
// `daily` the daily summaries, plus heart rate / workout / session / spo2 / tag.
export const OURA_SCOPES = [
  "email",
  "personal",
  "daily",
  "heartrate",
  "workout",
  "session",
  "spo2",
  "tag",
].join(" ");

export interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number; // seconds
  scope?: string;
}

/** Build the URL to send the user to for consent. `state` binds it to a Telegram user. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.OURA_CLIENT_ID,
    redirect_uri: OURA_REDIRECT_URI,
    scope: OURA_SCOPES,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code (from the redirect) for tokens. */
export async function exchangeCode(code: string): Promise<OuraTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OURA_REDIRECT_URI,
    client_id: config.OURA_CLIENT_ID,
    client_secret: config.OURA_CLIENT_SECRET,
  });
  return tokenRequest(body);
}

/** Use a refresh token to obtain a fresh access token (rotates refresh token too). */
export async function refreshTokens(refreshToken: string): Promise<OuraTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.OURA_CLIENT_ID,
    client_secret: config.OURA_CLIENT_SECRET,
  });
  return tokenRequest(body);
}

async function tokenRequest(body: URLSearchParams): Promise<OuraTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Oura token request failed: ${res.status} ${text}`);
  }
  return (await res.json()) as OuraTokenResponse;
}
