import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, FileText, Languages, Loader2, Minus, MousePointer2, Plus, RefreshCcw, ScrollText } from "lucide-react";
import { PdfReader } from "./pdf/PdfReader";
import type { ExplainResult, Paper, SelectionMode } from "./types";
import "./styles.css";

async function apiJson<T>(url: string, init?: RequestInit, timeoutMs = 120000): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { ...init, signal: controller.signal }).finally(() => window.clearTimeout(timeoutId));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload as T;
}

function App() {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [paperId, setPaperId] = useState("");
  const [mode, setMode] = useState<SelectionMode>("sentence");
  const [scale, setScale] = useState(1.15);
  const [selectedText, setSelectedText] = useState("");
  const [selectedPage, setSelectedPage] = useState(1);
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [loading, setLoading] = useState("papers");
  const [error, setError] = useState("");
  const maxExplainChars = 12000;

  async function loadPapers() {
    setError("");
    setLoading("papers");
    try {
      const data = await apiJson<{ papers: Paper[] }>("/api/papers");
      setPapers(data.papers);
      setPaperId((current) => current || data.papers[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }

  async function refreshPapers() {
    try {
      const data = await apiJson<{ papers: Paper[] }>("/api/papers");
      setPapers(data.papers);
      setPaperId((current) => current || data.papers[0]?.id || "");
    } catch (err) {
      console.info("[papers:refresh]", err);
    }
  }

  useEffect(() => {
    void loadPapers();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => void refreshPapers(), 10000);
    return () => window.clearInterval(intervalId);
  }, []);

  const currentPaper = useMemo(() => papers.find((paper) => paper.id === paperId) || null, [papers, paperId]);

  async function analyzeCurrentPaper() {
    if (!currentPaper) return;
    setError("");
    setLoading("metadata");
    try {
      await apiJson(`/api/papers/${currentPaper.id}/analyze`, { method: "POST" });
      await loadPapers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }

  async function explainSelection(text: string, page: number) {
    if (!currentPaper) return;
    setSelectedText(text);
    setSelectedPage(page);
    setResult(null);
    setError("");
    console.info("[explain:client]", { paperId: currentPaper.id, page, mode, chars: text.length });
    if (text.length > maxExplainChars) {
      setError(`選択範囲が長すぎます (${text.length}文字)。短い段落または文を選んでください。`);
      return;
    }
    setLoading("explain");
    const pageSummary = currentPaper.metadata?.pageSummaries?.find((item) => item.page === page)?.summary || "";
    try {
      console.info("[explain:request]", { chars: text.length });
      const data = await apiJson<{ explanation: ExplainResult }>(
        "/api/explain",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paperId: currentPaper.id,
            page,
            mode,
            text,
            pageSummary,
            paper: currentPaper.metadata
              ? {
                  title: currentPaper.metadata.title,
                  titleJa: currentPaper.metadata.titleJa,
                  summaryForContext: currentPaper.metadata.summaryForContext,
                  readingQuestions: currentPaper.metadata.readingQuestions
                }
              : null
          })
        },
        100000
      );
      console.info("[explain:response]", { page, mode });
      setResult(data.explanation);
    } catch (err) {
      setError(err instanceof Error && err.name === "AbortError" ? "解説生成がタイムアウトしました。" : err instanceof Error ? err.message : String(err));
    } finally {
      setLoading("");
    }
  }

  return (
    <>
      <main className="appShell">
        <aside className="rail" aria-label="reader controls">
          <div className="brand" title="Handmade Readable">
            <BookOpen size={22} />
          </div>

          <label className="railField">
            <FileText size={17} />
            <select value={paperId} onChange={(event) => setPaperId(event.target.value)} title="論文を選択">
              {papers.map((paper) => (
                <option key={paper.id} value={paper.id}>
                  {paper.metadata?.titleJa || paper.filename}
                  {!paper.metadata && paper.metadataJob ? ` (metadata ${paper.metadataJob.status})` : ""}
                  {paper.layout && !paper.layout.ready ? ` (layout ${paper.layout.readyPages}/${paper.layout.pageCount})` : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="segmented" title="選択単位">
            <button className={mode === "sentence" ? "active" : ""} onClick={() => setMode("sentence")}>
              <Languages size={17} />
              文
            </button>
            <button className={mode === "paragraph" ? "active" : ""} onClick={() => setMode("paragraph")}>
              <ScrollText size={17} />
              段落
            </button>
          </div>

          <button className="iconButton" onClick={() => setScale((value) => Math.max(0.65, value - 0.1))} title="縮小">
            <Minus size={18} />
          </button>
          <button className="iconButton" onClick={() => setScale((value) => Math.min(2.4, value + 0.1))} title="拡大">
            <Plus size={18} />
          </button>
          <button className="iconButton" onClick={analyzeCurrentPaper} disabled={!currentPaper || loading === "metadata"} title="メタデータ生成">
            {loading === "metadata" ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
          </button>
        </aside>

        <section className="viewerPane">
          {currentPaper ? (
            <PdfReader
              key={currentPaper.id}
              paperId={currentPaper.id}
              fileUrl={`/api/papers/${currentPaper.id}/file`}
              scale={scale}
              mode={mode}
              onSelect={explainSelection}
            />
          ) : (
            <div className="emptyState">papers ディレクトリに PDF を置くとここに表示されます。</div>
          )}
        </section>

        <aside className="inspector" aria-label="translation and explanation">
          <div className="paperHeader">
            <div className="paperTitle">{currentPaper?.metadata?.titleJa || currentPaper?.filename || "No paper"}</div>
            {currentPaper?.metadata?.title && <div className="paperSub">{currentPaper.metadata.title}</div>}
            {!currentPaper?.metadata && currentPaper?.metadataJob && (
              <div className="paperSub">metadata {currentPaper.metadataJob.status}</div>
            )}
            {currentPaper?.layout && (
              <div className="paperSub">
                layout {currentPaper.layout.readyPages}/{currentPaper.layout.pageCount}
                {currentPaper.layout.runningPages > 0 ? " running" : currentPaper.layout.ready ? " ready" : " queued"}
              </div>
            )}
          </div>

          {currentPaper?.metadata ? (
            <div className="questionMap">
              {Object.entries(currentPaper.metadata.readingQuestions || {}).map(([key, value]) => (
                <p key={key}>{value}</p>
              ))}
            </div>
          ) : (
            <button className="primaryButton" onClick={analyzeCurrentPaper} disabled={!currentPaper || loading === "metadata"}>
              {loading === "metadata" ? <Loader2 className="spin" size={17} /> : <RefreshCcw size={17} />}
              {currentPaper?.metadataJob && ["queued", "running"].includes(currentPaper.metadataJob.status)
                ? "メタデータ生成中"
                : "メタデータを生成"}
            </button>
          )}

          <div className="selectionBox">
            <div className="selectionMeta">
              <MousePointer2 size={16} />
              page {selectedPage} / {selectedText.length} chars
            </div>
            <p>{selectedText || "PDF 上の文または段落をクリックしてください。"}</p>
          </div>

          {loading === "explain" && (
            <div className="loadingLine">
              <Loader2 className="spin" size={17} />
              Gemini が文脈つきで読解しています
            </div>
          )}

          {error && <div className="errorBox">{error}</div>}

          {result && (
            <div className="answer">
              {!result.isJapaneseSource && result.translationJa && (
                <>
                  <h2>和訳</h2>
                  <p>{result.translationJa}</p>
                </>
              )}
              <h2>解説</h2>
              <p>{result.plainExplanationJa}</p>
              <h2>読みどころ</h2>
              <ul>
                {result.technicalNotesJa?.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <p className="hint">{result.readingLogHintJa}</p>
            </div>
          )}
        </aside>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
