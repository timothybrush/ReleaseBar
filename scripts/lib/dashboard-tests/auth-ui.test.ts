import assert from "node:assert/strict";
import test from "node:test";
import {
  primaryAuthActionFor,
  primaryAuthLabelFor,
  primaryAuthTitleFor,
} from "../../../src/auth-ui.js";
import type { AuthPayload } from "../../../src/types.js";

function authPayload(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    configured: true,
    quotaConfigured: true,
    user: null,
    installations: [],
    installNeeded: false,
    installReason: null,
    loginUrl: "https://release.bar/api/auth/login",
    logoutUrl: "https://release.bar/api/auth/logout",
    installUrl: "https://release.bar/api/auth/install",
    appUrl: "https://github.com/apps/releasebar-app",
    ...overrides,
  };
}

test("anonymous GitHub action logs in before offering App installation", () => {
  const auth = authPayload();
  assert.equal(primaryAuthActionFor(auth, false), "login");
  assert.equal(primaryAuthLabelFor(auth, false), "Log in with GitHub");
  assert.equal(primaryAuthLabelFor(auth, false, true), "Log in");
  assert.equal(primaryAuthTitleFor(auth, false), "Log in with GitHub");
});

test("App-only deployments keep installation as the available anonymous action", () => {
  const auth = authPayload({ configured: false });
  assert.equal(primaryAuthActionFor(auth, false), "install");
  assert.equal(primaryAuthLabelFor(auth, false), "Install GitHub App");
});

test("signed-in GitHub action only offers installation when coverage is missing", () => {
  const user = {
    id: 1,
    login: "octocat",
    name: null,
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    url: "https://github.com/octocat",
  };
  const covered = authPayload({ user });
  assert.equal(primaryAuthActionFor(covered, false), null);
  assert.equal(primaryAuthLabelFor(covered, false), "GitHub Connected");

  const uncovered = authPayload({ user, installNeeded: true });
  assert.equal(primaryAuthActionFor(uncovered, false), "install");
  assert.equal(primaryAuthLabelFor(uncovered, false), "Install GitHub App");
});
