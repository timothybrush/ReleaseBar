import type { AuthPayload } from "./types.js";

export type PrimaryAuthAction = "login" | "install" | null;

export function primaryAuthActionFor(
  auth: AuthPayload | null,
  adminRoute: boolean,
): PrimaryAuthAction {
  if (!auth?.configured && !auth?.quotaConfigured) return null;
  if (!auth.user) return auth.configured ? "login" : "install";
  if (adminRoute || !auth.quotaConfigured) return "login";
  return auth.installNeeded ? "install" : null;
}

export function primaryAuthLabelFor(
  auth: AuthPayload | null,
  adminRoute: boolean,
  short = false,
): string {
  const action = primaryAuthActionFor(auth, adminRoute);
  if (action === "login") return short ? "Log in" : "Log in with GitHub";
  if (action === "install") return short ? "Install" : "Install GitHub App";
  if (auth?.user) return short ? "Connected" : "GitHub Connected";
  return short ? "Log in" : "Login Unavailable";
}

export function primaryAuthTitleFor(auth: AuthPayload | null, adminRoute: boolean): string {
  const action = primaryAuthActionFor(auth, adminRoute);
  if (action === "login") return "Log in with GitHub";
  if (action === "install") return "Install GitHub App";
  if (auth?.user) return "GitHub connected";
  return "GitHub connection unavailable";
}
