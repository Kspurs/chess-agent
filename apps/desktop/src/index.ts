/**
 * Desktop metadata for the Tauri shell. The web application remains the canonical
 * UI, and no chess or agent logic is duplicated in the native package.
 */
export const desktopPlan = {
  shell: "tauri",
  canonicalUi: "@chess-agent/web",
  credentialStorage: "os-keychain",
  offlineScope: ["saved-games", "completed-game-analysis"],
  status: "scaffolded"
} as const;
