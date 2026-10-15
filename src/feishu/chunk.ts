/**
 * Split a rendered Markdown document into request-sized pieces.
 *
 * `feishu-cli doc content-update` pushes the whole payload in a single request
 * and gives up after 30 seconds (`context deadline exceeded`). The cost grows
 * with the payload — 25KB lands in about 6 seconds, while a 250KB page never
 * finishes — so a prolific account (antfu has 1751 stars) cannot be written in
 * one shot. Sending the page as several smaller writes keeps every request
 * comfortably inside the deadline.
 *
 * Splitting happens on block boundaries so the Markdown stays valid, and a
 * table that is too large to fit is cut by rows with its header repeated,
 * because a table continued without headers would render as garbage.
 */

/**
 * Byte budget per request. Well under the ~50KB payload that still completed
 * in about 12 seconds, leaving room for a slow connection without approaching
 * the 30 second deadline.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 32 * 1024;

export interface ChunkOptions {
  /** Maximum UTF-8 size of one chunk. Defaults to `DEFAULT_MAX_CHUNK_BYTES`. */
  maxBytes?: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** True when the block is a Markdown table (a header row plus `| --- |`). */
function isTable(block: string): boolean {
  const lines = block.split("\n");
  return lines.length >= 2 && lines[0]!.trimStart().startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[1]!.trim());
}

/**
 * Cut one oversized table into several tables that each repeat the header.
 *
 * The header and separator are re-emitted per piece, so every fragment stands
 * on its own instead of orphaning rows under a missing header.
 */
function splitTable(block: string, maxBytes: number): string[] {
  const lines = block.split("\n");
  const header = lines.slice(0, 2);
  const headerBytes = byteLength(`${header.join("\n")}\n`);
  const pieces: string[] = [];

  let current: string[] = [];
  let currentBytes = headerBytes;

  for (const row of lines.slice(2)) {
    const rowBytes = byteLength(`${row}\n`);
    // A single row can never fit when the header alone is oversized; flushing
    // first still guarantees progress and keeps that row in its own piece.
    if (current.length && currentBytes + rowBytes > maxBytes) {
      pieces.push([...header, ...current].join("\n"));
      current = [];
      currentBytes = headerBytes;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) pieces.push([...header, ...current].join("\n"));
  return pieces;
}

/**
 * Split a block that is neither packable nor a table, such as one very long
 * paragraph. Lines are the safest boundary available, so the block is cut
 * there and only a single oversized line is split mid-text.
 */
function splitLines(block: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length) pieces.push(current.join("\n"));
    current = [];
    currentBytes = 0;
  };

  for (const line of block.split("\n")) {
    const lineBytes = byteLength(`${line}\n`);
    if (lineBytes > maxBytes) {
      flush();
      // The line has no boundary left to use, so it is measured one character
      // at a time; CJK characters cost three bytes each, which a divisor based
      // on the average would overshoot.
      let start = 0;
      while (start < line.length) {
        let end = start;
        let bytes = 0;
        while (end < line.length && bytes + byteLength(line[end]!) <= maxBytes) {
          bytes += byteLength(line[end]!);
          end += 1;
        }
        // A budget too small for even one character still has to advance.
        if (end === start) end = start + 1;
        pieces.push(line.slice(start, end));
        start = end;
      }
      continue;
    }
    if (current.length && currentBytes + lineBytes > maxBytes) flush();
    current.push(line);
    currentBytes += lineBytes;
  }
  flush();
  return pieces;
}

/** Break an oversized block down to pieces that fit the budget. */
function splitBlock(block: string, maxBytes: number): string[] {
  return isTable(block) ? splitTable(block, maxBytes) : splitLines(block, maxBytes);
}

/**
 * Split a document into chunks that each stay within the byte budget.
 *
 * Blank lines separate blocks; blocks are then packed greedily so the number
 * of requests stays as small as possible. Block boundaries are preserved, so
 * joining the chunks with a blank line reproduces the document; a block that
 * had to be cut mid-way rejoins at its own line breaks, which reads as a
 * paragraph split rather than a lost line.
 */
export function chunkMarkdown(markdown: string, options: ChunkOptions = {}): string[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  if (byteLength(markdown) <= maxBytes) return [markdown];

  const blocks = markdown.split(/\n{2,}/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length) chunks.push(current.join("\n\n"));
    current = [];
    currentBytes = 0;
  };

  for (const block of blocks) {
    const blockBytes = byteLength(block);
    if (blockBytes > maxBytes) {
      flush();
      const pieces = splitBlock(block, maxBytes);
      // Every piece but the last is known to be at the budget, so it is pushed
      // directly rather than being packed with whatever follows.
      for (const piece of pieces.slice(0, -1)) chunks.push(piece);
      const last = pieces[pieces.length - 1]!;
      current = [last];
      currentBytes = byteLength(last) + 2;
      continue;
    }
    if (current.length && currentBytes + blockBytes + 2 > maxBytes) flush();
    current.push(block);
    currentBytes += blockBytes + 2;
  }
  flush();
  return chunks;
}
