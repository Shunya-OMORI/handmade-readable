import fs from "node:fs/promises";
import path from "node:path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

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

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function buildModel(items, viewport) {
  const positionedSpans = [];

  items.forEach((item, index) => {
    if (!item.str.trim()) return;
    const tx = multiplyTransform(viewport.transform, item.transform);
    const viewportScale = Math.hypot(viewport.transform[0], viewport.transform[1]) || 1;
    const left = tx[4];
    const top = tx[5] - Math.abs(tx[3]);
    const height = Math.max(Math.abs(tx[3]), item.height || 12);
    const width = Math.max(item.width * viewportScale, item.str.length * height * 0.42);

    positionedSpans.push({ index, text: item.str, left, top, width, height, fontHeight: height });
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
  const columnLeft = new Map();
  for (const line of visualLines) {
    const current = columnLeft.get(line.column);
    if (current == null || line.left < current) columnLeft.set(line.column, line.left);
  }
  let paragraph = 0;
  const paragraphByLine = new Map();

  visualLines.forEach((current, index) => {
    const previous = visualLines[index - 1];
    if (previous) {
      const gap = current.top - previous.top;
      const startsIndented = current.left > previous.left + Math.max(6, typicalHeight * 0.65);
      const changedColumn = current.column !== previous.column;
      const hasBlankLineGap = gap > Math.max(typicalLineGap * 1.1, typicalHeight * 1.2);
      const looksLikeNewSection = isSectionHeading(current.text) || isSectionHeading(previous.text);
      if (changedColumn || hasBlankLineGap || startsIndented || looksLikeNewSection) paragraph += 1;
    }
    paragraphByLine.set(current.line, paragraph);
  });

  return { draftSpans: positionedSpans, lineStats: visualLines, paragraphByLine, typicalLineGap, typicalHeight };
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

  const provisionalLines = lineBuckets.map((lineSpans) => {
    const sorted = [...lineSpans].sort((a, b) => a.left - b.left);
    return {
      line: 0,
      column: 0,
      top: Math.min(...lineSpans.map((span) => span.top)),
      left: Math.min(...lineSpans.map((span) => span.left)),
      right: Math.max(...lineSpans.map((span) => span.left + span.width)),
      height: median(lineSpans.map((span) => span.height)) || 12,
      text: sorted.map((span) => span.text).join(" ").trim(),
      spans: sorted
    };
  });

  return provisionalLines
    .map((line) => ({ ...line, column: columnBoundary != null && line.left >= columnBoundary ? 1 : 0 }))
    .sort((a, b) => a.column - b.column || a.top - b.top || a.left - b.left)
    .map((line, index) => ({ ...line, line: index }));
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

function isSectionHeading(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(\d+(\.\d+)*\.?|[A-Z]\.)\s+[A-Z]/.test(trimmed)) return true;
  if (/^(abstract|introduction|materials and methods|methods|results|discussion|conclusion|references)$/i.test(trimmed)) return true;
  return trimmed.length < 60 && trimmed === trimmed.toUpperCase() && /[A-Z]{3,}/.test(trimmed);
}

const requested = process.argv.slice(2);
const allFiles = (await fs.readdir("papers")).filter((file) => file.toLowerCase().endsWith(".pdf"));
const files = requested.length > 0 ? requested : allFiles;

for (const file of files) {
  const data = new Uint8Array(await fs.readFile(path.join("papers", file)));
  const document = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;

  for (const pageNumber of [1, Math.min(2, document.numPages)]) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const nonEmptyItems = textContent.items.filter((item) => item.str.trim());
    const model = buildModel(textContent.items, viewport);

    console.log(`\n=== ${file} / page ${pageNumber} ===`);
    console.log(`pages=${document.numPages} rawItems=${textContent.items.length} nonEmpty=${nonEmptyItems.length}`);
    console.log(`typicalLineGap=${model.typicalLineGap.toFixed(2)} typicalHeight=${model.typicalHeight.toFixed(2)}`);
    console.log("\n-- raw items --");
    for (const item of model.draftSpans.slice(0, 35)) {
      console.log(
        `${String(item.index).padStart(3)} line=${String(item.line).padStart(2)} x=${item.left
          .toFixed(1)
          .padStart(6)} top=${item.top.toFixed(1).padStart(6)} h=${item.height
          .toFixed(1)
          .padStart(4)} text=${JSON.stringify(item.text.slice(0, 110))}`
      );
    }

    console.log("\n-- parsed lines --");
    for (const line of model.lineStats.slice(0, 35)) {
      const paragraph = model.paragraphByLine.get(line.line);
      console.log(
        `p=${String(paragraph).padStart(2)} line=${String(line.line).padStart(2)} top=${line.top
          .toFixed(1)
          .padStart(6)} x=${line.left.toFixed(1).padStart(6)} text=${JSON.stringify(line.text.slice(0, 140))}`
      );
    }
  }
}
