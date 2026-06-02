import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { SelectionMode } from "../types";
import {
  buildPageTextModel,
  getSelectionTargets,
  isHighlighted,
  type LayoutItem,
  type PageTextModel,
  type SelectionTarget
} from "./textSelection";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

type Props = {
  paperId: string;
  fileUrl: string;
  scale: number;
  mode: SelectionMode;
  onSelect: (text: string, page: number) => void;
};

type PageView = {
  pageNumber: number;
  width: number;
  height: number;
  image: string;
  textModel: PageTextModel;
  layoutItems: LayoutItem[] | null;
  layoutStatus: "pending" | "ready" | "failed";
  layoutError?: string;
};

export function PdfReader({ paperId, fileUrl, scale, mode, onSelect }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageView[]>([]);
  const [highlight, setHighlight] = useState<{ page: number; target: SelectionTarget } | null>(null);
  const renderToken = useRef(0);
  const layoutMemory = useRef(new Map<number, LayoutItem[]>());
  const loadedLayoutPaperId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    setHighlight(null);
    setPdf(null);
    layoutMemory.current.clear();
    loadedLayoutPaperId.current = null;
    pdfjsLib.getDocument(fileUrl).promise.then((doc) => {
      if (!cancelled) setPdf(doc);
    });
    return () => {
      cancelled = true;
    };
  }, [fileUrl]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const token = renderToken.current + 1;
    renderToken.current = token;

    async function renderPages() {
      if (loadedLayoutPaperId.current !== paperId) {
        const storedLayouts = await loadStoredLayoutForPaper(paperId);
        if (cancelled || renderToken.current !== token) return;
        mergeLayouts(layoutMemory.current, storedLayouts);
        loadedLayoutPaperId.current = paperId;
      }
      if (cancelled || renderToken.current !== token) return;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled || renderToken.current !== token) return;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        if (!context) continue;
        await page.render({ canvasContext: context, viewport }).promise;
        const textContent = await page.getTextContent();
        const textModel = buildPageTextModel(textContent.items as never, viewport);
        const rememberedLayout = layoutMemory.current.get(pageNumber) || null;
        const pageView: PageView = {
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          image: canvas.toDataURL("image/png"),
          textModel,
          layoutItems: rememberedLayout,
          layoutStatus: rememberedLayout ? "ready" : "pending"
        };
        setPages((current) => upsertPage(current, pageView));
      }
    }

    void renderPages();
    return () => {
      cancelled = true;
    };
  }, [pdf, paperId, scale]);

  useEffect(() => {
    if (!pdf || pages.length === 0 || pages.every((page) => page.layoutStatus === "ready")) return;
    let cancelled = false;
    const refreshLayouts = async () => {
      const storedLayouts = await loadStoredLayoutForPaper(paperId);
      if (cancelled || storedLayouts.size === 0) return;
      mergeLayouts(layoutMemory.current, storedLayouts);
      setPages((current) =>
        current.map((page) => {
          const layoutItems = storedLayouts.get(page.pageNumber) || page.layoutItems;
          return layoutItems
            ? {
                ...page,
                layoutItems,
                layoutStatus: "ready",
                layoutError: undefined
              }
            : page;
        })
      );
    };
    const intervalId = window.setInterval(() => void refreshLayouts(), 5000);
    void refreshLayouts();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pdf, paperId, pages]);

  function handleTargetClick(page: PageView, target: SelectionTarget) {
    setHighlight({ page: page.pageNumber, target });
    onSelect(target.text, page.pageNumber);
  }

  return (
    <div className="pdfScroller">
      {pages.length === 0 && <div className="emptyState">PDF を読み込んでいます。</div>}
      {pages.map((page) => (
        <div className="pdfPage" style={{ width: page.width, height: page.height }} key={page.pageNumber}>
          <img src={page.image} width={page.width} height={page.height} draggable={false} />
          {page.layoutStatus === "failed" && (
            <div className="layoutWarning" title={page.layoutError || "Layout generation failed"}>
              layout failed
            </div>
          )}
          {page.layoutStatus === "pending" && <div className="layoutPending">layout queue</div>}
          <div className="textLayer">
            <SelectionLayer
              page={page}
              mode={mode}
              layoutItems={page.layoutItems}
              layoutStatus={page.layoutStatus}
              highlight={highlight?.page === page.pageNumber ? highlight.target : null}
              onClick={handleTargetClick}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function SelectionLayer({
  page,
  mode,
  layoutItems,
  layoutStatus,
  highlight,
  onClick
}: {
  page: PageView;
  mode: SelectionMode;
  layoutItems: LayoutItem[] | null;
  layoutStatus: PageView["layoutStatus"];
  highlight: SelectionTarget | null;
  onClick: (page: PageView, target: SelectionTarget) => void;
}) {
  const [hoveredTarget, setHoveredTarget] = useState<SelectionTarget | null>(null);
  const targets = layoutStatus === "ready" ? getSelectionTargets(page.textModel, mode, layoutItems) : [];
  return (
    <>
      {page.textModel.spans.map((span) => (
        <span
          key={span.id}
          className={`textHighlight ${highlight && isHighlighted(span, highlight) ? "highlight" : ""}`}
          style={{
            left: span.left,
            top: span.top,
            width: span.width,
            height: span.height
          }}
        />
      ))}
      {hoveredTarget?.rects.map((rect, index) => (
        <span
          key={`hover-${hoveredTarget.id}-${index}`}
          className="targetHover"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          }}
        />
      ))}
      {targets.flatMap((target) =>
        target.rects.map((rect, rectIndex) => (
          <button
            type="button"
            key={`${target.id}-${rectIndex}`}
            className="textHit"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }}
            title={target.text}
            onMouseEnter={() => setHoveredTarget(target)}
            onMouseLeave={() => setHoveredTarget((current) => (current?.id === target.id ? null : current))}
            onClick={() => onClick(page, target)}
          />
        ))
      )}
    </>
  );
}

function upsertPage(pages: PageView[], page: PageView) {
  const next = pages.filter((item) => item.pageNumber !== page.pageNumber);
  next.push(page);
  return next.sort((a, b) => a.pageNumber - b.pageNumber);
}

function mergeLayouts(target: Map<number, LayoutItem[]>, source: Map<number, LayoutItem[]>) {
  source.forEach((items, page) => target.set(page, items));
}

async function loadStoredLayoutForPaper(paperId: string) {
  const layouts = new Map<number, LayoutItem[]>();
  const response = await fetch(`/api/papers/${paperId}/layout`);
  if (!response.ok) return layouts;
  const data = await response.json().catch(() => null);
  const pages = data?.layout?.pages || {};
  Object.entries(pages).forEach(([page, layout]) => {
    const items = (layout as { items?: LayoutItem[] })?.items;
    if (items?.length) layouts.set(Number(page), items);
  });
  return layouts;
}
