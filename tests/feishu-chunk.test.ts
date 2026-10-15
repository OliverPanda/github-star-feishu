import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CHUNK_BYTES, chunkMarkdown } from "../src/feishu/chunk.js";

/** Rebuild a document from its chunks the way the writer stitches them. */
function reassemble(chunks: string[]): string {
  return chunks.join("\n\n");
}

describe("chunkMarkdown", () => {
  it("returns a small document untouched", () => {
    const markdown = "# 标题\n\n正文";
    expect(chunkMarkdown(markdown)).toEqual([markdown]);
  });

  it("keeps every chunk within the byte budget", () => {
    // Paragraphs of mixed CJK and ASCII, the shape a rendered star list has.
    const rows = Array.from({ length: 20 }, () => "| a/b | 中文描述 |");
    const block = ["## 分类", "", "| 仓库 | 说明 |", "| --- | --- |", ...rows].join("\n");
    const markdown = Array.from({ length: 60 }, () => block).join("\n\n");

    const chunks = chunkMarkdown(markdown, { maxBytes: 4096 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(4096);
    }
    expect(reassemble(chunks)).toBe(markdown);
  });

  it("repeats the header when a single table is cut, so no rows are orphaned", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| owner/repo-${i} | 描述 ${i} |`).join("\n");
    const markdown = `| 仓库 | 说明 |\n| --- | --- |\n${rows}`;

    const chunks = chunkMarkdown(markdown, { maxBytes: 2048 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("| 仓库 | 说明 |\n| --- | --- |\n")).toBe(true);
    }
    // Every row survives exactly once, header rows excluded.
    const dataRows = chunks.flatMap((chunk) => chunk.split("\n").slice(2));
    expect(dataRows).toEqual(rows.split("\n"));
  });

  it("cuts a paragraph that has no block boundary to split on", () => {
    // No blank lines, no table: the only usable boundary is a line break.
    const markdown = Array.from({ length: 400 }, (_, i) => `第 ${i} 行内容`).join("\n");

    const chunks = chunkMarkdown(markdown, { maxBytes: 512 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(512);
    }
    // Cutting inside a block costs a blank line at the seam, so the text is
    // compared line by line rather than byte for byte. No line may be lost.
    const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);
    expect(lines(reassemble(chunks))).toEqual(lines(markdown));
  });

  it("uses a budget that leaves room under the CLI deadline", () => {
    // 50KB already took ~12s of the 30s deadline, so the default must stay well
    // below it; this guards against someone raising it to the observed ceiling.
    expect(DEFAULT_MAX_CHUNK_BYTES).toBeLessThanOrEqual(32 * 1024);
  });
});
