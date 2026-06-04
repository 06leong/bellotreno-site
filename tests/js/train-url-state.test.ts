import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTrainUrlNumber,
  parseTrainTriple,
  readTrainUrlState,
  trainStateToSearch,
  trainTripleToSearch,
} from "../../src/client/train-url-state.ts";

test("train URL state normalizes train input to numeric query value", () => {
  assert.equal(normalizeTrainUrlNumber("FR 9651"), "9651");
  assert.deepEqual(readTrainUrlState("?train=FR9651"), { trainNumber: "9651" });
  assert.equal(trainStateToSearch({ trainNumber: "FR9651" }), "train=9651");
});

test("train URL state preserves exact detail identity with origin and timestamp", () => {
  const state = parseTrainTriple("9651-S01700-1780524000000");

  assert.deepEqual(state, {
    trainNumber: "9651",
    originId: "S01700",
    timestamp: "1780524000000",
  });
  assert.equal(trainTripleToSearch("9651-S01700-1780524000000"), "train=9651&origin=S01700&ts=1780524000000");
  assert.deepEqual(readTrainUrlState("?train=9651&origin=S01700&ts=1780524000000"), state);
});

test("train URL state ignores incomplete exact detail parameters", () => {
  assert.deepEqual(readTrainUrlState("?train=9651&origin=S01700"), { trainNumber: "9651" });
  assert.equal(parseTrainTriple("9651-S01700-not-a-time"), null);
});
