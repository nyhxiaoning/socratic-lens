import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModel, getClient } from "../llm";

test("pickModel: audit 优先 LLM_AUDIT_MODEL", () => {
  process.env.LLM_MODEL = "base-model";
  process.env.LLM_AUDIT_MODEL = "audit-model";
  assert.equal(pickModel("audit"), "audit-model");
  delete process.env.LLM_AUDIT_MODEL;
});

test("pickModel: audit 无专用模型时回落 LLM_MODEL", () => {
  process.env.LLM_MODEL = "base-model";
  delete process.env.LLM_AUDIT_MODEL;
  delete process.env.LLM_MODEL_AUDIT;
  assert.equal(pickModel("audit"), "base-model");
});

test("getClient: audit 配了独立端点则用独立 baseURL", () => {
  process.env.LLM_API_KEY = "k1";
  process.env.LLM_BASE_URL = "https://shared.example/v1";
  process.env.LLM_AUDIT_API_KEY = "k2";
  process.env.LLM_AUDIT_BASE_URL = "https://audit.example/v1";
  const c = getClient("audit");
  assert.equal(String(c.baseURL), "https://audit.example/v1");
  delete process.env.LLM_AUDIT_BASE_URL;
  delete process.env.LLM_AUDIT_API_KEY;
});

test("getClient: audit 未配独立端点则回落共享 baseURL", () => {
  process.env.LLM_API_KEY = "k1";
  process.env.LLM_BASE_URL = "https://shared.example/v1";
  delete process.env.LLM_AUDIT_BASE_URL;
  const c = getClient("audit");
  assert.equal(String(c.baseURL), "https://shared.example/v1");
});
