/**
 * Desktop boundary for the post-MVP Tauri shell.
 *
 * The web application is intentionally the canonical UI. A future shell will load
 * its production bundle, store app/Lichess credentials in the OS keychain, and may
 * provide a local Stockfish worker for offline completed-game analysis. Packaging is
 * deferred until the web vertical slice passes product evaluation; no desktop-only
 * chess or agent logic belongs here.
 */
export const desktopPlan = {
  shell: "tauri",
  canonicalUi: "@chess-agent/web",
  credentialStorage: "os-keychain",
  offlineScope: ["saved-games", "completed-game-analysis"]
} as const;

