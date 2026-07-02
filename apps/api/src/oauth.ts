import {
  createPkceAuthorization,
  exchangeLichessAuthorizationCode,
  type LichessCredentialStore
} from "@chess-agent/platform-adapter";
import type { UserId } from "@chess-agent/shared-types";

interface PendingAuthorization {
  readonly userId: UserId;
  readonly verifier: string;
  readonly expiresAt: number;
}

export interface LichessOAuthOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly credentials: LichessCredentialStore;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly successRedirect?: string;
  readonly now?: () => Date;
}

export class LichessOAuthCoordinator {
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(private readonly options: LichessOAuthOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  start(userId: UserId): string {
    this.#purgeExpired();
    const authorization = createPkceAuthorization({
      clientId: this.options.clientId,
      redirectUri: this.options.redirectUri,
      scopes: ["board:play", "challenge:write"] ,
      ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl })
    });
    this.#pending.set(authorization.state, {
      userId,
      verifier: authorization.codeVerifier,
      expiresAt: this.#now().getTime() + 10 * 60_000
    });
    return authorization.authorizationUrl;
  }

  async complete(code: string, state: string): Promise<{ readonly userId: UserId; readonly redirectTo: string }> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (pending === undefined || pending.expiresAt <= this.#now().getTime()) throw new OAuthError("OAuth state is invalid or expired");
    const { accessToken } = await exchangeLichessAuthorizationCode({
      clientId: this.options.clientId,
      redirectUri: this.options.redirectUri,
      code,
      codeVerifier: pending.verifier,
      fetch: this.#fetch,
      ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl })
    });
    const account = await this.#fetch(new URL("/api/account", this.options.baseUrl ?? "https://lichess.org"), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
    if (!account.ok) throw new OAuthError("Could not read the connected Lichess account");
    const value: unknown = await account.json();
    if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>).username !== "string") {
      throw new OAuthError("Lichess returned an invalid account profile");
    }
    await this.options.credentials.set(pending.userId, {
      username: (value as { username: string }).username,
      accessToken
    });
    return { userId: pending.userId, redirectTo: this.options.successRedirect ?? "/?lichess=connected" };
  }

  #purgeExpired(): void {
    const now = this.#now().getTime();
    for (const [state, value] of this.#pending) if (value.expiresAt <= now) this.#pending.delete(state);
  }
}

export class OAuthError extends Error {}

