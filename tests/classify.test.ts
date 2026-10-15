import { describe, expect, it } from "vitest";
import { extractClassifications } from "../src/llm/classify.js";

describe("extractClassifications", () => {
  it("parses a bare JSON array", () => {
    const items = extractClassifications(
      '[{"full_name":"a/b","category":"AI/LLM","summary":"示例"}]',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.full_name).toBe("a/b");
  });

  it("unwraps a fenced JSON block", () => {
    const items = extractClassifications(
      '好的，结果如下：\n```json\n[{"full_name":"a/b","category":"前端","summary":"x"}]\n```\n',
    );
    expect(items.map((i) => i.full_name)).toEqual(["a/b"]);
  });

  it("accepts an object wrapper such as items/results/data", () => {
    const asItems = extractClassifications(
      '{"items":[{"full_name":"a/b","category":"安全","summary":"x"}]}',
    );
    const asData = extractClassifications(
      '{"data":[{"full_name":"c/d","category":"安全","summary":"y"}]}',
    );
    expect(asItems).toHaveLength(1);
    expect(asData[0]?.full_name).toBe("c/d");
  });

  it("recovers when the model adds prose around the payload", () => {
    const items = extractClassifications(
      '分类结果：[{"full_name":"a/b","category":"开发工具","summary":"x"}] 以上共 1 条。',
    );
    expect(items).toHaveLength(1);
  });

  it("drops malformed entries instead of failing the whole batch", () => {
    const items = extractClassifications(
      '[{"full_name":"a/b","category":"前端","summary":"x"},{"full_name":"c/d"},{"category":"前端"}]',
    );
    expect(items.map((i) => i.full_name)).toEqual(["a/b"]);
  });

  it("returns an empty list for unparseable replies", () => {
    expect(extractClassifications("抱歉，我无法完成该任务。")).toEqual([]);
    expect(extractClassifications("")).toEqual([]);
    expect(extractClassifications("{不是合法的 JSON")).toEqual([]);
  });
});
