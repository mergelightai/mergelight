import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHunterPrompt, buildSweepPrompt, focusesFor } from "../dist/prompt.js";

const input = {
  pr: { owner: "acme", repo: "widgets", number: 1, title: "t", author: "a", baseRef: "main", body: "" },
  mergeBase: "base",
  headSha: "head",
  diffStat: "",
  diff: "",
  diffTruncated: false,
};

const normal = ["access", "data", "behavior"];

test("app code gets the three usual reviewers, and no extra cost", () => {
  for (const paths of [["src/billing.ts"], ["api/routes/users.ts", "web/app.tsx"], ["README.md"], []]) {
    assert.deepEqual(focusesFor(paths), normal, paths.join());
  }
});

test("files that decide what runs add the CI and supply chain reviewer", () => {
  for (const path of [
    ".github/workflows/mergelight.yml",
    ".github/actions/setup/action.yml",
    "Dockerfile",
    "services/api/Dockerfile.prod",
    "docker-compose.yml",
    "compose.yaml",
    "render.yaml",
    "package.json",
    "packages/web/package.json",
    "requirements-dev.txt",
    "pyproject.toml",
    "go.mod",
    "infra/main.tf",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    ".npmrc",
  ]) {
    assert.deepEqual(focusesFor(["src/a.ts", path]), [...normal, "supply"], path);
  }
});

test("names that only look like those files don't count", () => {
  for (const path of ["src/package.json.ts", "src/dockerfile-parser.ts", "docs/render.yaml.md", "src/workflows/run.ts", "package-lock.json", "yarn.lock"]) {
    assert.deepEqual(focusesFor([path]), normal, path);
  }
});

test("the supply chain reviewer knows what to look for and when not to bother", () => {
  const prompt = buildHunterPrompt(input, "supply");
  assert.match(prompt, /CI and supply chain/);
  assert.match(prompt, /full commit SHA/);
  assert.match(prompt, /actions\/\*, github\/\*/, "GitHub's own actions on a tag are normal");
  assert.match(prompt, /\$\{\{ github\.event/, "the expression stays literal text");
});

test("the usual reviewers and the sweep don't get its brief", () => {
  assert.doesNotMatch(buildHunterPrompt(input, "access"), /full commit SHA/);
  assert.doesNotMatch(buildSweepPrompt(input, ["a.ts"]), /full commit SHA/);
});
