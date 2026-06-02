import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export async function extractPageModels(pdfPath, pageNumber, scale = 1.15) {
  const document = await loadPdf(pdfPath);
  const current = await buildPageTextModel(document, pageNumber, scale);
  const previous = pageNumber > 1 ? await buildPageTextModel(document, pageNumber - 1, scale) : null;
  const next = pageNumber < document.numPages ? await buildPageTextModel(document, pageNumber + 1, scale) : null;
  await document.destroy();
  return { current, previous, next, pageCount: document.numPages };
}

export async function getPdfPageCount(pdfPath) {
  const document = await loadPdf(pdfPath);
  const pageCount = document.numPages;
  await document.destroy();
  return pageCount;
}

export function getLayoutFragments(model) {
  return model.spans.map((span) => ({
    fragmentId: span.id,
    lineId: span.line,
    text: span.text,
    bbox: {
      left: round(span.left),
      top: round(span.top),
      width: round(span.width),
      height: round(span.height)
    },
    column: span.column
  }));
}

async function loadPdf(pdfPath) {
  const task = pdfjsLib.getDocument({
    url: pdfPath,
    disableWorker: true,
    useSystemFonts: true
  });
  return task.promise;
}

async function buildPageTextModel(document, pageNumber, scale) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const textContent = await page.getTextContent();
  return buildTextModel(textContent.items, viewport);
}

function buildTextModel(items, viewport) {
  const spans = [];
  items.forEach((item, index) => {
    if (!item.str?.trim()) return;
    const tx = multiplyTransform(viewport.transform, item.transform);
    const viewportScale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
    const left = tx[4];
    const top = tx[5] - Math.abs(tx[3]);
    const height = Math.max(Math.abs(tx[3]), item.height || 12);
    const width = Math.max(item.width * viewportScale, item.str.length * height * 0.42);
    spans.push({
      id: `f-${index}`,
      text: item.str,
      left,
      top,
      width,
      height,
      fontHeight: height
    });
  });

  const visualLines = buildVisualLines(spans, viewport.width);
  let text = "";
  const modelSpans = [];
  visualLines.forEach((lineInfo, lineIndex) => {
    const previousLine = visualLines[lineIndex - 1];
    const sameParagraph = previousLine && previousLine.paragraph === lineInfo.paragraph;
    text += text.length === 0 ? "" : sameParagraph ? "\n" : "\n\n";
    lineInfo.spans.forEach((span, spanIndex) => {
      const separator = spanIndex === 0 ? "" : " ";
      const start = text.length + separator.length;
      text += separator + span.text;
      modelSpans.push({
        id: span.id,
        text: span.text,
        left: span.left,
        top: span.top,
        width: span.width,
        height: span.height,
        start,
        end: text.length,
        line: lineInfo.line,
        column: lineInfo.column,
        paragraph: lineInfo.paragraph
      });
    });
  });
  return { text, spans: modelSpans };
}

function buildVisualLines(spans, pageWidth) {
  const sortedSpans = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  const typicalHeight = median(sortedSpans.map((span) => span.fontHeight)) || 12;
  const columnBoundary = findColumnBoundary(sortedSpans, pageWidth);
  const lineBuckets = [];

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
    if (bucket) bucket.push(span);
    else lineBuckets.push([span]);
  });

  const orderedLines = lineBuckets
    .map((lineSpans) => {
      const sorted = [...lineSpans].sort((a, b) => a.left - b.left);
      const left = Math.min(...lineSpans.map((span) => span.left));
      return {
        line: 0,
        column: columnBoundary != null && left >= columnBoundary ? 1 : 0,
        paragraph: 0,
        top: Math.min(...lineSpans.map((span) => span.top)),
        left,
        height: median(lineSpans.map((span) => span.fontHeight)) || 12,
        text: sorted.map((span) => span.text).join(" ").trim(),
        spans: sorted
      };
    })
    .sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left)
    .map((line, index) => ({ ...line, line: index }));

  const typicalLineGap =
    median(
      orderedLines
        .slice(1)
        .map((line, index) => {
          const previous = orderedLines[index];
          return line.column === previous.column ? line.top - previous.top : 0;
        })
        .filter((gap) => gap > 1 && gap < 40)
    ) || typicalHeight;

  let paragraph = 0;
  orderedLines.forEach((line, index) => {
    const previous = orderedLines[index - 1];
    if (previous) {
      const changedColumn = line.column !== previous.column;
      const gap = line.top - previous.top;
      const startsIndented = line.left > previous.left + Math.max(6, typicalHeight * 0.65);
      const hasBlankLineGap = gap > Math.max(typicalLineGap * 1.1, typicalHeight * 1.2);
      if (changedColumn || startsIndented || hasBlankLineGap || isFloatBoundary(line.text) || isFloatBoundary(previous.text)) {
        paragraph += 1;
      }
    }
    line.paragraph = paragraph;
  });

  return orderedLines;
}

function findColumnBoundary(spans, pageWidth) {
  const clusters = [];
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

  const frequentStarts = clusters.filter((cluster) => cluster.count >= 6).sort((a, b) => a.left - b.left);
  const first = frequentStarts[0];
  const second = frequentStarts.find((cluster) => first && cluster.left - first.left > Math.max(80, pageWidth * 0.13));
  if (!first || !second) return null;
  return second.left - 12;
}

function isFloatBoundary(text) {
  return /^(fig\.?|figure|table|tab\.?)\s*\d+/i.test(text.trim());
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function multiplyTransform(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

function round(value) {
  return Math.round(value * 10) / 10;
}
