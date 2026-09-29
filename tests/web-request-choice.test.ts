import assert from "node:assert/strict";
import { test } from "node:test";
import { pillDescription, pillText, pruneChoice, requestBody, usableControls, type RequestControlMeta } from "../web/src/composer/request-choice.js";

const level = (id: string, label: string, values: string[]): RequestControlMeta => ({ id, label, kind: id === "effort" ? "level" : "choice", options: values.map((value) => ({ value, label: value })) });
const openai = [level("effort", "Reasoning", ["low", "high"]), level("serviceTier", "Service tier", ["default", "priority"])];

test("pill text is the label, then the level, then a non-default tier", () => {
  assert.deepEqual(pillText(openai, {}), { label: "Reasoning", level: "", tier: "" });
  assert.deepEqual(pillText(openai, { effort: "high" }), { label: "Reasoning", level: "high", tier: "" });
  assert.deepEqual(pillText(openai, { effort: "high", serviceTier: "priority" }), { label: "Reasoning", level: "high", tier: "priority" });
  assert.deepEqual(pillText(openai, { serviceTier: "priority" }), { label: "Reasoning", level: "", tier: "priority" }, "a tier alone is never shown as a level");
  assert.equal(pillDescription(openai, { effort: "low" }), "Reasoning low, Service tier Agent default");
});

test("a provider with only a tier control labels the pill with it", () => {
  const tierOnly = [level("serviceTier", "Service tier", ["auto", "flex"])];
  assert.deepEqual(pillText(tierOnly, { serviceTier: "flex" }), { label: "Service tier", level: "flex", tier: "" });
  assert.deepEqual(pillText([], { effort: "high" }), { label: "", level: "", tier: "" });
});

test("values no longer offered are pruned and never sent", () => {
  const deepseek = [level("effort", "Reasoning", ["low", "high", "max"])];
  assert.deepEqual(pruneChoice({ effort: "xhigh", serviceTier: "priority" }, deepseek), {});
  assert.equal(requestBody({ effort: "xhigh", serviceTier: "priority" }, deepseek), undefined);
  assert.deepEqual(requestBody({ effort: "max" }, deepseek), { effort: "max" });
  assert.equal(requestBody({ effort: "max" }, []), undefined, "while controls are not loaded nothing is sent");
});

test("the body is undefined at Agent default and carries exactly the chosen fields", () => {
  assert.equal(requestBody({}, openai), undefined);
  assert.deepEqual(requestBody({ serviceTier: "default" }, openai), { serviceTier: "default" });
  assert.deepEqual(requestBody({ effort: "low", serviceTier: "priority" }, openai), { effort: "low", serviceTier: "priority" });
});

test("unknown control ids are ignored, not rendered or sent", () => {
  const odd = [...openai, level("temperature", "Temperature", ["0", "1"])];
  assert.deepEqual(usableControls(odd).map((c) => c.id), ["effort", "serviceTier"]);
  assert.deepEqual(requestBody({ temperature: "1" }, odd), undefined);
});
