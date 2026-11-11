import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRejected } from "../dist/render.js";

test("each rejected candidate is named with its place and the verifier's reason", () => {
  const trace = {
    candidates: [
      { focus: "security", title: "Token leaks to the log", file: "src/a.ts", line: 4 },
      { focus: "sweep", title: "Off by one in paging", file: "src/b.ts", line: 9 },
    ],
    rejected: [
      { candidate: "C2", reason: "The caller clamps the page first." },
      { candidate: "C9", reason: "Made up." },
      { candidate: "3f9a1c2b7d", reason: "The code is gone." },
    ],
    failed_hunters: [],
  };
  assert.deepEqual(renderRejected({ trace }), [
    "Rejected C2: Off by one in paging (src/b.ts:9, sweep). Why: The caller clamps the page first.",
    "Rejected C9: a candidate the review didn't list. Why: Made up.",
    "Rejected 3f9a1c2b7d: an earlier finding. Why: The code is gone.",
  ]);
});
