import type { SelectionMode } from "../types";

export type TextSpan = {
  id: string;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  start: number;
  end: number;
  paragraph: number;
  line: number;
  column: number;
};

export type PageTextModel = {
  text: string;
  spans: TextSpan[];
};

export type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SelectionTarget = {
  id: string;
  text: string;
  start: number;
  end: number;
  rects: SelectionRect[];
  spanIds?: string[];
};

export type LayoutItem = {
  id?: string;
  type: string;
  fragmentIds?: string[];
  lineIds?: number[];
  text?: string;
};

export type LayoutFragment = {
  fragmentId: string;
  lineId: number;
  text: string;
  bbox: SelectionRect;
  column: number;
};

type RawTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

export function buildPageTextModel(items: RawTextItem[], viewport: { transform: number[] }): PageTextModel {
  type PositionedSpan = Omit<TextSpan, "start" | "end" | "paragraph" | "line" | "column"> & {
    fontHeight: number;
  };
  type VisualLine = {
    line: number;
    column: number;
    top: number;
    left: number;
    right: number;
    height: number;
    text: string;
    spans: PositionedSpan[];
  };

  const positionedSpans: PositionedSpan[] = [];
  let text = "";

  items.forEach((item, index) => {
    if (!item.str.trim()) return;
    const tx = multiplyTransform(viewport.transform, item.transform);
    const viewportScale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
    const left = tx[4];
    const top = tx[5] - Math.abs(tx[3]);
    const height = Math.max(Math.abs(tx[3]), item.height || 12);
    const width = Math.max(item.width * viewportScale, item.str.length * height * 0.42);

    positionedSpans.push({
      id: `f-${index}`,
      text: item.str,
      left,
      top,
      width,
      height,
      fontHeight: height
    });
  });

  const visualLines = buildVisualLines(positionedSpans, viewport.width);
  const typicalLineGap = median(
    visualLines
      .slice(1)
      .map((current, index) => {
        const previous = visualLines[index];
        return current.column === previous.column ? current.top - previous.top : 0;
      })
      .filter((gap) => gap > 1 && gap < 40)
  );
  const typicalHeight = median(visualLines.map((current) => current.height)) || 12;
  const columnLeft = new Map<number, number>();
  for (const line of visualLines) {
    const current = columnLeft.get(line.column);
    if (current == null || line.left < current) columnLeft.set(line.column, line.left);
  }

  let paragraph = 0;
  const paragraphByLine = new Map<number, number>();

  visualLines.forEach((current, index) => {
    const previous = visualLines[index - 1];
    if (previous) {
      const gap = current.top - previous.top;
      const startsIndented = current.left > previous.left + Math.max(6, typicalHeight * 0.65);
      const changedColumn = current.column !== previous.column;
      const hasBlankLineGap = gap > Math.max(typicalLineGap * 1.1, typicalHeight * 1.2);
      const looksLikeBoundary =
        isSectionHeading(current.text) ||
        isSectionHeading(previous.text) ||
        isFloatBoundary(current.text) ||
        isFloatBoundary(previous.text);
      if (changedColumn || hasBlankLineGap || startsIndented || looksLikeBoundary) {
        paragraph += 1;
      }
    }
    paragraphByLine.set(current.line, paragraph);
  });

  const spans: TextSpan[] = [];
  visualLines.forEach((lineInfo, lineIndex) => {
    const previousLine = visualLines[lineIndex - 1];
    const sameParagraph =
      previousLine && paragraphByLine.get(previousLine.line) === paragraphByLine.get(lineInfo.line);
    const lineSeparator = text.length === 0 ? "" : sameParagraph ? "\n" : "\n\n";
    text += lineSeparator;

    lineInfo.spans.forEach((span, spanIndex) => {
      const separator = spanIndex === 0 ? "" : " ";
      const start = text.length + separator.length;
      text += separator + span.text;
      const end = text.length;
      spans.push({
        id: span.id,
        text: span.text,
        left: span.left,
        top: span.top,
        width: span.width,
        height: span.height,
        start,
        end,
        line: lineInfo.line,
        column: lineInfo.column,
        paragraph: paragraphByLine.get(lineInfo.line) || 0
      });
    });
  });

  return { text, spans };
}

export function getLayoutFragments(model: PageTextModel): LayoutFragment[] {
  return model.spans.map((span) => ({
    fragmentId: span.id,
    lineId: span.line,
    text: span.text,
    bbox: {
      left: Math.round(span.left * 10) / 10,
      top: Math.round(span.top * 10) / 10,
      width: Math.round(span.width * 10) / 10,
      height: Math.round(span.height * 10) / 10
    },
    column: span.column
  }));
}

export function getSelectionTargets(
  model: PageTextModel,
  mode: SelectionMode,
  layoutItems: LayoutItem[] | null = null
): SelectionTarget[] {
  if (layoutItems?.length) {
    return layoutSelectionTargets(model, mode, layoutItems);
  }

  if (mode === "paragraph") {
    return paragraphRanges(model)
      .map((range, index) => targetFromRange(model, `paragraph-${index}`, range.start, range.end))
      .filter(isUsefulTarget);
  }

  return paragraphRanges(model)
    .flatMap((range, paragraphIndex) =>
      sentenceBoundaries(model.text.slice(range.start, range.end)).map((boundary, sentenceIndex) =>
        targetFromRange(model, `sentence-${paragraphIndex}-${sentenceIndex}`, range.start + boundary.start, range.start + boundary.end)
      )
    )
    .filter(isUsefulTarget);
}

export function isHighlighted(span: TextSpan, target: SelectionTarget | null) {
  if (!target) return false;
  if (target.spanIds) return target.spanIds.includes(span.id);
  return span.start < target.end && span.end > target.start;
}

function sentenceBoundaries(text: string) {
  const boundaries: Array<{ start: number; end: number }> = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!".!?。！？".includes(char)) continue;
    if (!isSentenceBreak(text, index)) continue;

    const end = consumeClosingMarks(text, index + 1);
    boundaries.push({ start, end });
    start = consumeWhitespace(text, end);
  }

  if (start < text.length) {
    boundaries.push({ start, end: text.length });
  }

  return boundaries;
}

function normalizeSelection(text: string) {
  return text
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function targetFromRange(
  model: PageTextModel,
  id: string,
  start: number,
  end: number,
  textOverride?: string
): SelectionTarget {
  return {
    id,
    start,
    end,
    text: normalizeSelection(textOverride || model.text.slice(start, end)),
    rects: rectsForRange(model.spans, start, end),
    spanIds: model.spans.filter((span) => span.start < end && span.end > start).map((span) => span.id)
  };
}

function layoutSelectionTargets(model: PageTextModel, mode: SelectionMode, layoutItems: LayoutItem[]) {
  const items = layoutItems
    .filter(isSelectableLayoutItem)
    .map((item, index) => ({ ...item, id: item.id || `layout-${index}` }));

  if (mode === "paragraph") {
    return items
      .map((item) => targetFromLayoutItem(model, item.id!, item, item.text))
      .filter(isUsefulTarget);
  }

  return items
    .flatMap((item) => {
      const range = rangeFromLayoutItem(model, item);
      if (!range) return [];
      if (isAtomicLayoutItem(item)) {
        return [targetFromLayoutItem(model, item.id!, item, item.text)];
      }
      return sentenceBoundaries(model.text.slice(range.start, range.end)).map((boundary, index) =>
        targetFromRange(
          model,
          `${item.id}-sentence-${index}`,
          range.start + boundary.start,
          range.start + boundary.end
        )
      );
    })
    .filter(isUsefulTarget);
}

function targetFromLayoutItem(model: PageTextModel, id: string, item: LayoutItem, textOverride?: string) {
  const spans = spansFromLayoutItem(model, item);
  if (spans.length === 0) return { id, start: 0, end: 0, text: "", rects: [], spanIds: [] };
  const start = Math.min(...spans.map((span) => span.start));
  const end = Math.max(...spans.map((span) => span.end));
  return {
    id,
    start,
    end,
    text: normalizeSelection(textOverride || spans.map((span) => span.text).join(" ")),
    rects: rectsForSpans(spans),
    spanIds: spans.map((span) => span.id)
  };
}

function rangeFromLayoutItem(model: PageTextModel, item: LayoutItem) {
  const spans = spansFromLayoutItem(model, item);
  if (spans.length === 0) return null;
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end))
  };
}

function spansFromLayoutItem(model: PageTextModel, item: LayoutItem) {
  const fragmentIds = new Set(item.fragmentIds || []);
  const lineIds = new Set(item.lineIds || []);
  return model.spans.filter((span) =>
    fragmentIds.size > 0 ? fragmentIds.has(span.id) : lineIds.has(span.line)
  );
}

function isSelectableLayoutItem(item: LayoutItem) {
  return !["header", "footer", "figure_label", "other"].includes(item.type);
}

function isAtomicLayoutItem(item: LayoutItem) {
  return ["table", "formula", "reference"].includes(item.type);
}

function paragraphRanges(model: PageTextModel) {
  const paragraphIds = Array.from(new Set(model.spans.map((span) => span.paragraph)));
  return paragraphIds.flatMap((paragraphId) => {
    const paragraphSpans = model.spans.filter((span) => span.paragraph === paragraphId);
    return splitSpatialRuns(paragraphSpans).map((run) => ({
      start: run[0]?.start || 0,
      end: run.at(-1)?.end || 0
    }));
  });
}

function splitSpatialRuns(spans: TextSpan[]) {
  const lines = lineGroups(spans);
  const runs: TextSpan[][] = [];
  let current: TextSpan[] = [];

  lines.forEach((line, index) => {
    const previous = lines[index - 1];
    const changedColumn = previous && line.column !== previous.column;
    const movedFarDown = previous && line.top - previous.top > Math.max(previous.height * 2.2, 28);
    const jumpedLeftRight = previous && Math.abs(line.left - previous.left) > Math.max(previous.width * 0.65, 90);
    const startsFloat = isFloatBoundary(line.text);
    if (current.length > 0 && (changedColumn || movedFarDown || jumpedLeftRight || startsFloat)) {
      runs.push(current);
      current = [];
    }
    current.push(...line.spans);
  });

  if (current.length > 0) runs.push(current);
  return runs;
}

function lineGroups(spans: TextSpan[]) {
  const byLine = new Map<number, TextSpan[]>();
  spans.forEach((span) => {
    const lineSpans = byLine.get(span.line) || [];
    lineSpans.push(span);
    byLine.set(span.line, lineSpans);
  });

  return Array.from(byLine.values()).map((lineSpans) => {
    const sorted = [...lineSpans].sort((a, b) => a.left - b.left);
    const left = Math.min(...lineSpans.map((span) => span.left));
    const top = Math.min(...lineSpans.map((span) => span.top));
    const right = Math.max(...lineSpans.map((span) => span.left + span.width));
    const bottom = Math.max(...lineSpans.map((span) => span.top + span.height));
    return {
      line: sorted[0]?.line || 0,
      spans: sorted,
      text: sorted.map((span) => span.text).join(" "),
      left,
      top,
      width: right - left,
      height: bottom - top,
      column: sorted[0]?.column || 0
    };
  });
}

function isUsefulTarget(target: SelectionTarget) {
  return target.text.length > 0 && target.rects.length > 0 && target.text.replace(/\W/g, "").length > 1;
}

function rectsForRange(spans: TextSpan[], start: number, end: number) {
  return rectsForSpans(spans.filter((span) => span.start < end && span.end > start));
}

function rectsForSpans(spans: TextSpan[]) {
  const byLine = new Map<number, TextSpan[]>();
  spans.forEach((span) => {
    const lineSpans = byLine.get(span.line) || [];
    lineSpans.push(span);
    byLine.set(span.line, lineSpans);
  });

  return Array.from(byLine.values()).map((lineSpans) => {
    const left = Math.min(...lineSpans.map((span) => span.left));
    const top = Math.min(...lineSpans.map((span) => span.top));
    const right = Math.max(...lineSpans.map((span) => span.left + span.width));
    const bottom = Math.max(...lineSpans.map((span) => span.top + span.height));
    return {
      left,
      top,
      width: right - left,
      height: bottom - top
    };
  });
}

function isSentenceBreak(text: string, index: number) {
  const char = text[index];
  if ("。！？!?".includes(char)) return true;

  const before = text.slice(Math.max(0, index - 28), index + 1);
  const after = text.slice(index + 1, Math.min(text.length, index + 12));
  const previous = text[index - 1] || "";
  const next = text[index + 1] || "";
  if (/\d/.test(previous) && /\d/.test(next)) return false;
  if (/[a-z]/.test(next)) return false;
  if (/(\b(?:et al|fig|eq|e\.g|i\.e|ref|refs|sec|vol|no|vs|dr|mr|mrs|ms|prof|inc|ltd))\.$/i.test(before)) {
    return false;
  }
  if (/[A-Z]\.$/.test(before) && /\s*[A-Z]\./.test(after)) return false;
  if (/^\s*[,;:\])}]/.test(after)) return false;

  const nextWord = after.match(/^\s+([A-Za-z])/);
  if (nextWord && nextWord[1] === nextWord[1].toLowerCase()) return false;
  return true;
}

function consumeClosingMarks(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /["'”’)\]}]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function consumeWhitespace(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function buildVisualLines(
  spans: Array<Omit<TextSpan, "start" | "end" | "paragraph" | "line" | "column"> & { fontHeight: number }>,
  pageWidth: number
) {
  const sortedSpans = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  const typicalHeight = median(sortedSpans.map((span) => span.fontHeight)) || 12;
  const columnBoundary = findColumnBoundary(sortedSpans, pageWidth);
  const lineBuckets: Array<Array<(typeof sortedSpans)[number]>> = [];

  sortedSpans.forEach((span) => {
    const spanColumn = columnBoundary != null && span.left >= columnBoundary ? 1 : 0;
    const bucket = lineBuckets.find((line) => {
      const top = median(line.map((item) => item.top));
      const right = Math.max(...line.map((item) => item.left + item.width));
      const lineColumn = columnBoundary != null && Math.min(...line.map((item) => item.left)) >= columnBoundary ? 1 : 0;
      const sameBaseline = Math.abs(span.top - top) <= Math.max(typicalHeight * 0.45, 3);
      const sameTextRun = span.left <= right + Math.max(typicalHeight * 6, 48);
      return spanColumn === lineColumn && sameBaseline && sameTextRun;
    });
    if (bucket) {
      bucket.push(span);
    } else {
      lineBuckets.push([span]);
    }
  });

  const provisionalLines = lineBuckets.map((lineSpans) => {
    const sorted = [...lineSpans].sort((a, b) => a.left - b.left);
    return {
      line: 0,
      column: 0,
      top: Math.min(...lineSpans.map((span) => span.top)),
      left: Math.min(...lineSpans.map((span) => span.left)),
      right: Math.max(...lineSpans.map((span) => span.left + span.width)),
      height: median(lineSpans.map((span) => span.fontHeight)) || 12,
      text: sorted.map((span) => span.text).join(" ").trim(),
      spans: sorted
    };
  });

  const orderedLines = provisionalLines
    .map((line) => ({
      ...line,
      column: columnBoundary != null && line.left >= columnBoundary ? 1 : 0
    }))
    .sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left);

  return orderedLines.map((line, index) => ({ ...line, line: index }));
}

function findColumnBoundary(
  spans: Array<Omit<TextSpan, "start" | "end" | "paragraph" | "line" | "column"> & { fontHeight: number }>,
  pageWidth: number
) {
  const clusters: Array<{ left: number; count: number }> = [];
  spans
    .filter((span) => span.text.trim().length >= 8)
    .forEach((span) => {
      const cluster = clusters.find((item) => Math.abs(item.left - span.left) <= 8);
      if (cluster) {
        cluster.left = (cluster.left * cluster.count + span.left) / (cluster.count + 1);
        cluster.count += 1;
      } else {
        clusters.push({ left: span.left, count: 1 });
      }
    });

  const frequentStarts = clusters
    .filter((cluster) => cluster.count >= 6)
    .sort((a, b) => a.left - b.left);
  const first = frequentStarts[0];
  const second = frequentStarts.find((cluster) => first && cluster.left - first.left > Math.max(80, pageWidth * 0.13));
  if (!first || !second) return null;
  return second.left - 12;
}

function isSectionHeading(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(\d+(\.\d+)*\.?|[A-Z]\.)\s+[A-Z]/.test(trimmed)) return true;
  if (/^(abstract|introduction|materials and methods|methods|results|discussion|conclusion|references)$/i.test(trimmed)) {
    return true;
  }
  return trimmed.length < 60 && trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed);
}

function isFloatBoundary(text: string) {
  return /^(fig\.?|figure|table|tab\.?)\s*\d+/i.test(text.trim());
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function multiplyTransform(a: number[], b: number[]) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
