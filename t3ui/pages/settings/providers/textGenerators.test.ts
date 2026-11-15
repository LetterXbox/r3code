import { expect, test } from "nsh/test";
import { filterGeneratorModels, nextTextGeneratorId, readTextGenerators, taskSelection, textGenerationTargets, textGeneratorBrand, textGeneratorDisplayName, validBaseUrl } from "./textGenerators";

test("generators read from settings and are named by label, preset or host", () => {
  const list = readTextGenerators({ openai: { kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1", enabled: false }, mine: { kind: "anthropic", label: "Mine", baseUrl: "https://x.test/v1" }, bad: { kind: "other", baseUrl: "x" } });
  expect(list.map((item) => item.id)).toEqual(["openai", "mine"]);
  expect(list[0]?.enabled).toBe(false);
  expect(textGeneratorDisplayName(list[0] as any)).toBe("OpenAI");
  expect(textGeneratorDisplayName(list[1] as any)).toBe("Mine");
  expect(textGeneratorDisplayName({ kind: "openaiCompatible", baseUrl: "http://localhost:11434/v1" })).toBe("localhost:11434");
});

test("new ids avoid instances, drivers and other generators", () => {
  expect(nextTextGeneratorId("openai", ["openai", "openai-2"])).toBe("openai-3");
  expect(nextTextGeneratorId("codex", [])).toBe("codex-2");
  expect(nextTextGeneratorId("openrouter", [])).toBe("openrouter");
});

test("validBaseUrl accepts http(s) without credentials", () => {
  expect(validBaseUrl("https://api.openai.com/v1")).toBe(true);
  expect(validBaseUrl("ftp://x")).toBe(false);
  expect(validBaseUrl("https://u:p@x.test")).toBe(false);
  expect(validBaseUrl("")).toBe(false);
});

test("the base URL may not carry a query or fragment", () => {
  expect(validBaseUrl("https://x.test/v1?key=1")).toBe(false);
  expect(validBaseUrl("https://x.test/v1#frag")).toBe(false);
});

test("the brand follows the service the generator reaches", () => {
  expect(textGeneratorBrand({ kind: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic");
  expect(textGeneratorBrand({ kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1" })).toBe("openai");
  expect(textGeneratorBrand({ kind: "openaiCompatible", baseUrl: "https://openrouter.ai/api/v1" })).toBe("openrouter");
  expect(textGeneratorBrand({ kind: "openaiCompatible", baseUrl: "http://localhost:11434/v1" })).toBe("ollama");
  expect(textGeneratorBrand({ kind: "openaiCompatible", baseUrl: "https://my.models.test/v1" })).toBe("openaiCompatible");
});

test("source control and voice follow the text generation model until they have their own", () => {
  const settings = { textGenerationModelSelection: { instanceId: "codex", model: "gpt-5" }, sourceControlWriterModelSelection: { instanceId: "openai", model: "gpt-4o-mini" } };
  expect(taskSelection(settings, "textGenerationModelSelection")).toEqual({ own: { instanceId: "codex", model: "gpt-5" }, selection: { instanceId: "codex", model: "gpt-5" } });
  expect(taskSelection(settings, "sourceControlWriterModelSelection").own?.instanceId).toBe("openai");
  expect(taskSelection(settings, "speechPostProcessingModelSelection")).toEqual({ own: null, selection: { instanceId: "codex", model: "gpt-5" } });
});

test("generator models search by id or name and the targets replace a provider with the same id", () => {
  const models = [{ id: "gpt-4o", name: "GPT 4o" }, { id: "o3-mini", name: "Reasoning mini" }];
  expect(filterGeneratorModels(models, "  MINI ").map((model) => model.id)).toEqual(["o3-mini"]);
  expect(filterGeneratorModels(models, "").length).toBe(2);
  const generator = readTextGenerators({ openai: { kind: "openaiCompatible", baseUrl: "https://api.openai.com/v1", enabled: true }, off: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", enabled: false } });
  const provider = (instanceId: string, over: Record<string, unknown> = {}) => ({ instanceId, driver: instanceId, displayName: null, enabled: true, models: [{ slug: "m", name: "M" }], ...over });
  const targets = textGenerationTargets([provider("codex"), provider("openai"), provider("grok", { supportsTextGeneration: false }), provider("cursor", { enabled: false })], generator, { openai: models },
    [{ instanceId: "openai", model: "kept" }], (driver) => driver.toUpperCase());
  expect(targets.map((target) => `${target.provider}/${target.model}`)).toEqual(["codex/m", "openai/gpt-4o", "openai/o3-mini", "openai/kept"]);
  expect(targets[1]?.label).toBe("OpenAI: GPT 4o");
  expect(targets[1]?.driver).toBe("openai");
});
