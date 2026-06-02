import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { LlmPriorityQueue } from "./llmQueue.mjs";
import { extractPageModels, getLayoutFragments, getPdfPageCount } from "./pdfText.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const papersDir = path.join(root, "papers");
const dataDir = path.join(root, "data");
const layoutsDir = path.join(dataDir, "layouts");
const metadataPath = path.join(dataDir, "metadata.json");
const readingLogPath = path.join(dataDir, "reading-log.jsonl");
const defaultModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const metadataModel = process.env.GEMINI_METADATA_MODEL || process.env.GEMINI_HEAVY_MODEL || defaultModel;
const explainModel = process.env.GEMINI_EXPLAIN_MODEL || defaultModel;
const layoutModel = process.env.GEMINI_LAYOUT_MODEL || defaultModel;
const layoutSchemaVersion = 3;
const layoutMinIntervalMs = Number(process.env.GEMINI_LAYOUT_MIN_INTERVAL_MS || 7000);
const metadataTimeoutMs = Number(process.env.GEMINI_METADATA_TIMEOUT_MS || 300000);
const layoutTimeoutMs = Number(process.env.GEMINI_LAYOUT_TIMEOUT_MS || 180000);
const explainTimeoutMs = Number(process.env.GEMINI_EXPLAIN_TIMEOUT_MS || 90000);
const explainMaxChars = Number(process.env.GEMINI_EXPLAIN_MAX_CHARS || 12000);
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--production");

const app = express();
app.use(express.json({ limit: "24mb" }));

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(layoutsDir, { recursive: true });
  if (!existsSync(metadataPath)) {
    await fs.writeFile(metadataPath, JSON.stringify({ papers: {} }, null, 2), "utf8");
  }
}

async function readMetadata() {
  await ensureDataDir();
  return JSON.parse(await fs.readFile(metadataPath, "utf8"));
}

async function writeMetadata(metadata) {
  await ensureDataDir();
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

async function listPdfFiles() {
  await fs.mkdir(papersDir, { recursive: true });
  const files = await fs.readdir(papersDir, { withFileTypes: true });
  const pdfs = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.toLowerCase().endsWith(".pdf")) continue;
    const fullPath = path.join(papersDir, file.name);
    const stat = await fs.stat(fullPath);
    const id = crypto.createHash("sha1").update(file.name).digest("hex").slice(0, 16);
    pdfs.push({ id, filename: file.name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return pdfs.sort((a, b) => a.filename.localeCompare(b.filename));
}

function safePaperPath(filename) {
  const fullPath = path.resolve(papersDir, filename);
  if (!fullPath.startsWith(papersDir + path.sep)) {
    throw new Error("Invalid paper path.");
  }
  return fullPath;
}

function getAi() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(".env に GEMINI_API_KEY がありません。");
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function jsonFromText(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : trimmed);
}

function errorMessage(error) {
  const raw = error?.message || String(error);
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || raw;
  } catch {
    return raw;
  }
}

const llmQueue = new LlmPriorityQueue({ layoutMinIntervalMs });
const layoutJobs = new Map();
const metadataJobs = new Map();
const pageCountCache = new Map();
let lastLayoutScanAt = 0;
let lastMetadataScanAt = 0;

async function withTimeout(label, ms, task) {
  let timeoutId;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pdfPartForGemini(ai, pdfPath, filename, size) {
  if (size < 18 * 1024 * 1024) {
    const data = await fs.readFile(pdfPath);
    return {
      inlineData: {
        mimeType: "application/pdf",
        data: Buffer.from(data).toString("base64")
      }
    };
  }

  const data = await fs.readFile(pdfPath);
  const file = await ai.files.upload({
    file: new Blob([data], { type: "application/pdf" }),
    config: { displayName: filename }
  });
  let current = await ai.files.get({ name: file.name });
  while (current.state === "PROCESSING") {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    current = await ai.files.get({ name: file.name });
  }
  if (current.state === "FAILED") {
    throw new Error("Gemini Files API で PDF の処理に失敗しました。");
  }
  return createPartFromUri(current.uri, current.mimeType);
}

function metadataPrompt(filename) {
  return `You are helping a Japanese researcher read an academic paper carefully.
Read the attached PDF and return strict JSON only. Do not wrap it in Markdown.

Filename: ${filename}

Schema:
{
  "title": "original title",
  "titleJa": "natural Japanese title",
  "language": "en|ja|other",
  "authors": [{"name":"", "affiliation":""}],
  "venue": "",
  "year": "",
  "fieldTags": ["short Japanese tags"],
  "summaryForContext": "Japanese summary for later context, about 900-1200 Japanese characters.",
  "readingQuestions": {
    "problem": "1-2 Japanese sentences",
    "approach": "1-2 Japanese sentences. Include prior work names and years when stated.",
    "methods": "1-2 Japanese sentences",
    "methodMeaning": "1-2 Japanese sentences",
    "results": "1-2 Japanese sentences",
    "discussion": "1-2 Japanese sentences"
  },
  "pageSummaries": [{"page": 1, "summary": "Japanese 120-220 characters"}],
  "referencesNote": "brief Japanese note about key references if identifiable"
}

Focus on how this paper differs from prior work and what a reader should watch for while reading.`;
}

function explainPrompt(body) {
  const unitLabel = body.mode === "paragraph" ? "paragraph" : "sentence";
  return `You are a careful bilingual research reading assistant for a Japanese reader.
Use the paper context and page context below, then explain the selected ${unitLabel}.
Call the model only once and do not rely on memory.

Return strict JSON only:
{
  "selectionType": "${unitLabel}",
  "isJapaneseSource": true|false,
  "translationJa": "If source is already Japanese, use an empty string.",
  "plainExplanationJa": "Detailed but readable explanation in Japanese.",
  "technicalNotesJa": ["short notes about terminology, assumptions, math, methods, or citations"],
  "readingLogHintJa": "one sentence describing what understanding this selection contributes to"
}

Paper title: ${body.paper?.title || ""}
Japanese title: ${body.paper?.titleJa || ""}
Whole-paper context:
${body.paper?.summaryForContext || ""}

Six-question map:
${JSON.stringify(body.paper?.readingQuestions || {}, null, 2)}

Current page summary:
${body.pageSummary || ""}

Selected text:
${body.text}`;
}

function layoutPath(paperId) {
  return path.join(layoutsDir, `${paperId}.json`);
}

async function readLayoutCache(paperId) {
  await ensureDataDir();
  const file = layoutPath(paperId);
  if (!existsSync(file)) return emptyLayoutStore();
  const store = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isCurrentLayoutStore(store)) {
    await fs.rm(file, { force: true });
    return emptyLayoutStore();
  }
  return store;
}

async function writeLayoutCache(paperId, cache) {
  await ensureDataDir();
  await fs.writeFile(
    layoutPath(paperId),
    JSON.stringify(
      {
        ...cache,
        schemaVersion: layoutSchemaVersion,
        updatedAt: new Date().toISOString(),
        pages: cache.pages || {}
      },
      null,
      2
    ),
    "utf8"
  );
}

function emptyLayoutStore() {
  return {
    schemaVersion: layoutSchemaVersion,
    pages: {}
  };
}

function isCurrentLayoutStore(store) {
  if (!store || store.schemaVersion !== layoutSchemaVersion || !store.pages) return false;
  return Object.values(store.pages).every((page) => page?.schemaVersion === layoutSchemaVersion);
}

function layoutPrompt(body) {
  return `You are segmenting one rendered PDF page of an academic paper for a reading UI.
You receive:
1. a page image
2. fine-grained text fragments extracted from the target PDF page, each with a stable fragmentId, lineId, text, and bounding box
3. fine-grained text fragments from the previous and next pages for continuity context

Your task:
- Group fragmentIds from the TARGET PAGE into semantic reading items.
- Do not invent fragmentIds. Use only target page fragmentIds in item.fragmentIds.
- Use previous/next page fragments only to decide whether the first or last target-page item continues a sentence or paragraph across a page boundary.
- Keep body paragraphs separate from tables, figures, captions, formulas, headers, footers, references, and metadata.
- If a visual table appears, group table cell fragments as type "table" and its title/caption as "caption".
- For tables, do not create one item spanning the whole row unless the row is visually one merged cell. Prefer one item per coherent table cell or per column value, because the UI will highlight each item.
- If a target fragment visually crosses multiple table cells or columns, do not use it for a table cell unless unavoidable; use the smaller adjacent fragments that match the cell.
- If a figure appears, group figure caption fragments as "caption"; do not merge captions into body paragraphs.
- If a PDF line visually spans columns or table cells, split it by fragmentId into the correct item.
- Never merge text across columns unless the visual page clearly shows a single full-width item.
- Mark continuations with continuation: "starts_before" | "continues_after" | "both" | "none".
- Prefer fewer, coherent body paragraphs over line-by-line fragments.
- Return strict JSON only.

Allowed item types:
"body_paragraph", "title", "author", "affiliation", "abstract", "section_heading", "caption", "table", "figure_label", "formula", "reference", "header", "footer", "other"

Schema:
{
  "items": [
    {
      "type": "body_paragraph",
      "fragmentIds": ["fragment id from target page"],
      "text": "merged visible text",
      "continuation": "none"
    }
  ]
}

Page: ${body.page}
Target page fragments:
${JSON.stringify(body.fragments)}

Previous page fragments for context:
${JSON.stringify(body.previousFragments || [])}

Next page fragments for context:
${JSON.stringify(body.nextFragments || [])}`;
}

function normalizeLayoutItems(items, validFragmentIds, validLineIds) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => ({
      id: item.id || `llm-${index}`,
      type: item.type || "other",
      fragmentIds: Array.from(new Set(Array.isArray(item.fragmentIds) ? item.fragmentIds : []))
        .map((id) => String(id))
        .filter((id) => validFragmentIds.has(id)),
      lineIds: Array.from(new Set(Array.isArray(item.lineIds) ? item.lineIds : []))
        .map((id) => Number(id))
        .filter((id) => validLineIds.has(id)),
      text: typeof item.text === "string" ? item.text : "",
      continuation: item.continuation || "none"
    }))
    .filter((item) => item.fragmentIds.length > 0 || item.lineIds.length > 0);
}

function layoutJobKey(paperId, page) {
  return `${paperId}:${page}`;
}

function publicLayoutJob(job) {
  if (!job) return null;
  return {
    paperId: job.paperId,
    page: job.page,
    status: job.status,
    error: job.error || null,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null
  };
}

function layoutJobStatus(paperId, page) {
  return publicLayoutJob(layoutJobs.get(layoutJobKey(paperId, page)));
}

function publicMetadataJob(job) {
  if (!job) return null;
  return {
    paperId: job.paperId,
    status: job.status,
    error: job.error || null,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null
  };
}

function metadataJobStatus(paperId) {
  return publicMetadataJob(metadataJobs.get(paperId));
}

async function enqueueMetadata(paperId, { force = false } = {}) {
  const pdf = (await listPdfFiles()).find((item) => item.id === paperId);
  if (!pdf) throw new Error("Paper not found.");

  const metadata = await readMetadata();
  if (!force && metadata.papers[pdf.id]) {
    return { status: "ready", metadata: metadata.papers[pdf.id] };
  }

  const existing = metadataJobs.get(paperId);
  if (existing && ["queued", "running"].includes(existing.status)) {
    return { status: existing.status, job: publicMetadataJob(existing) };
  }

  const job = {
    paperId,
    status: "queued",
    queuedAt: new Date().toISOString()
  };
  metadataJobs.set(paperId, job);

  void llmQueue
    .enqueue({
      label: `metadata ${pdf.filename}`,
      kind: "metadata",
      priority: "normal",
      task: async () => {
        job.status = "running";
        job.startedAt = new Date().toISOString();
        const ai = getAi();
        const pdfPath = safePaperPath(pdf.filename);
        const pdfPart = await pdfPartForGemini(ai, pdfPath, pdf.filename, pdf.size);
        console.log(`[metadata] paper=${paperId} model=${metadataModel}`);
        const response = await withTimeout("metadata generation", metadataTimeoutMs, () =>
          ai.models.generateContent({
            model: metadataModel,
            contents: [{ text: metadataPrompt(pdf.filename) }, pdfPart],
            config: { responseMimeType: "application/json" }
          })
        );
        const generated = jsonFromText(response.text || "{}");
        const latest = await readMetadata();
        latest.papers[pdf.id] = {
          ...generated,
          filename: pdf.filename,
          analyzedAt: new Date().toISOString(),
          model: metadataModel
        };
        await writeMetadata(latest);
        job.status = "ready";
        job.finishedAt = new Date().toISOString();
        console.log(`[metadata] completed paper=${paperId}`);
        return latest.papers[pdf.id];
      }
    })
    .catch((error) => {
      job.status = "failed";
      job.error = errorMessage(error);
      job.finishedAt = new Date().toISOString();
      console.error(`[metadata] failed paper=${paperId}: ${job.error}`);
    });

  return { status: "queued", job: publicMetadataJob(job) };
}

async function enqueueLayoutPage(paperId, page, { force = false } = {}) {
  const pdf = (await listPdfFiles()).find((item) => item.id === paperId);
  if (!pdf) throw new Error("Paper not found.");

  const cache = await readLayoutCache(paperId);
  cache.pages ||= {};
  if (!force && cache.pages[String(page)]?.schemaVersion === layoutSchemaVersion) {
    return { status: "ready", layout: cache.pages[String(page)] };
  }

  const key = layoutJobKey(paperId, page);
  const existing = layoutJobs.get(key);
  if (existing && ["queued", "running"].includes(existing.status)) {
    return { status: existing.status, job: publicLayoutJob(existing) };
  }

  const job = {
    paperId,
    page,
    status: "queued",
    queuedAt: new Date().toISOString()
  };
  layoutJobs.set(key, job);

  void llmQueue
    .enqueue({
      label: `layout ${pdf.filename} p${page}`,
      kind: "layout",
      priority: "low",
      task: async () => {
        job.status = "running";
        job.startedAt = new Date().toISOString();
        const ai = getAi();
        const pdfPath = safePaperPath(pdf.filename);
        const { current, previous, next } = await extractPageModels(pdfPath, page);
        const fragments = getLayoutFragments(current);
        const previousFragments = previous ? getLayoutFragments(previous) : [];
        const nextFragments = next ? getLayoutFragments(next) : [];
        const validFragmentIds = new Set(fragments.map((fragment) => String(fragment.fragmentId)));
        const validLineIds = new Set(fragments.map((fragment) => Number(fragment.lineId)));
        console.log(`[layout] paper=${paperId} page=${page} fragments=${fragments.length} model=${layoutModel}`);
        const response = await withTimeout("layout generation", layoutTimeoutMs, () =>
          ai.models.generateContent({
            model: layoutModel,
            contents: [{ text: layoutPrompt({ page, fragments, previousFragments, nextFragments }) }],
            config: { responseMimeType: "application/json" }
          })
        );
        const generated = jsonFromText(response.text || "{}");
        const layout = {
          schemaVersion: layoutSchemaVersion,
          page,
          model: layoutModel,
          generatedAt: new Date().toISOString(),
          usageMetadata: response.usageMetadata || null,
          items: normalizeLayoutItems(generated.items, validFragmentIds, validLineIds)
        };
        const latest = await readLayoutCache(paperId);
        latest.pages ||= {};
        latest.pages[String(page)] = layout;
        await writeLayoutCache(paperId, latest);
        job.status = "ready";
        job.finishedAt = new Date().toISOString();
        console.log(`[layout] completed paper=${paperId} page=${page} items=${layout.items.length}`);
        return layout;
      }
    })
    .catch((error) => {
      job.status = "failed";
      job.error = errorMessage(error);
      job.finishedAt = new Date().toISOString();
      console.error(`[layout] failed paper=${paperId} page=${page}: ${job.error}`);
    });

  return { status: "queued", job: publicLayoutJob(job) };
}

async function enqueueMissingLayouts() {
  if (Date.now() - lastLayoutScanAt < 60_000) return;
  lastLayoutScanAt = Date.now();
  const pdfs = await listPdfFiles();
  for (const pdf of pdfs) {
    try {
      const pageCount = await cachedPageCount(pdf);
      const cache = await readLayoutCache(pdf.id);
      for (let page = 1; page <= pageCount; page += 1) {
        if (cache.pages?.[String(page)]?.schemaVersion === layoutSchemaVersion) continue;
        await enqueueLayoutPage(pdf.id, page);
      }
    } catch (error) {
      console.error(`[layout] could not enqueue ${pdf.filename}: ${errorMessage(error)}`);
    }
  }
}

async function enqueueMissingMetadata() {
  if (Date.now() - lastMetadataScanAt < 60_000) return;
  lastMetadataScanAt = Date.now();
  const [pdfs, metadata] = await Promise.all([listPdfFiles(), readMetadata()]);
  for (const pdf of pdfs) {
    try {
      if (metadata.papers[pdf.id]) continue;
      await enqueueMetadata(pdf.id);
    } catch (error) {
      console.error(`[metadata] could not enqueue ${pdf.filename}: ${errorMessage(error)}`);
    }
  }
}

async function layoutSummaryForPaper(pdf) {
  const [pageCount, cache] = await Promise.all([cachedPageCount(pdf), readLayoutCache(pdf.id)]);
  const readyPages = Object.values(cache.pages || {}).filter((page) => page?.schemaVersion === layoutSchemaVersion && page.items?.length).length;
  const jobs = Array.from(layoutJobs.values()).filter((job) => job.paperId === pdf.id);
  return {
    schemaVersion: layoutSchemaVersion,
    pageCount,
    readyPages,
    queuedPages: jobs.filter((job) => job.status === "queued").length,
    runningPages: jobs.filter((job) => job.status === "running").length,
    failedPages: jobs.filter((job) => job.status === "failed").length,
    ready: readyPages >= pageCount
  };
}

async function cachedPageCount(pdf) {
  const key = `${pdf.id}:${pdf.size}:${pdf.mtimeMs}`;
  if (pageCountCache.has(key)) return pageCountCache.get(key);
  const pageCount = await getPdfPageCount(safePaperPath(pdf.filename));
  pageCountCache.set(key, pageCount);
  return pageCount;
}

app.get("/api/papers", async (_req, res) => {
  const [pdfs, metadata] = await Promise.all([listPdfFiles(), readMetadata()]);
  const papers = await Promise.all(
    pdfs.map(async (pdf) => ({
      ...pdf,
      metadata: metadata.papers[pdf.id] || null,
      metadataJob: metadataJobStatus(pdf.id),
      layout: await layoutSummaryForPaper(pdf)
    }))
  );
  void enqueueMissingLayouts();
  void enqueueMissingMetadata();
  res.json({ papers });
});

app.get("/api/papers/:id/file", async (req, res) => {
  const pdf = (await listPdfFiles()).find((item) => item.id === req.params.id);
  if (!pdf) return res.status(404).json({ error: "Paper not found." });
  res.type("application/pdf");
  createReadStream(safePaperPath(pdf.filename)).pipe(res);
});

app.post("/api/papers/:id/analyze", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.body.force === true;
    const result = await enqueueMetadata(req.params.id, { force });
    res.status(result.status === "ready" ? 200 : 202).json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/papers/:id/layout/:page", async (req, res) => {
  try {
    const cache = await readLayoutCache(req.params.id);
    const pageLayout = cache.pages?.[req.params.page] || null;
    res.json({ layout: pageLayout, job: layoutJobStatus(req.params.id, Number(req.params.page)) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/papers/:id/layout", async (req, res) => {
  try {
    const cache = await readLayoutCache(req.params.id);
    const jobs = Array.from(layoutJobs.values())
      .filter((job) => job.paperId === req.params.id)
      .map(publicLayoutJob);
    res.json({ layout: cache, jobs });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/papers/:id/layout/:page", async (req, res) => {
  try {
    const page = Number(req.params.page);
    const force = req.query.force === "1" || req.body.force === true;
    const result = await enqueueLayoutPage(req.params.id, page, { force });
    res.status(result.status === "ready" ? 200 : 202).json(result);
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post("/api/papers/:id/layout", async (req, res) => {
  try {
    const pdf = (await listPdfFiles()).find((item) => item.id === req.params.id);
    if (!pdf) return res.status(404).json({ error: "Paper not found." });
    const pageCount = await getPdfPageCount(safePaperPath(pdf.filename));
    for (let page = 1; page <= pageCount; page += 1) {
      await enqueueLayoutPage(req.params.id, page, { force: req.query.force === "1" || req.body.force === true });
    }
    const jobs = Array.from(layoutJobs.values())
      .filter((job) => job.paperId === req.params.id)
      .map(publicLayoutJob);
    res.status(202).json({ jobs });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get("/api/jobs/llm", (_req, res) => {
  res.json({
    queue: llmQueue.snapshot(),
    layoutJobs: Array.from(layoutJobs.values()).map(publicLayoutJob),
    metadataJobs: Array.from(metadataJobs.values()).map(publicMetadataJob)
  });
});

app.post("/api/explain", async (req, res) => {
  try {
    const ai = getAi();
    const selectedText = String(req.body.text || "");
    if (selectedText.length > explainMaxChars) {
      return res.status(400).json({
        error: `Selected text is too long (${selectedText.length} chars). Please select a smaller paragraph.`
      });
    }
    console.log(
      `[explain] paper=${req.body.paperId || ""} page=${req.body.page || ""} mode=${req.body.mode || ""} chars=${selectedText.length} model=${explainModel}`
    );
    const startedAt = Date.now();
    const response = await llmQueue.enqueue({
      label: `explain ${req.body.paperId || ""} p${req.body.page || ""}`,
      kind: "explain",
      priority: "high",
      task: () =>
        withTimeout("explanation generation", explainTimeoutMs, () =>
          ai.models.generateContent({
            model: explainModel,
            contents: [{ text: explainPrompt(req.body) }],
            config: { responseMimeType: "application/json" }
          })
        )
    });
    console.log(`[explain] completed in ${Date.now() - startedAt}ms`);
    const explanation = jsonFromText(response.text || "{}");
    await fs.appendFile(
      readingLogPath,
      JSON.stringify({
        at: new Date().toISOString(),
        paperId: req.body.paperId,
        page: req.body.page,
        mode: req.body.mode,
        text: req.body.text,
        explanation
      }) + "\n",
      "utf8"
    );
    res.json({ explanation });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_req, res) => res.sendFile(path.join(root, "dist", "index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 5173);
app.listen(port, "127.0.0.1", () => {
  console.log(`Handmade Readable is running at http://127.0.0.1:${port}`);
  void enqueueMissingLayouts();
  void enqueueMissingMetadata();
});
