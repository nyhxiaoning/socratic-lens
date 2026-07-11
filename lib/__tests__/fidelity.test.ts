import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseChecklist, parseReconciliation } from "../fidelity";

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");

test("parseChecklist: 解析四类清单", () => {
  const c = parseChecklist(fx("checklist.sample.json"));
  assert.equal(c.knowledgePoints.length, 2);
  assert.equal(c.knowledgePoints[0].id, "kp1");
  assert.equal(c.exercises[0].answer, "are");
  assert.equal(c.errorSpots.length, 1);
});

test("parseChecklist: 缺失的类默认空数组", () => {
  const c = parseChecklist('{ "knowledgePoints": [{"id":"k","name":"n","sourceQuote":"s"}] }');
  assert.equal(c.assessmentCriteria.length, 0);
  assert.equal(c.exercises.length, 0);
});

test("parseChecklist: 坏 JSON 抛错", () => {
  assert.throws(() => parseChecklist("not json{"), /Fidelity/);
});

test("parseChecklist: 无任何条目抛错", () => {
  assert.throws(
    () => parseChecklist('{"knowledgePoints":[],"assessmentCriteria":[],"exercises":[],"errorSpots":[]}'),
    /没抽到任何条目/,
  );
});

test("parseReconciliation: 解析行", () => {
  const rows = parseReconciliation(fx("reconciliation.sample.json"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "landed");
  assert.equal(rows[2].status, "dropped");
});

test("parseReconciliation: 非法 status 抛错", () => {
  assert.throws(
    () => parseReconciliation('{"rows":[{"checklistId":"x","category":"knowledgePoint","itemName":"y","status":"bogus"}]}'),
    /status/,
  );
});

test("parseReconciliation: 坏 JSON 抛错", () => {
  assert.throws(() => parseReconciliation("]["), /Fidelity/);
});
