import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  ZoomIn,
  ZoomOut,
  Save,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Wand2,
  Eraser,
  Loader2,
  Plus,
  Table2,
  Download
} from 'lucide-react';

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createWorker } from 'tesseract.js';
import * as XLSX from 'xlsx';

import api from '../services/api';
import { enhanceDetections } from '../utils/engineeringDetection';
import { contextualFilter } from '../utils/contextualFilter';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/* =========================================================
   DETECTION HELPERS (shared by Auto Detect, Add Dimension
   and balloon drop re-reads)
========================================================= */

const normalizeDetectionText = (value) => {
  let val = String(value || '').trim().replace(/\s+/g, ' ');
  return val
    .replace(/[−–—]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[Øø]/g, 'Ø')
    .replace(/^[OQo0]\s*(?=\d)/i, 'Ø') // Converts Q19, O19, 019 to Ø19
    .replace(/(?:^|\s)[vV]\s*(?=\d)/g, ' ↧ ') // Converts v 7 to ↧ 7 (depth)
    .replace(/(?:^|\s)[uU]\s*(?=\d)/g, ' ⌴ ') // Converts U 14 to ⌴ 14 (counterbore)
    .replace(/(?:^|\s)[xX]\s*(?=\d)/g, ' × ') // Multiplier
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s+/g, ' ').trim();
};

const DETECTION_PATTERNS = {
  tolerance:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?\s*(?:THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN)*\s*$/i,
  bilateral:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*(?:\/|\s)\s*[-−]\s*\d+(?:\.\d+)?\s*(?:THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN)*\s*$/i,
  diameter: /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*Ø\s*\d+(?:\.\d+)?\s*$/i,
  radius: /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*R\s*\d+(?:\.\d+)?\s*$/i,
  dimension:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d{1,4}(?:\.\d{1,4})?(?:\s*(?:mm|in|inch|inches|THRU|ALL|DP|DEEP|TYP|PLACES|MAX|MIN|REF))*\s*$/i,
  smallTolerance: /^\s*[+-±]?\s*0?\.\d{1,3}\s*$/,
  fit:
    /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*\d+(?:\.\d+)?\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i,
  angle: /^\s*\d+(?:\.\d+)?\s*°\s*$/,
  angleTolerance:
    /^\s*\d+(?:\.\d+)?\s*°\s*±\s*\d+(?:\.\d+)?\s*$/,
  angularToleranceLine: /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/,
  bareFit:
    /^\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i,
  thread:
    /^\s*M\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?\s*$/i,
  datumFeature: /^\s*\d+(?:\.\d+)?\s*[A-Z]\s*$/,
  symbol: /^\s*(Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|⌵|x)\s*$/i
};

const isDetectionText = (rawText) => {
  const text = normalizeDetectionText(rawText);

  if (!text) {
    return false;
  }

  if (
    /^(A[0-4]|REV|DATE|DESCRIPTION|WEIGHT|SHEET|SCALE)$/i.test(
      text
    )
  ) {
    return false;
  }

  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(text)) {
    return false;
  }

  if (/\d+[-_/]\d+[-_/]\d+/.test(text)) {
    return false;
  }

  if (/^\d{4,}$/.test(text)) {
    return false;
  }

  return true; // Always allow any text/number during manual ballooning
};

const detectionCenterX = (item) =>
  Number(item.x || 0) + Number(item.width || 0) / 2;

// PDF text y is the BASELINE (bottom), OCR y is the TOP of the box.
const detectionCenterY = (item) =>
  item.source === 'ocr'
    ? Number(item.y || 0) + Number(item.height || 0) / 2
    : Number(item.y || 0) - Number(item.height || 0) / 2;

/* =========================================================
   STATUS
   Green checkmark = Verified (high confidence / selectable text)
   Orange warning  = Needs verification (OCR low confidence)
========================================================= */

const statusForDetection = (detected) => {
  if (!detected) {
    return 'Draft';
  }

  if (detected.source === 'pdf') {
    return 'Verified';
  }

  return Number(detected.confidence || 0) >= 50
    ? 'Verified'
    : 'Needs verification';
};

/* =========================================================
   OCR / PDF CLUSTERING
   ---------------------------------------------------------
   OCR reads a single dimension callout as separate words
   (value line + +tolerance line + -tolerance line). Without
   grouping this becomes 2-3 balloons for ONE dimension.

   clusterDetectionsIntoDimensions merges words that sit
   close together (stacked value + tolerances) into a single
   detection so each dimension = ONE balloon.
========================================================= */

const clusterDetectionsIntoDimensions = (detections) => {
  if (!detections || detections.length === 0) {
    return [];
  }

  const items = detections
    .map((item) => ({
      ...item,
      text: normalizeDetectionText(item.text)
    }))
    .filter((item) => item.text);

  const clusterCenterX = (item) =>
    Number(item.x || 0) +
    Number(item.width || 0) / 2;

  const clusterCenterY = (item) =>
    item.source === 'ocr'
      ? Number(item.y || 0) +
        Number(item.height || 0) / 2
      : Number(item.y || 0) -
        Number(item.height || 0) / 2;

  const isFullToleranceText = (text) =>
    /^\s*(?:Ø\s*)?\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    ) ||
    /^\s*(?:Ø\s*)?\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    );

  const isToleranceLineText = (text) =>
    /^\s*[+-]?\s*0?\.\d{1,3}\s*$/i.test(text) ||
    /^\s*±\s*\d+(?:\.\d+)?\s*$/i.test(text) ||
    /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/i.test(text) ||
    /^\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*$/i.test(
      text
    );

  const toleranceNumber = (text) => {
    const match = normalizeDetectionText(text).match(
      /[+-±]?\s*(\d+(?:\.\d+)?)/
    );

    return match ? Number(match[1]) : null;
  };

  /* Cluster items that sit in the same spot. */

  const clusters = [];
  const used = new Set();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;

    const cluster = [items[i]];
    used.add(i);

    let grew = true;

    while (grew) {
      grew = false;

      for (let j = 0; j < items.length; j++) {
        if (used.has(j)) continue;

        const candidate = items[j];
        const overlaps = cluster.some((member) => {
          const dx = Math.abs(
            clusterCenterX(member) -
              clusterCenterX(candidate)
          );

          const dy = Math.abs(
            clusterCenterY(member) -
              clusterCenterY(candidate)
          );

          return dx <= 45 && dy <= 75;
        });

        if (overlaps) {
          cluster.push(candidate);
          used.add(j);
          grew = true;
        }
      }
    }

    clusters.push(cluster);
  }

  const result = [];

  for (const cluster of clusters) {
    const sorted = [...cluster].sort((a, b) => {
      const aComplete = isFullToleranceText(a.text)
        ? 0
        : 1;

      const bComplete = isFullToleranceText(b.text)
        ? 0
        : 1;

      if (aComplete !== bComplete) {
        return aComplete - bComplete;
      }

      /* The value line is usually the largest text. */

      const aHeight = Number(a.height || 0);
      const bHeight = Number(b.height || 0);

      if (Math.abs(aHeight - bHeight) > 0.5) {
        return bHeight - aHeight;
      }

      return (b.confidence || 0) - (a.confidence || 0);
    });

    const primary = sorted[0];

    if (!primary) continue;

    let combinedText = primary.text;

    /*
      Already a complete "25 ±0.05" reading.
      Skip merging, but still keep any other
      non-tolerance detections in the cluster.
    */

    const primaryIsComplete =
      isFullToleranceText(primary.text);

    if (!primaryIsComplete) {
      /*
        Collect tolerance lines that sit with the value.
        Stacked top-to-bottom: top = plus, bottom = minus.
      */

      const toleranceLines = sorted
        .slice(1)
        .filter((item) =>
          isToleranceLineText(item.text)
        )
        .sort(
          (a, b) =>
            clusterCenterY(a) - clusterCenterY(b)
        )
        .slice(0, 2);

      if (toleranceLines.length === 1) {
        const value = toleranceNumber(
          toleranceLines[0].text
        );

        if (Number.isFinite(value)) {
          combinedText =
            `${primary.text} ±${String(
              Number(value.toFixed(3))
            )}`;
        }
      } else if (toleranceLines.length >= 2) {
        const top = toleranceNumber(
          toleranceLines[0].text
        );

        const bottom = toleranceNumber(
          toleranceLines[1].text
        );

        if (
          Number.isFinite(top) &&
          Number.isFinite(bottom)
        ) {
          const topHasMinus =
            /^-/.test(toleranceLines[0].text);

          const bottomHasPlus =
            /^\+/.test(toleranceLines[1].text);

          if (topHasMinus && bottomHasPlus) {
            combinedText =
              `${primary.text} +${String(
                Number(bottom.toFixed(3))
              )}/-${String(Number(top.toFixed(3)))}`;
          } else {
            combinedText =
              `${primary.text} +${String(
                Number(top.toFixed(3))
              )}/-${String(
                Number(bottom.toFixed(3))
              )}`;
          }
        }
      }
    }

    // Append any other non-tolerance text in the same cluster (e.g. THRU ALL, ↧ 7, fits)
    // so they are included in the same balloon specification.
    const otherTextItems = sorted
      .slice(1)
      .filter((item) => !isToleranceLineText(item.text))
      .sort((a, b) => clusterCenterY(a) - clusterCenterY(b));
      
    if (otherTextItems.length > 0) {
      const otherText = otherTextItems
        .map(item => normalizeDetectionText(item.text))
        .join(' ');
      combinedText = `${combinedText} ${otherText}`;
    }

    result.push({
      ...primary,
      text: combinedText
    });
  }

  return result;
};

export default function DrawingWorkspace() {
  const { id } = useParams();
  const dRatio = window.devicePixelRatio || 2;

  const canvasRef = useRef(null);
  const pdfContainerRef = useRef(null);

  // Used for dragging balloons
  const dragBalloonRef = useRef(null);

  // Used for the manual "Add Dimension" drag-box selection
  const selectionRef = useRef(null);
  const [selection, setSelection] = useState(null);

  // Reused OCR worker + full-page render cache (manual scans)
  const ocrWorkerRef = useRef(null);
  const ocrCacheRef = useRef({});

  // Used for the Add Dimension drag-select
  const addSelectRef = useRef(null);

  const [project, setProject] = useState(null);
  const [drawings, setDrawings] = useState([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState(null);

  const [balloons, setBalloons] = useState([]);
  const [characteristics, setCharacteristics] = useState([]);

  const [mode, setMode] = useState('none');
  const [selectedBalloonId, setSelectedBalloonId] = useState(null);

  const [addScanning, setAddScanning] = useState(false);
  const [selectRect, setSelectRect] = useState(null);
  const [roiRect, setRoiRect] = useState(null);
  const [previewDetections, setPreviewDetections] = useState([]);
  const roiSelectRef = useRef(null);

  const [zoom, setZoom] = useState(1);
  const [renderScale, setRenderScale] = useState(1);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);

  const [pdfDocument, setPdfDocument] = useState(null);
  const [pdfPage, setPdfPage] = useState(null);

  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);

  const [activeDrawingMenuId, setActiveDrawingMenuId] = useState(null);
  const [confirmDeleteDrawingId, setConfirmDeleteDrawingId] =
    useState(null);

  const [drawingError, setDrawingError] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);

  /*
    Prevents Auto Detect from running twice on the same
    drawing. Reset by "Clear All Ballooning" or when the
    drawing / page changes.
  */

  const autoDetectDoneRef = useRef(false);

  const [savingUnitId, setSavingUnitId] = useState(null);
  const [savingCharacteristicId, setSavingCharacteristicId] = useState(null);
  const [showCharacteristicsTable, setShowCharacteristicsTable] = useState(false);

  // Editable right-panel balloon form
  const [currentBalloonNo, setCurrentBalloonNo] = useState('');
  const [editData, setEditData] = useState(null);
  const [focusedField, setFocusedField] = useState('specification');

  const insertSymbol = (sym) => {
    const activeEl = document.activeElement;
    const isInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
    const start = isInput && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
    const end = isInput && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

    if (focusedField === 'currentBalloonNo') {
      setCurrentBalloonNo(prev => {
        const val = prev || '';
        if (start !== null) {
          setTimeout(() => activeEl.setSelectionRange(start + sym.length, start + sym.length), 0);
          return val.substring(0, start) + sym + val.substring(end);
        }
        return val + sym;
      });
      return;
    }
    if (!editData) return;
    setEditData((prev) => {
      if (!prev) return prev;
      const val = prev[focusedField] || '';
      let newVal = val + sym;
      if (start !== null) {
        newVal = val.substring(0, start) + sym + val.substring(end);
        setTimeout(() => activeEl.setSelectionRange(start + sym.length, start + sym.length), 0);
      }
      return { ...prev, [focusedField]: newVal };
    });
  };

  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

  const backendBase = apiBase.replace(/\/api\/?$/, '');

  /* =========================================================
     DRAWING URL
  ========================================================= */

  const drawingUrlFor = (drawingItem) => {
    if (!drawingItem) return null;

    let pathValue = drawingItem.url || drawingItem.filePath;

    if (!pathValue) return null;

    if (pathValue.startsWith('http')) {
      return pathValue;
    }

    if (!pathValue.startsWith('/')) {
      pathValue = `/${pathValue}`;
    }

    return `${backendBase}${pathValue}`;
  };

  /* =========================================================
     LOAD DATA
  ========================================================= */

  const loadData = async () => {
    try {
      const projectData = await api.get(`/projects/${id}`);
      setProject(projectData);

      const drawingsData = await api
        .get(`/projects/${id}/drawings`)
        .catch(async () => {
          const single = await api
            .get(`/projects/${id}/drawing`)
            .catch(() => null);

          return single ? [single] : [];
        });

      const normalizedDrawings = drawingsData.map((drawing) => ({
        ...drawing,
        url: drawing.filePath || drawing.url
      }));

      setDrawings(normalizedDrawings);

      setSelectedDrawingId((current) => {
        if (
          current &&
          normalizedDrawings.some(
            (item) => item._id === current
          )
        ) {
          return current;
        }

        return normalizedDrawings.length > 0
          ? normalizedDrawings[0]._id
          : null;
      });

      const balloonData = await api
        .get(`/projects/${id}/balloons`)
        .catch(() => []);

      setBalloons(balloonData);

      const characteristicData = await api
        .get(`/projects/${id}/characteristics`)
        .catch(() => []);

      setCharacteristics(characteristicData);
    } catch (error) {
      console.error(error);
      setMessage('Unable to load project');
    }
  };

  useEffect(() => {
    loadData();
  }, [id]);

  /* =========================================================
     SELECTED DRAWING
  ========================================================= */

  const selectedDrawing = useMemo(
    () =>
      drawings.find(
        (drawingItem) =>
          drawingItem._id === selectedDrawingId
      ) || null,
    [drawings, selectedDrawingId]
  );

  const drawingUrl = drawingUrlFor(selectedDrawing);

  const isPdf =
    selectedDrawing?.filePath
      ?.toLowerCase()
      .endsWith('.pdf') ||
    selectedDrawing?.url
      ?.toLowerCase()
      .endsWith('.pdf') ||
    selectedDrawing?.fileName
      ?.toLowerCase()
      .endsWith('.pdf');

  /* =========================================================
     DISPLAY BALLOONS
  ========================================================= */

  const displayedBalloons = useMemo(() => {
    const allBallons = new Map();
    const firstDrawingId = drawings.length > 0 ? drawings[0]._id : null;

    // Add balloons from balloons state
    (balloons || []).forEach((b) => {
      const belongsTo = b.drawingId || firstDrawingId;
      if (belongsTo && belongsTo !== selectedDrawingId) return;

      allBallons.set(b._id, {
        _id: b._id,
        number: b.number,
        x: b.x,
        y: b.y,
        anchorX: b.anchorX ?? (b.x || 0) + 25,
        anchorY: b.anchorY ?? (b.y || 0) + 25,
        text: b.text,
        type: b.type,
        page: b.page,
        status: b.status || 'Draft'
      });
    });

    // Add/override with characteristics (auto-detect etc.)
    (characteristics || []).forEach((c) => {
      const belongsTo = c.drawingId || firstDrawingId;
      if (belongsTo && belongsTo !== selectedDrawingId) return;

      if (c.balloonId) {
        const existing = allBallons.get(c.balloonId);
        allBallons.set(c.balloonId, {
          _id: c.balloonId,
          number: c.number,
          x: existing?.x ?? c.x,
          y: existing?.y ?? c.y,
          anchorX: existing?.anchorX ?? c.anchorX ?? (c.x || 0) + 25,
          anchorY: existing?.anchorY ?? c.anchorY ?? (c.y || 0) + 25,
          text: c.specification,
          type: c.type,
          page: c.page,
          status: c.status || 'Draft'
        });
      }
    });

    return Array.from(allBallons.values());
  }, [balloons, characteristics, selectedDrawingId, drawings]);

  /* =========================================================
     LOAD PDF
  ========================================================= */

  useEffect(() => {
    if (
      !selectedDrawing ||
      !drawingUrl ||
      !isPdf
    ) {
      setPdfDocument(null);
      setPdfPage(null);
      setPageNumber(1);
      setPageCount(1);
      autoDetectDoneRef.current = false;
      return;
    }

    let cancelled = false;

    const loadPdf = async () => {
      try {
        setLoadingPdf(true);
        setDrawingError(false);

        const loadingTask = pdfjsLib.getDocument({
          url: drawingUrl
        });

        const pdf = await loadingTask.promise;

        if (cancelled) return;

        setPdfDocument(pdf);
        setPageCount(pdf.numPages);
        setPageNumber(1);

        const page = await pdf.getPage(1);

        if (!cancelled) {
          setPdfPage(page);
          autoDetectDoneRef.current = false;
        }
      } catch (error) {
        console.error(
          'PDF loading error:',
          error
        );

        if (!cancelled) {
          setDrawingError(true);
          setMessage(
            'Unable to display this PDF. Make sure the backend is running.'
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    };

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [
    selectedDrawingId,
    drawingUrl,
    isPdf
  ]);

  /* =========================================================
     LOAD SELECTED PAGE
  ========================================================= */

  useEffect(() => {
    if (!pdfDocument) return;

    let cancelled = false;

    const loadPage = async () => {
      try {
        setLoadingPdf(true);

        const page =
          await pdfDocument.getPage(
            pageNumber
          );

        if (!cancelled) {
          setPdfPage(page);
          autoDetectDoneRef.current = false;
        }
      } catch (error) {
        console.error(error);
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    };

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [pdfDocument, pageNumber]);

  /* =========================================================
     RENDER PDF
  ========================================================= */

  useEffect(() => {
    if (
      !pdfPage ||
      !canvasRef.current
    ) {
      return;
    }

    const canvas = canvasRef.current;
    const context =
      canvas.getContext('2d');

    const baseViewport =
      pdfPage.getViewport({
        scale: 1
      });

    const containerWidth =
      pdfContainerRef.current
        ?.clientWidth || 900;

    const fitScale =
      (containerWidth - 40) /
      baseViewport.width;

    const finalScale = Math.max(
      0.5,
      fitScale * zoom
    );

    const viewport =
      pdfPage.getViewport({
        scale: finalScale * dRatio
      });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    canvas.style.width =
      `${viewport.width / dRatio}px`;

    canvas.style.height =
      `${viewport.height / dRatio}px`;

    const renderContext = {
      canvasContext: context,
      viewport
    };

    pdfPage.render(renderContext);
  }, [pdfPage, zoom]);

/* =========================================================
      DOWNLOAD PDF WITH BALLOONS
  ========================================================= */

  const downloadPdf = async () => {
    if (!selectedDrawing) {
      setMessage('No drawing selected');
      return;
    }

    // Check if we have a PDF file path/url
    const isPdf = selectedDrawing.filePath
      ? selectedDrawing.filePath.toLowerCase().endsWith('.pdf')
      : selectedDrawing.url
        ? selectedDrawing.url.toLowerCase().endsWith('.pdf')
        : false;

    if (!isPdf) {
      setMessage('Selected drawing is not a PDF');
      return;
    }

    if (!pdfPage) {
      setMessage('PDF not loaded - please wait for the drawing to render');
      return;
    }

    try {
      setMessage('Generating PDF with balloons...');

      // Original page size in PDF points (1pt = 1/72 inch)
      const baseViewport = pdfPage.getViewport({ scale: 1 });

      // The balloon x/y values live in the displayed canvas pixel space.
      // Re-map them onto the high-resolution export canvas below.
      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      // Render the page at high resolution so the downloaded
      // PDF stays sharp regardless of the current zoom level.
      const exportScale = 3;
      const viewport =
        pdfPage.getViewport({
          scale: exportScale
        });

      const exportCanvas =
        document.createElement('canvas');

      exportCanvas.width =
        Math.ceil(viewport.width);

      exportCanvas.height =
        Math.ceil(viewport.height);

      const context =
        exportCanvas.getContext('2d');

      context.fillStyle = '#ffffff';
      context.fillRect(
        0,
        0,
        exportCanvas.width,
        exportCanvas.height
      );

      await pdfPage.render({
        canvasContext: context,
        viewport
      }).promise;

      const ratio =
        exportScale / displayScale;

      const pageBalloons =
        displayedBalloons.filter(
          (balloon) =>
            !balloon.page ||
            balloon.page === pageNumber
        );

      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const balloon of pageBalloons) {
        const x =
          (balloon.x ?? 0) * ratio;

        const y =
          (balloon.y ?? 0) * ratio;

        const ax =
          (balloon.anchorX ?? x + 12) *
          ratio;

        const ay =
          (balloon.anchorY ?? y + 12) *
          ratio;

        // Direction from the balloon TOWARDS the value
        const dx = ax - x;
        const dy = ay - y;

        const dist =
          Math.hypot(dx, dy) || 1;

        const ux = dx / dist;
        const uy = dy / dist;

        // Balloon marker radius (matches the 24px on-screen circle)
        const radius = 9 * ratio;
        const head = 7 * ratio;

        const startX =
          x + ux * radius;

        const startY =
          y + uy * radius;

        // Leader line
        context.strokeStyle = 'rgba(220, 38, 38, 0.4)';
        context.lineWidth = Math.max(
          1.5 * ratio,
          1.5
        );

        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(ax, ay);
        context.stroke();

        // Arrowhead pointing at the measurement
        const angle =
          Math.atan2(uy, ux);

        context.fillStyle = 'rgba(220, 38, 38, 0.4)';
        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(
          ax -
            head *
              Math.cos(angle - 0.35),
          ay -
            head *
              Math.sin(angle - 0.35)
        );
        context.lineTo(
          ax -
            head *
              Math.cos(angle + 0.35),
          ay -
            head *
              Math.sin(angle + 0.35)
        );
        context.closePath();
        context.fill();

        // Balloon circle
        context.fillStyle = 'rgba(239, 68, 68, 0.4)';
        context.beginPath();
        context.arc(
          x,
          y,
          radius,
          0,
          Math.PI * 2
        );
        context.fill();

        // Balloon number
        context.fillStyle = '#7f1d1d';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.font = `bold ${Math.max(
          10 * ratio,
          10
        )}px sans-serif`;

        context.fillText(
          String(
            balloon.number ?? ''
          ),
          x,
          y
        );
      }

      // Build a real PDF sized to the original drawing page
      const pageWidthMm =
        (baseViewport.width * 25.4) / 72;

      const pageHeightMm =
        (baseViewport.height * 25.4) / 72;

      const pdf = new jsPDF({
        orientation:
          pageWidthMm >= pageHeightMm
            ? 'landscape'
            : 'portrait',
        unit: 'mm',
        format: [
          pageWidthMm,
          pageHeightMm
        ]
      });

      const imageData =
        exportCanvas.toDataURL(
          'image/png'
        );

      pdf.addImage(
        imageData,
        'PNG',
        0,
        0,
        pageWidthMm,
        pageHeightMm
      );

      // Add declaration
      pdf.setFontSize(11);
      pdf.setFont('times', 'normal');
      pdf.setTextColor(0, 0, 0); // Black text
      pdf.setFillColor(255, 255, 255);
      pdf.rect(pageWidthMm - 100, pageHeightMm - 9, 95, 6, 'F');
      pdf.text('Ballooning generated using PESCOM VYAVASTHA software', pageWidthMm - 10, pageHeightMm - 5, { align: 'right' });
      pdf.setTextColor(0, 0, 0); // Reset to black


      // Add Characteristics Table as new page
      pdf.addPage('a4', 'portrait');
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Characteristics Table', 14, 20);

      // Sort characteristics by balloon number
      const sortedCharacteristics = [...characteristics].sort(
        (a, b) => (a.number || 0) - (b.number || 0)
      );

      const tableData = sortedCharacteristics.map((char) => [
        String(char.number || ''),
        String(char.specification || ''),
        String(char.value || ''),
        String(char.plusTolerance || ''),
        String(char.minusTolerance || '')
      ]);

      autoTable(pdf, {
        startY: 25,
        head: [['Balloon No', 'Description', 'Dimensions No', 'Upper Tolerance', 'Lower Tolerance']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [41, 128, 185], textColor: [255, 255, 255], fontStyle: 'bold' },
        styles: { fontSize: 10, cellPadding: 3, halign: 'left' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        margin: { top: 20, right: 14, bottom: 20, left: 14 }
      });

      const downloadName = selectedDrawing.fileName
        ? selectedDrawing.fileName.replace(
            /\.[^/.]+$/,
            '_ballooned.pdf'
          )
        : 'ballooned_drawing.pdf';

      pdf.save(downloadName);

      setMessage(
        'PDF with balloons downloaded successfully'
      );
    } catch (error) {
      console.error(
        'PDF download error:',
        error
      );

      setMessage(
        error.message ||
        'Failed to download PDF with balloons'
      );
    }
  };

  /* =========================================================
     ADD DIMENSION
     Works like the Lens "Add Dimension" tool:
     - Toggle with the button or press "A"
     - Click, or drag a box over a dimension on the drawing
     - The AI reads the dimension value (PDF text layer, with
       OCR fallback) and adds a new balloon
     - The Dimension Editor opens so the value can be verified
  ========================================================= */

  const getNextBalloonNumber = () => {
    let currentMaxNumber = 0;

    displayedBalloons.forEach((balloon) => {
      const number = Number(balloon.number);

      if (
        Number.isFinite(number) &&
        number > currentMaxNumber
      ) {
        currentMaxNumber = number;
      }
    });

    return currentMaxNumber + 1;
  };

  const addDimensionAtRect = async (rect) => {
    if (!pdfPage || !canvasRef.current) {
      return;
    }

    try {
      setAddScanning(true);

      const scanned =
        await scanDimensionInRect(rect);

      const centerX =
        (rect.x1 + rect.x2) / 2;

      const centerY =
        (rect.y1 + rect.y2) / 2;

      /*
        Always place a balloon wherever the user drags.
        If no dimension text could be read, use an empty
        placeholder they can fill in from the side panel.
      */

      const detected =
        scanned || {
          text: '',
          value: '',
          type: 'Dimension',
          plusTolerance: '0.00',
          minusTolerance: '0.00',
          upperLimit: '0.00',
          lowerLimit: '0.00',
          specification: 'Dimension',
          centerX,
          centerY
        };

      let anchorX = centerX;
      let anchorY = centerY;
      let balloonX = Math.max(0, centerX - 28);
      let balloonY = Math.max(0, centerY - 28);

      // Point the arrow at the read value and
      // place the balloon away from it.
      anchorX = detected.centerX;
      anchorY = detected.centerY;
      balloonX = Math.max(0, anchorX + 15);
      balloonY = Math.max(0, anchorY - 15);

      const nextNumber = getNextBalloonNumber();

      const status = statusForDetection(detected);

      const balloon = await api.post(
        `/projects/${id}/balloons`,
        {
          drawingId: selectedDrawingId,
          x: balloonX,
          y: balloonY,
          anchorX,
          anchorY,
          text: detected.text,
          type: detected.type,
          number: nextNumber,
          page: pageNumber,
          status
        }
      );

      const characteristic = await api.post(
        `/projects/${id}/characteristics`,
        {
          drawingId: selectedDrawingId,
          balloonId: balloon._id,
          number: nextNumber,
          type: detected.type,
          value: detected.value,
          unit: 'mm',
          plusTolerance: detected.plusTolerance,
          minusTolerance: detected.minusTolerance,
          upperLimit: detected.upperLimit,
          lowerLimit: detected.lowerLimit,
          specification: detected.specification,
          inspectionMethod: 'Vernier Caliper',
          instrument: '',
          actualValue: '',
          result: 'NOT INSPECTED',
          remarks: '',
          page: pageNumber,
          x: anchorX,
          y: anchorY,
          status
        }
      );

      setBalloons((prev) => [
        ...prev,
        {
          ...balloon,
          number: nextNumber,
          x: balloonX,
          y: balloonY,
          page: pageNumber,
          drawingId: selectedDrawingId
        }
      ]);

      setCharacteristics((prev) => [
        ...prev,
        {
          ...characteristic,
          number: nextNumber,
          page: pageNumber,
          drawingId: selectedDrawingId
        }
      ]);

      // Opens the Dimension Editor so the value can be verified
      setSelectedBalloonId(balloon._id);

      setMessage(
        scanned
          ? `Balloon ${nextNumber}: "${detected.specification}" read from the drawing`
          : `Balloon ${nextNumber} added at that spot. Fill in its value in the side panel.`
      );
    } catch (error) {
      console.error(
        'Add dimension failed:',
        error
      );

      setMessage(
        error.message ||
        'Unable to add dimension'
      );
    } finally {
      setAddScanning(false);
    }
  };

  /* Drag-select over a dimension. */

  const clientToCanvasPoint = (event) => {
    const canvas = canvasRef.current;

    if (!canvas) {
      return { x: 0, y: 0 };
    }

    const rect = canvas.getBoundingClientRect();

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  };

  const handleAddPointerDown = (event) => {
    if (!canvasRef.current) return;
    if (event.target.closest('.balloon-marker')) return;

    if (mode === 'manual') {
      const point = clientToCanvasPoint(event);
      addSelectRef.current = { startX: point.x, startY: point.y };
      setSelectRect({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } else if (mode === 'select_area') {
      const point = clientToCanvasPoint(event);
      roiSelectRef.current = { startX: point.x, startY: point.y };
      setRoiRect({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
  };

  const handleAddPointerMove = (event) => {
    if (!canvasRef.current) return;
    if (mode === 'manual' && addSelectRef.current) {
      const point = clientToCanvasPoint(event);
      const start = addSelectRef.current;
      setSelectRect({
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      });
    } else if (mode === 'select_area' && roiSelectRef.current) {
      const point = clientToCanvasPoint(event);
      const start = roiSelectRef.current;
      setRoiRect({
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      });
    }
  };

  const handleAddPointerUp = async (event) => {
    if (!canvasRef.current) return;
    if (mode === 'manual' && addSelectRef.current) {
      const start = addSelectRef.current;
      addSelectRef.current = null;
      const point = clientToCanvasPoint(event);
      let rect = {
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      };
      setSelectRect(null);
      const width = rect.x2 - rect.x1;
      const height = rect.y2 - rect.y1;
      if (width < 5 && height < 5) {
        const cx = (rect.x1 + rect.x2) / 2;
        const cy = (rect.y1 + rect.y2) / 2;
        rect = { x1: cx - 25, y1: cy - 25, x2: cx + 25, y2: cy + 25 };
      }
      await addDimensionAtRect(rect);
    } else if (mode === 'select_area' && roiSelectRef.current) {
      roiSelectRef.current = null;
      setMode('none');
    }
  };
  /* =========================================================
     DELETE SINGLE BALLOON
  ========================================================= */

  const deleteBalloon = async (
    balloonId
  ) => {
    if (!balloonId) {
      setMessage(
        'Select a balloon first'
      );
      return;
    }

    try {
      await api.delete(
        `/balloons/${balloonId}`
      );

      // Renumber the remaining balloons sequentially (1, 2, 3, ...),
      // so deleting a balloon shifts every following one down by one.
      const remaining = balloons
        .filter(
          (item) =>
            item._id !== balloonId
        )
        .sort(
          (a, b) =>
            (a.number ?? 0) -
            (b.number ?? 0)
        );

      const numberByBalloonId = {};

      remaining.forEach(
        (balloon, index) => {
          numberByBalloonId[
            balloon._id
          ] = index + 1;
        }
      );

      for (
        let index = 0;
        index < remaining.length;
        index += 1
      ) {
        const balloon =
          remaining[index];
        const newNumber =
          index + 1;

        if (
          balloon.number ===
          newNumber
        ) {
          continue;
        }

        try {
          await api.put(
            `/balloons/${balloon._id}`,
            { number: newNumber }
          );
        } catch (error) {
          console.error(
            'Failed to renumber balloon',
            balloon._id,
            error
          );
        }

        const characteristic =
          characteristics.find(
            (item) =>
              item.balloonId ===
              balloon._id
          );

        if (characteristic) {
          try {
            await api.put(
              `/characteristics/${characteristic._id}`,
              { number: newNumber }
            );
          } catch (error) {
            console.error(
              'Failed to renumber characteristic',
              characteristic._id,
              error
            );
          }
        }
      }

      setBalloons((prev) =>
        prev
          .filter(
            (item) =>
              item._id !== balloonId
          )
          .map((item) => ({
            ...item,
            number:
              numberByBalloonId[
                item._id
              ] ?? item.number
          }))
      );

      setCharacteristics((prev) =>
        prev
          .filter(
            (item) =>
              item.balloonId !==
              balloonId
          )
          .map((item) => ({
            ...item,
            number:
              numberByBalloonId[
                item.balloonId
              ] ?? item.number
          }))
      );

      setSelectedBalloonId(null);
      setEditData(null);
      setCurrentBalloonNo('');

      setMessage(
        'Balloon removed and balloons renumbered'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Failed to remove balloon'
      );
    }
  };

  /* =========================================================
     CLEAR ALL BALLOONING
  ========================================================= */

  const clearAllBallooning = async () => {
    if (
      balloons.length === 0 &&
      characteristics.length === 0
    ) {
      setMessage(
        'There are no balloons to clear'
      );
      return;
    }

    const confirmed =
      window.confirm(
        'Are you sure you want to clear ALL ballooning? This will remove all balloons and characteristics from this project.'
      );

    if (!confirmed) {
      return;
    }

    try {
      setMessage(
        'Clearing all ballooning...'
      );

      /*
        Delete every balloon.

        Your existing backend already has:
        DELETE /balloons/:balloonId
      */

      const uniqueBalloonIds = [
        ...new Set(
          balloons
            .map((item) => item._id)
            .filter(Boolean)
        )
      ];

      for (
        const balloonId of
        uniqueBalloonIds
      ) {
        try {
          await api.delete(
            `/balloons/${balloonId}`
          );
        } catch (error) {
          console.error(
            `Failed to delete balloon ${balloonId}`,
            error
          );
        }
      }

      /*
        Clear frontend state.
      */

      setBalloons([]);
      setCharacteristics([]);
      setSelectedBalloonId(null);
      autoDetectDoneRef.current = false;

      setMessage(
        'All ballooning has been cleared'
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Failed to clear ballooning'
      );
    }
  };

  /* =========================================================
     UPDATE UNIT
  ========================================================= */

  const updateUnit = async (
    characteristicId,
    newUnit
  ) => {
    const unit =
      newUnit.trim();

    if (!unit) {
      setMessage(
        'Please enter a unit'
      );
      return;
    }

    try {
      setSavingUnitId(
        characteristicId
      );

      /*
        Immediately update screen.
      */

      setCharacteristics((prev) =>
        prev.map((item) =>
          item._id ===
            characteristicId
            ? {
              ...item,
              unit
            }
            : item
        )
      );

      /*
        Save to backend.
      */

      const updated =
        await api.put(
          `/characteristics/${characteristicId}`,
          {
            unit
          }
        );

      /*
        If backend returns updated
        characteristic, use it.
      */

      if (updated) {
        setCharacteristics((prev) =>
          prev.map((item) =>
            item._id ===
              characteristicId
              ? {
                ...item,
                ...updated
              }
              : item
          )
        );
      }

      setMessage(
        `Unit changed to "${unit}"`
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Failed to save unit'
      );

      /*
        Reload data in case backend
        rejected the update.
      */

      loadData();
    } finally {
      setSavingUnitId(null);
    }
  };

  /* =========================================================
     BALLOON EDIT PANEL (right side)
  ========================================================= */

  const syncEditFromBalloon = (balloonId) => {
    const characteristic = characteristics.find(
      (item) => item.balloonId === balloonId
    );

    if (!characteristic) return;

    setCurrentBalloonNo(String(characteristic.number ?? ''));
    setEditData({
      characteristicId: characteristic._id,
      balloonId: characteristic.balloonId,
      number: String(characteristic.number ?? ''),
      specification: characteristic.specification || '',
      value: characteristic.value || '',
      plusTolerance: characteristic.plusTolerance || '',
      minusTolerance: characteristic.minusTolerance || ''
    });
  };

  const loadCharacteristicByNumber = (rawNumber) => {
    const text = String(rawNumber ?? '').trim();

    if (!text) {
      setEditData(null);
      return;
    }

    const number = Number(text);

    if (!Number.isFinite(number)) return;

    const characteristic = characteristics.find(
      (item) => Number(item.number) === number
    );

    if (!characteristic) {
      setMessage(`No balloon with number ${number}`);
      return;
    }

    setSelectedBalloonId(characteristic.balloonId);
    syncEditFromBalloon(characteristic.balloonId);
    setMessage(`Balloon ${number} loaded`);
  };

  const handleBalloonNumberChange = (value) => {
    setCurrentBalloonNo(value);

    // Auto-load details only when nothing is currently being
    // edited, so an existing balloon's number can still be
    // changed freely.
    if (!editData) {
      loadCharacteristicByNumber(value);
    }
  };

  const handleBalloonNumberKeyDown = (event) => {
    if (event.key === 'Enter') {
      loadCharacteristicByNumber(currentBalloonNo);
    }
  };

  const saveEdit = async () => {
    if (!editData?.characteristicId) {
      setMessage('Enter a balloon number or select a balloon first');
      return;
    }

    try {
      setSavingCharacteristicId(editData.characteristicId);

      const number = Number(currentBalloonNo || editData.number);
      setEditData(prev => ({ ...prev, number: String(number) }));

      const updated = await api.put(
        `/characteristics/${editData.characteristicId}`,
        {
          number,
          specification: editData.specification,
          value: editData.value,
          plusTolerance: editData.plusTolerance,
          minusTolerance: editData.minusTolerance
        }
      );

      // Keep the balloon number on the drawing in sync
      await api.put(
        `/balloons/${editData.balloonId}`,
        { number }
      );

      if (updated) {
        setCharacteristics((prev) =>
          prev.map((item) =>
            item._id === editData.characteristicId
              ? { ...item, ...updated }
              : item
          )
        );
      }

      setBalloons((prev) =>
        prev.map((item) =>
          item._id === editData.balloonId
            ? { ...item, number }
            : item
        )
      );

      setMessage('Balloon saved');
    } catch (error) {
      console.error('Failed to save balloon:', error);
      setMessage(error.message || 'Failed to save balloon');
    } finally {
      setSavingCharacteristicId(null);
    }
  };

  // Populate the edit panel when a balloon is clicked on the drawing
  useEffect(() => {
    if (selectedBalloonId) {
      syncEditFromBalloon(selectedBalloonId);
    } else {
      setCurrentBalloonNo('');
      setEditData(null);
    }
  }, [selectedBalloonId, characteristics]);

  const exportToExcel = () => {
    const data = characteristics
      .slice()
      .sort((a, b) => Number(a.number || 0) - Number(b.number || 0))
      .map(c => ({
        'Balloon No': c.number || '',
        'Description': c.specification || '',
        'Dimensions No': c.value || '',
        'Upper Tolerance': c.plusTolerance || '',
        'Lower Tolerance': c.minusTolerance || ''
      }));

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Characteristics');
    
    // Name the file based on the project ID or just generic name
    XLSX.writeFile(workbook, `Ballooning_Report_${id || 'Export'}.xlsx`);
  };

  /* =========================================================
     DRAG BALLOON
  ========================================================= */

  const handleBalloonPointerDown = (
    event,
    balloon
  ) => {
    event.stopPropagation();

    setSelectedBalloonId(
      balloon._id
    );

    dragBalloonRef.current = {
      balloonId: balloon._id,
      lastX: event.clientX,
      lastY: event.clientY,
      initialX: event.clientX,
      initialY: event.clientY
    };

    event.currentTarget.setPointerCapture?.(
      event.pointerId
    );
  };

  const handleAnchorPointerDown = (event, balloon) => {
    event.stopPropagation();
    setSelectedBalloonId(balloon._id);
    dragBalloonRef.current = {
      balloonId: balloon._id,
      lastX: event.clientX,
      lastY: event.clientY,
      initialX: event.clientX,
      initialY: event.clientY,
      isAnchorDrag: true
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleBalloonPointerMove = (
    event
  ) => {
    const drag =
      dragBalloonRef.current;

    if (!drag || !canvasRef.current) {
      return;
    }

    const canvas =
      canvasRef.current;

    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;

    drag.lastX = event.clientX;
    drag.lastY = event.clientY;

    setBalloons((prev) =>
      prev.map((balloon) => {
        if (balloon._id !== drag.balloonId) return balloon;

        if (drag.isAnchorDrag) {
          let newAx = (balloon.anchorX ?? balloon.x + 12) + dx;
          let newAy = (balloon.anchorY ?? balloon.y + 12) + dy;
          newAx = Math.max(0, Math.min(canvas.width, newAx));
          newAy = Math.max(0, Math.min(canvas.height, newAy));
          return { ...balloon, anchorX: newAx, anchorY: newAy };
        } else {
          let newX = balloon.x + dx;
          let newY = balloon.y + dy;
          newX = Math.max(0, Math.min(canvas.width, newX));
          newY = Math.max(0, Math.min(canvas.height, newY));
          return { ...balloon, x: newX, y: newY };
        }
      })
    );
  };

  const handleBalloonPointerUp =
    async () => {
      const drag =
        dragBalloonRef.current;

      if (!drag) return;

      dragBalloonRef.current =
        null;

      const balloon =
        balloons.find(
          (item) =>
            item._id ===
            drag.balloonId
        );

      if (!balloon) return;
      
      const movedDistance = Math.hypot(event.clientX - drag.initialX, event.clientY - drag.initialY);
      if (movedDistance < 5) return; // Didn't actually drag, just clicked

      try {
        /*
          When the balloon is dropped onto a
          measurement, re-read that value from
          the drawing and auto-fetch it into
          the characteristic table.
        */

        let fetchedDimension =
          null;

        try {
          /*
            Read at the arrow's anchor point (where the
            balloon is pointing), not at the balloon marker
            itself, so it picks up the value it points at.
          */

          const readX =
            balloon.anchorX ??
            balloon.x + 12;

          const readY =
            balloon.anchorY ??
            balloon.y + 12;

          fetchedDimension =
            await readDimensionAtPoint(
              readX,
              readY
            );
        } catch (readError) {
          console.error(
            'Failed to read dimension at drop point:',
            readError
          );
        }

        const characteristic =
          characteristics.find(
            (item) =>
              item.balloonId ===
              balloon._id
          );

        if (fetchedDimension) {
          const updatedBalloon =
            await api.put(
              `/balloons/${balloon._id}`,
              {
                x: balloon.x,
                y: balloon.y,

                /*
                  Re-anchor the arrow at the
                  new measurement.
                */

                anchorX:
                  fetchedDimension.centerX,

                anchorY:
                  fetchedDimension.centerY,

                text:
                  fetchedDimension.text,

                type:
                  fetchedDimension.type
              }
            );

          if (characteristic) {
            const updatedCharacteristic =
              await api.put(
                `/characteristics/${characteristic._id}`,
                {
                  type:
                    fetchedDimension.type,

                  value:
                    fetchedDimension.value,

                  plusTolerance:
                    fetchedDimension.plusTolerance,

                  minusTolerance:
                    fetchedDimension.minusTolerance,

                  upperLimit:
                    fetchedDimension.upperLimit,

                  lowerLimit:
                    fetchedDimension.lowerLimit,

                  specification:
                    fetchedDimension.specification,

                  x: balloon.x,
                  y: balloon.y
                }
              );

            setCharacteristics(
              (prev) =>
                prev.map((item) =>
                  item._id ===
                    characteristic._id
                    ? {
                      ...updatedCharacteristic
                    }
                    : item
                )
            );
          }

          setBalloons((prev) =>
            prev.map((item) =>
              item._id ===
                balloon._id
                ? {
                  ...item,
                  ...updatedBalloon
                }
                : item
            )
          );

          setMessage(
            `Balloon ${balloon.number}: ${fetchedDimension.specification} fetched into the characteristic table`
          );
        } else {
          await api.put(
            `/balloons/${balloon._id}`,
            {
              x: balloon.x,
              y: balloon.y,
              anchorX: balloon.anchorX,
              anchorY: balloon.anchorY
            }
          );

          // Also update characteristic position
          if (characteristic) {
            setCharacteristics(
              (prev) =>
                prev.map((item) =>
                  item._id ===
                    characteristic._id
                    ? {
                      ...item,
                      x: balloon.x,
                      y: balloon.y
                    }
                    : item
                )
            );

            await api.put(
              `/characteristics/${characteristic._id}`,
              {
                x: balloon.x,
                y: balloon.y
              }
            );
          }

          setMessage(
            `Balloon ${balloon.number} moved`
          );
        }
      } catch (error) {
        console.error(
          'Failed to save balloon position:',
          error
        );

        setMessage(
          error.message ||
          'Failed to save balloon position'
        );
      }
    };

  /* =========================================================
     DIMENSION READING (shared by balloon drop + Add Dimension)
     ---------------------------------------------------------
     collectDimensionItems  - reads the PDF text layer
     findNearestDimension   - nearest characteristic to a point
     parseNearestDimension  - value / tolerances / limits
     ocrReadRegion          - OCR fallback for scanned drawings
     scanDimensionInRect    - used by the Add Dimension tool
     readDimensionAtPoint   - used when a balloon is dropped
  ========================================================= */

  const collectDimensionItems = async () => {
    if (!pdfPage) {
      return [];
    }

    const baseViewport =
      pdfPage.getViewport({
        scale: 1
      });

    let displayScale = 1;

    if (canvasRef.current) {
      displayScale =
        canvasRef.current.width /
        baseViewport.width;
    }

    const textContent =
      await pdfPage.getTextContent();

    const items = [];

    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) {
        continue;
      }

      const text =
        normalizeDetectionText(item.str);

      if (!isDetectionText(text)) {
        continue;
      }

      const point =
        baseViewport.convertToViewportPoint(
          item.transform?.[4] || 0,
          item.transform?.[5] || 0
        );

      // Removed region constraints so users can manually balloon anything anywhere

      items.push({
        text,

        x:
          point[0] * displayScale,

        y:
          point[1] * displayScale,

        width:
          Number(item.width || 0) *
          displayScale,

        height:
          Number(item.height || 0) *
          displayScale,

        confidence: 1,

        source: 'pdf'
      });
    }

    return items;
  };

  const findNearestDimension = (
    items,
    pointX,
    pointY,
    maxDistance = 150
  ) => {
    let nearest = null;
    let nearestDistance = Infinity;

    for (const item of items) {
      const dx =
        detectionCenterX(item) - pointX;

      const dy =
        detectionCenterY(item) - pointY;

      const distance = Math.sqrt(
        dx * dx + dy * dy
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = item;
      }
    }

    if (
      !nearest ||
      nearestDistance > maxDistance
    ) {
      return null;
    }

    return nearest;
  };

  const parseNearestDimension = (
    items,
    nearest
  ) => {
    let text =
      normalizeDetectionText(nearest.text);

    const standaloneSymbols = items.filter(item => DETECTION_PATTERNS.symbol.test(normalizeDetectionText(item.text)));
    const nearbySymbols = standaloneSymbols.filter(sym => {
      const xDiff = nearest.x - sym.x; 
      const yDiff = Math.abs(nearest.y - sym.y);
      return xDiff > -20 && xDiff < (nearest.width || 30) * 3 && yDiff < 30;
    });
    
    if (nearbySymbols.length > 0) {
      text = normalizeDetectionText(nearbySymbols[0].text + text);
    }

    let plusTolerance = '0.00';
    let minusTolerance = '0.00';
    let cleanedValue = text;

    const plusMinusMatch =
      text.match(
        /^\s*(?:Ø\s*)?(\d+(?:\.\d+)?)(?:\s*[A-Za-z0-9]+)*\s*(?:±|\+\/-|\+-|\+\s*-)\s*(\d+(?:\.\d+)?)/i
      );

    const bilateralMatch =
      text.match(
        /^\s*(?:Ø\s*)?(\d+(?:\.\d+)?)(?:\s*[A-Za-z0-9]+)*\s*\+(\d+(?:\.\d+)?)\s*\/\s*-(\d+(?:\.\d+)?)/i
      );

    if (plusMinusMatch) {
      cleanedValue = plusMinusMatch[1];
      plusTolerance = plusMinusMatch[2];
      minusTolerance = plusMinusMatch[2];
    }

    if (bilateralMatch) {
      cleanedValue = bilateralMatch[1];
      plusTolerance = bilateralMatch[2];
      minusTolerance = bilateralMatch[3];
    }

    const diameterMatch =
      text.match(/Ø\s*(\d+(?:\.\d+)?)/i);

    if (
      diameterMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = diameterMatch[1];
    }

    const radiusMatch =
      text.match(/R\s*(\d+(?:\.\d+)?)/i);

    if (
      radiusMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = radiusMatch[1];
    }

    const numericMatch =
      text.match(
        /^\s*(\d+(?:\.\d+)?)\s*(?:mm|in|inch|inches)?\s*$/i
      );

    if (
      numericMatch &&
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      cleanedValue = numericMatch[1];
    }

    /*
      Hole / fit callout such as "25 H7" or "Ø 25 H7/g6".
      Fall back to the first number.
    */

    if (
      !plusMinusMatch &&
      !bilateralMatch &&
      !diameterMatch &&
      !radiusMatch &&
      !numericMatch
    ) {
      const firstNumber =
        text.match(
          /^\s*(?:(?:Ø|R|SØ|SR|M|∅|Q|O|o|0|↧|v|V|⌴|U|u|⌵|x|X|×|\d+\s*[xX×])\s*)*(\d+(?:\.\d+)?)/
        );

      if (firstNumber) {
        cleanedValue = firstNumber[1];
      }
    }

    // Combine a standalone tolerance that sits right
    // next to the value (16 / 0.05 / 0.03).
    if (
      !plusMinusMatch &&
      !bilateralMatch
    ) {
      const standaloneTolerances =
        items.filter((item) =>
          DETECTION_PATTERNS.smallTolerance.test(
            normalizeDetectionText(item.text)
          )
        );

      const isNearbyTolerance = (
        dimension,
        tolerance
      ) => {
        const xDifference =
          Math.abs(
            detectionCenterX(dimension) -
            detectionCenterX(tolerance)
          );

        const yDifference =
          Math.abs(
            dimension.y -
            tolerance.y
          );

        const maxXDistance =
          Math.max(
            45,
            (dimension.width || 20) * 2.5
          );

        const maxYDistance =
          Math.max(
            60,
            (dimension.height || 12) * 4
          );

        return (
          xDifference <= maxXDistance &&
          yDifference <= maxYDistance
        );
      };

      const nearby = standaloneTolerances
        .filter((tolerance) =>
          isNearbyTolerance(nearest, tolerance)
        )
        .sort((a, b) => a.y - b.y)
        .slice(0, 2);

      const getToleranceNumber = (
        targetItem
      ) => {
        let text =
          normalizeDetectionText(
            targetItem.text
          );

        const standaloneSymbols = items.filter(item => DETECTION_PATTERNS.symbol.test(normalizeDetectionText(item.text)));
        const nearbySymbols = standaloneSymbols.filter(sym => {
          const xDiff = targetItem.x - sym.x; 
          const yDiff = Math.abs(targetItem.y - sym.y);
          return xDiff > -20 && xDiff < (targetItem.width || 30) * 3 && yDiff < 30;
        });
        
        if (nearbySymbols.length > 0) {
          text = normalizeDetectionText(nearbySymbols[0].text + text);
        }

        const match = text.match(/[+-]?\s*(0?\.\d{1,3})/);

        return match
          ? Number(match[1])
          : null;
      };

      if (nearby.length === 1) {
        const toleranceValue =
          getToleranceNumber(nearby[0].text);

        if (
          Number.isFinite(toleranceValue)
        ) {
          plusTolerance =
            toleranceValue.toFixed(3);

          minusTolerance =
            toleranceValue.toFixed(3);
        }
      }

      if (nearby.length >= 2) {
        const firstValue =
          getToleranceNumber(nearby[0].text);

        const secondValue =
          getToleranceNumber(nearby[1].text);

        if (
          Number.isFinite(firstValue) &&
          Number.isFinite(secondValue)
        ) {
          const firstHasPlus =
            /^\+/.test(
              normalizeDetectionText(nearby[0].text)
            );

          const firstHasMinus =
            /^-/.test(
              normalizeDetectionText(nearby[0].text)
            );

          const secondHasPlus =
            /^\+/.test(
              normalizeDetectionText(nearby[1].text)
            );

          const secondHasMinus =
            /^-/.test(
              normalizeDetectionText(nearby[1].text)
            );

          if (firstHasPlus && secondHasMinus) {
            plusTolerance = firstValue.toFixed(3);
            minusTolerance = secondValue.toFixed(3);
          } else if (
            firstHasMinus &&
            secondHasPlus
          ) {
            plusTolerance = secondValue.toFixed(3);
            minusTolerance = firstValue.toFixed(3);
          } else {
            plusTolerance = firstValue.toFixed(3);
            minusTolerance = secondValue.toFixed(3);
          }
        }
      }
    }

    let type = 'Dimension';

    if (/^\s*Ø/.test(text)) {
      type = 'Diameter';
    } else if (/^\s*R\s*\d/.test(text)) {
      type = 'Radius';
    }

    let prefix = '';
    const prefixMatch = text.match(/^\s*(Ø|R|SØ|SR|M|∅)/i);
    if (prefixMatch) {
      prefix = prefixMatch[1].toUpperCase();
    }
    const value = String(cleanedValue).toUpperCase().startsWith(prefix) 
      ? cleanedValue 
      : prefix + cleanedValue;

    const numericValue = Number(value);
    const plus = Number(plusTolerance);
    const minus = Number(minusTolerance);

    let upperLimit = '0.00';
    let lowerLimit = '0.00';

    if (Number.isFinite(numericValue)) {
      upperLimit = (
        numericValue +
        (Number.isFinite(plus) ? plus : 0)
      ).toFixed(3);

      lowerLimit = (
        numericValue -
        (Number.isFinite(minus) ? minus : 0)
      ).toFixed(3);
    }

    let specification = text;

    if (!plusMinusMatch && !bilateralMatch) {
      if (
        plusTolerance !== '0.00' ||
        minusTolerance !== '0.00'
      ) {
        specification =
          plusTolerance === minusTolerance
            ? `${text} ±${plusTolerance}`
            : `${text} +${plusTolerance}/-${minusTolerance}`;
      }
    }

    return {
      text,
      value,
      type,
      plusTolerance,
      minusTolerance,
      upperLimit,
      lowerLimit,
      specification,
      centerX: detectionCenterX(nearest),
      centerY: detectionCenterY(nearest)
    };
  };

  /* Re-read when a balloon is dropped onto a measurement. */

  const readDimensionAtPoint = async (
    pointX,
    pointY
  ) => {
    if (!pdfPage) {
      return null;
    }

    const items =
      await collectDimensionItems();

    if (items.length === 0) {
      return null;
    }

    const nearest = findNearestDimension(
      items,
      pointX,
      pointY,
      70
    );

    if (!nearest) {
      return null;
    }

    return parseNearestDimension(
      items,
      nearest
    );
  };

  /* OCR fallback for scanned drawings without a text layer. */

  
const extractOcrWords = (data) => {
  const words = [];
  if (data && data.blocks) {
    data.blocks.forEach(block => {
      if (block.paragraphs) {
        block.paragraphs.forEach(para => {
          if (para.lines) {
            para.lines.forEach(line => {
              if (line.words) {
                words.push(...line.words);
              }
            });
          }
        });
      }
    });
  }
  return words;
};

  const ocrReadRegion = async (rect) => {
    if (!pdfPage) {
      return [];
    }

    try {
      const baseViewport =
        pdfPage.getViewport({
          scale: 1
        });

      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      const ocrScale = 3.5;

      const viewport =
        pdfPage.getViewport({
          scale: ocrScale
        });

      const fullCanvas =
        document.createElement('canvas');

      fullCanvas.width =
        Math.ceil(viewport.width);

      fullCanvas.height =
        Math.ceil(viewport.height);

      const ctx =
        fullCanvas.getContext('2d');

      ctx.filter =
        'grayscale(1) contrast(160%) brightness(105%)';

      await pdfPage.render({
        canvasContext: ctx,
        viewport
      }).promise;

      const margin = 10;
      const ratio = ocrScale / displayScale;

      const sx =
        Math.max(0, (rect.x1 - margin) * ratio);

      const sy =
        Math.max(0, (rect.y1 - margin) * ratio);

      const sw =
        (rect.x2 - rect.x1 + margin * 2) * ratio;

      const sh =
        (rect.y2 - rect.y1 + margin * 2) * ratio;

      if (sw <= 0 || sh <= 0) {
        return [];
      }

      const crop =
        document.createElement('canvas');

      crop.width = Math.ceil(sw);
      crop.height = Math.ceil(sh);

      const cropContext = crop.getContext('2d');

      cropContext.drawImage(
        fullCanvas,
        sx,
        sy,
        sw,
        sh,
        0,
        0,
        sw,
        sh
      );


      let words = [];
      if (!ocrWorkerRef.current) {
        ocrWorkerRef.current = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/tesseract-core.wasm.js', langPath: '/tesseract' });
      }
      let { data } = await ocrWorkerRef.current.recognize(crop, {}, { blocks: true });
      words = extractOcrWords(data).map(w => ({
        text: w.text,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        confidence: w.confidence
      }));

      const hasValidText = words.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\d)/gi, '�').replace(/^0(?=\d)/, '�')));
      if (!hasValidText && words.length <= 2) {
        // Try counter-clockwise rotation (bottom-to-top text)
        const rotCanvas = document.createElement('canvas');
        rotCanvas.width = crop.height;
        rotCanvas.height = crop.width;
        const rctx = rotCanvas.getContext('2d');
        rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
        rctx.rotate(-Math.PI / 2);
        rctx.drawImage(crop, -crop.width / 2, -crop.height / 2);
        
        const { data: rotData } = await ocrWorkerRef.current.recognize(rotCanvas, {}, { blocks: true });
        const rotWords = extractOcrWords(rotData).map(w => ({
          text: w.text,
          bbox: {
            x0: crop.width - w.bbox.y1,
            y0: w.bbox.x0,
            x1: crop.width - w.bbox.y0,
            y1: w.bbox.x1
          },
          confidence: w.confidence
        }));
        
        if (rotWords.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\d)/gi, '�').replace(/^0(?=\d)/, '�')))) {
          words = rotWords;
        } else {
          // Try clockwise rotation (top-to-bottom text)
          const rotCanvas2 = document.createElement('canvas');
          rotCanvas2.width = crop.height;
          rotCanvas2.height = crop.width;
          const rctx2 = rotCanvas2.getContext('2d');
          rctx2.translate(rotCanvas2.width / 2, rotCanvas2.height / 2);
          rctx2.rotate(Math.PI / 2);
          rctx2.drawImage(crop, -crop.width / 2, -crop.height / 2);
          
          const { data: rotData2 } = await ocrWorkerRef.current.recognize(rotCanvas2, {}, { blocks: true });
          const rotWords2 = extractOcrWords(rotData2).map(w => ({
            text: w.text,
            bbox: {
              x0: w.bbox.y0,
              y0: crop.height - w.bbox.x1,
              x1: w.bbox.y1,
              y1: crop.height - w.bbox.x0
            },
            confidence: w.confidence
          }));
          if (rotWords2.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\d)/gi, '�').replace(/^0(?=\d)/, '�')))) {
             words = rotWords2;
          }
        }
      }

      const items = [];

      for (const word of words) {
        if (!word.text || !word.text.trim()) {
          continue;
        }

        let text = normalizeDetectionText(
          word.text
        )
          .replace(/O(?=\d)/gi, 'Ø')
          .replace(/^0(?=\d)/, 'Ø');

        if (!isDetectionText(text)) {
          continue;
        }

        const wx = word.bbox?.x0 || 0;
        const wy = word.bbox?.y0 || 0;
        const ww =
          (word.bbox?.x1 - word.bbox?.x0) || 0;

        const wh =
          (word.bbox?.y1 - word.bbox?.y0) || 0;

        items.push({
          text,

          x: sx / ratio + wx / ratio,
          y: sy / ratio + wy / ratio,

          width: ww / ratio,
          height: wh / ratio,

          confidence:
            Number(word.confidence || 0),

          source: 'ocr'
        });
      }

      return items;
    } catch (error) {
      console.error(
        'Region OCR failed:',
        error
      );

      return [];
    }
  };

  /* Add Dimension scan: read inside the selected rectangle. */

  
    const analyzeArea = async (rect) => {
        if (!pdfPage) return;
        const minX = Math.min(rect.x1, rect.x2);
        const maxX = Math.max(rect.x1, rect.x2);
        const minY = Math.min(rect.y1, rect.y2);
        const maxY = Math.max(rect.y1, rect.y2);

        let detected = [];
        
        try {
            const viewport = pdfPage.getViewport({ scale: 1 });
            const textContent = await pdfPage.getTextContent();
            let displayScale = 1;
            if (canvasRef.current) displayScale = canvasRef.current.width / viewport.width;

            for (const item of textContent.items) {
                if (!item.str || !item.str.trim()) continue;
                
                // Convert PDF coordinate to Canvas space
                const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
                const itemX = tx[4] * displayScale;
                const itemY = tx[5] * displayScale;
                const itemW = item.width * displayScale;
                const itemH = item.height * displayScale;
                const centerX = itemX + itemW / 2;
                const centerY = itemY - itemH / 2;

                if (centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY) {
                    detected.push({
                        text: item.str.trim(),
                        x: itemX,
                        y: itemY,
                        width: itemW,
                        height: itemH,
                        confidence: 100,
                        source: 'pdf'
                    });
                }
            }
        } catch (e) {
            console.error("PDF text extraction failed", e);
        }

        const hasValidPdfText = detected.some(item => detectPatterns(item.text) !== null);

        if (!hasValidPdfText && typeof ocrReadRegion === 'function') {
            try {
                const ocrItems = await ocrReadRegion(rect);
                // ocrReadRegion already returns coordinates in absolute Canvas Space (sx / ratio applied internally).
                // So we just map them directly into our detected array!
                for (const item of ocrItems) {
                    detected.push({
                        text: item.text.trim(),
                        x: item.x,
                        y: item.y,
                        width: item.width,
                        height: item.height,
                        confidence: item.confidence || 80,
                        source: 'ocr'
                    });
                }
            } catch (e) {
                console.error("OCR fallback failed", e);
            }
        }

        let finalDetected = clusterDetectionsIntoDimensions(detected);

        finalDetected = finalDetected.map(item => {
            const match = detectPatterns(item.text);
            if (match) {
                return { ...item, type: match.type, specification: item.text, confidence: 100 };
            }
            return item;
        }).filter(item => detectPatterns(item.text) !== null);

        setPreviewDetections(finalDetected);
    };

  const scanDimensionInRect = async (rect) => {
    if (!pdfPage) {
      return null;
    }

    const items =
      await collectDimensionItems();

    if (items.length > 0) {
      const centerX =
        (rect.x1 + rect.x2) / 2;

      const centerY =
        (rect.y1 + rect.y2) / 2;

      let target = null;

      // Prefer a real dimension value over a lone
      // tolerance like "0.05" when both sit inside the box.
      const hasBaseValue = (item) =>
        !DETECTION_PATTERNS.smallTolerance.test(
          item.text
        );

      const inside = items
        .filter((item) => {
          const itemX =
            detectionCenterX(item);

          const itemY =
            detectionCenterY(item);

          return (
            itemX >= rect.x1 &&
            itemX <= rect.x2 &&
            itemY >= rect.y1 &&
            itemY <= rect.y2
          );
        })
        .sort((a, b) => {
          const distanceA = Math.hypot(
            detectionCenterX(a) - centerX,
            detectionCenterY(a) - centerY
          );

          const distanceB = Math.hypot(
            detectionCenterX(b) - centerX,
            detectionCenterY(b) - centerY
          );

          if (
            hasBaseValue(a) !==
            hasBaseValue(b)
          ) {
            return hasBaseValue(a) ? -1 : 1;
          }

          return distanceA - distanceB;
        });

      if (inside.length > 0) {
        // Sort geographically for reading order: top-to-bottom, left-to-right
        inside.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
          return a.x - b.x;
        });
        const combinedText = inside.map(i => i.text).join(' ');
        target = {
          ...inside[0],
          text: combinedText
        };
      } else {
        target = findNearestDimension(
          items,
          centerX,
          centerY,
          70
        );
      }

      if (target) {
        let pdfResult = {
          ...parseNearestDimension(items, target),
          source: 'pdf',
          confidence: 1
        };

        // CAD PDFs often draw symbols (like Ø) as vector graphics while keeping the number as text.
        // If the PDF result is a pure number without a symbol, let's run OCR to see if we missed a symbol!
        if (/^\d+(?:\.\d+)?$/.test(pdfResult.value)) {
          console.log("PDF text is a pure number. Running OCR to check for vector-drawn symbols...");
          const ocrItems = await ocrReadRegion(rect);
          if (ocrItems.length > 0) {
            const ocrTarget = findNearestDimension(ocrItems, centerX, centerY, 70);
            if (ocrTarget) {
              const ocrResult = parseNearestDimension(ocrItems, ocrTarget);
              // If OCR found a symbol like Ø13, use it!
              if (ocrResult && ocrResult.value && !/^\d+(?:\.\d+)?$/.test(ocrResult.value)) {
                 pdfResult.value = ocrResult.value;
                 pdfResult.specification = ocrResult.specification || pdfResult.specification;
                 console.log("OCR rescued vector symbol:", ocrResult.value);
              }
            }
          }
        }

        return pdfResult;
      }
    }

    const ocrItems =
      await ocrReadRegion(rect);

    if (ocrItems.length > 0) {
      const centerX = (rect.x1 + rect.x2) / 2;
      const centerY = (rect.y1 + rect.y2) / 2;

      // Filter OCR items that are geometrically inside the rectangle
      const inside = ocrItems.filter((item) => {
        const itemX = detectionCenterX(item);
        const itemY = detectionCenterY(item);
        return itemX >= rect.x1 && itemX <= rect.x2 && itemY >= rect.y1 && itemY <= rect.y2;
      });

      let target = null;
      if (inside.length > 0) {
        inside.sort((a, b) => {
          if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
          return a.x - b.x;
        });
        const combinedText = inside.map(i => i.text).join(' ');
        target = { ...inside[0], text: combinedText };
      } else {
        target = findNearestDimension(ocrItems, centerX, centerY, 90);
      }

      if (target) {
        return {
          ...parseNearestDimension(ocrItems, target),
          source: 'ocr',
          confidence: target.confidence
        };
      }
    }

    return null;
  };

  /* =========================================================
     UPLOAD DRAWING
  ========================================================= */

  const uploadDrawing = async (
    event
  ) => {
    const selected =
      event.target.files?.[0];

    if (!selected) return;

    if (
      !selected.name
        .toLowerCase()
        .endsWith('.pdf') &&
      !selected.type.includes('pdf')
    ) {
      setMessage(
        'Please select a PDF drawing'
      );
      return;
    }

    try {
      setUploading(true);
      setMessage(
        'Uploading drawing...'
      );

      const formData =
        new FormData();

      formData.append(
        'drawing',
        selected
      );

      const data =
        await api.upload(
          `/projects/${id}/drawing`,
          formData
        );

      const drawingEntry = {
        ...data,
        url:
          data.filePath ||
          data.url
      };

      setDrawings((prev) => [
        drawingEntry,
        ...prev
      ]);

      setSelectedDrawingId(
        drawingEntry._id
      );

      setMessage(
        'Drawing uploaded successfully'
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error.message ||
        'Drawing upload failed'
      );
    } finally {
      setUploading(false);

      event.target.value = '';
    }
  };

  /* =========================================================
     DELETE DRAWING
  ========================================================= */

  const deleteDrawing = async (
    drawingId
  ) => {
    if (!drawingId) return;

    try {
      await api.delete(
        `/projects/${id}/drawings/${drawingId}`
      );

      setDrawings((prev) => {
        const remaining =
          prev.filter(
            (item) =>
              item._id !== drawingId
          );

        if (
          selectedDrawingId ===
          drawingId
        ) {
          setSelectedDrawingId(
            remaining.length > 0
              ? remaining[0]._id
              : null
          );
        }

        return remaining;
      });

      setConfirmDeleteDrawingId(
        null
      );

      setActiveDrawingMenuId(
        null
      );

      setMessage(
        'Drawing deleted'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Failed to delete drawing'
      );
    }
  };

  /* =========================================================
     RENAME DRAWING
  ========================================================= */

  const renameDrawing = async (
    drawingId,
    newName
  ) => {
    if (
      !drawingId ||
      !newName
    ) {
      return;
    }

    try {
      const updated =
        await api.put(
          `/projects/${id}/drawings/${drawingId}`,
          {
            fileName: newName
          }
        );

      setDrawings((prev) =>
        prev.map((item) =>
          item._id ===
            updated._id
            ? {
              ...updated,
              url:
                updated.filePath ||
                updated.url
            }
            : item
        )
      );

      setActiveDrawingMenuId(
        null
      );

      setMessage(
        'Drawing renamed'
      );
    } catch (error) {
      setMessage(
        error.message ||
        'Rename failed'
      );
    }
  };

  /* =========================================================
     PAGE NAVIGATION
  ========================================================= */

  const previousPage = () => {
    setPageNumber((page) =>
      Math.max(1, page - 1)
    );
  };

  const nextPage = () => {
    setPageNumber((page) =>
      Math.min(
        pageCount,
        page + 1
      )
    );
  };

  /* =========================================================
   SMART DETECTION CLEANUP
   ---------------------------------------------------------
   Removes duplicate readings and joins nearby tolerance
   text with its parent dimension.
========================================================= */

  const cleanAndGroupDetections = (detections) => {
    if (!detections || detections.length === 0) {
      return [];
    }

    const normalize = (value) =>
      String(value || '')
        .replace(/[−–—]/g, '-')
        .replace(/[＋]/g, '+')
        .replace(/[Øø]/g, 'Ø')
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/\s+/g, ' ')
        .trim();

    const getNumber = (text) => {
      const match = normalize(text).match(
        /(?:Ø\s*|R\s*)?(\d+(?:\.\d+)?)/i
      );

      return match ? match[1] : null;
    };

    const isToleranceOnly = (text) => {
      const value = normalize(text);

      return (
        /^(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^[+]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^[+-]?\s*0?\.\d{1,3}$/i.test(value)
      );
    };

    const isFullTolerance = (text) => {
      const value = normalize(text);

      return (
        /^\d+(?:\.\d+)?\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^\d+(?:\.\d+)?\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?$/i.test(value)
      );
    };

    const isDimension = (text) => {
      const value = normalize(text);

      return (
        /^Ø\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^R\s*\d+(?:\.\d+)?$/i.test(value) ||
        /^\d+(?:\.\d+)?(?:\s*(?:mm|in|inch|inches))?$/i.test(value)
      );
    };

    const center = (item) => ({
      x:
        Number(item.x || 0) +
        Number(item.width || 0) / 2,

      y:
        Number(item.y || 0) +
        Number(item.height || 0) / 2
    });

    const distance = (a, b) => {
      const ca = center(a);
      const cb = center(b);

      return Math.sqrt(
        Math.pow(ca.x - cb.x, 2) +
        Math.pow(ca.y - cb.y, 2)
      );
    };

    const sameLocation = (a, b) => {
      const d = distance(a, b);

      const sizeA = Math.max(
        Number(a.width || 0),
        Number(a.height || 0),
        10
      );

      const sizeB = Math.max(
        Number(b.width || 0),
        Number(b.height || 0),
        10
      );

      return d <= Math.max(12, Math.min(sizeA, sizeB) * 1.8);
    };

    /*
       STEP 1
       Normalize all text.
    */

    const normalized = detections
      .map((item) => ({
        ...item,
        text: normalize(item.text)
      }))
      .filter((item) => item.text);

    /*
       STEP 2
       Remove exact duplicate readings that are
       physically at the same location.
    */

    const unique = [];

    for (const item of normalized) {
      const duplicate = unique.some((existing) => {
        return (
          normalize(existing.text) ===
          normalize(item.text) &&
          sameLocation(existing, item)
        );
      });

      if (!duplicate) {
        unique.push(item);
      }
    }

    /*
       STEP 3
       Join tolerance-only text with the nearest
       dimension.
  
       Example:
  
         25
         ±0.05
  
       becomes:
  
         25 ±0.05
  
       Instead of two balloons.
    */

    const used = new Set();
    const grouped = [];

    for (let i = 0; i < unique.length; i++) {
      if (used.has(i)) {
        continue;
      }

      const current = unique[i];

      /*
         If this is already a complete reading,
         keep it as one characteristic.
      */

      if (isFullTolerance(current.text)) {
        grouped.push(current);
        used.add(i);
        continue;
      }

      /*
         If this is a normal dimension, search
         for a nearby tolerance.
      */

      if (isDimension(current.text)) {
        let bestToleranceIndex = -1;
        let bestDistance = Infinity;

        for (let j = 0; j < unique.length; j++) {
          if (i === j || used.has(j)) {
            continue;
          }

          const candidate = unique[j];

          if (!isToleranceOnly(candidate.text)) {
            continue;
          }

          const d = distance(
            current,
            candidate
          );

          /*
             Tolerance should be physically close
             to the dimension.
  
             The 45px value is deliberately limited
             so unrelated dimensions don't merge.
          */

          if (d < 45 && d < bestDistance) {
            bestDistance = d;
            bestToleranceIndex = j;
          }
        }

        if (bestToleranceIndex !== -1) {
          const tolerance =
            unique[bestToleranceIndex];

          let toleranceText =
            normalize(tolerance.text);

          /*
             Convert:
  
             0.02
  
             into:
  
             ±0.02
  
             ONLY when it is clearly attached
             to a dimension.
          */

          if (
            /^0?\.\d{1,3}$/i.test(
              toleranceText
            )
          ) {
            toleranceText =
              `±${toleranceText}`;
          }

          grouped.push({
            ...current,

            text:
              `${current.text} ${toleranceText}`,

            width:
              Math.max(
                Number(current.width || 0),
                Number(tolerance.width || 0)
              ),

            height:
              Math.max(
                Number(current.height || 0),
                Number(tolerance.height || 0)
              )
          });

          used.add(i);
          used.add(bestToleranceIndex);

          continue;
        }
      }

      /*
         Otherwise keep the original detection.
      */

      grouped.push(current);
      used.add(i);
    }

    /*
       STEP 4
       Final safety check.
  
       Never allow two characteristics to
       occupy essentially the same location.
    */

    const finalResult = [];

    for (const item of grouped) {
      const duplicate = finalResult.some(
        (existing) => {
          if (
            normalize(existing.text) ===
            normalize(item.text)
          ) {
            return sameLocation(
              existing,
              item
            );
          }

          /*
             If two different OCR readings are
             almost exactly on top of each other,
             keep only one.
          */

          return distance(
            existing,
            item
          ) < 8;
        }
      );

      if (!duplicate) {
        finalResult.push(item);
      }
    }

    return finalResult;
  };

  /* =========================================================
   AUTO DETECTION
   Detect engineering dimensions + grouped tolerances

   SUPPORTED:
   ---------------------------------------------------------
   1. 25
   2. Ø20
   3. R10
   4. 25 ±0.05
   5. 25 +0.05/-0.03
   6. 25
        +0.05
        -0.03

   IMPORTANT:
   Nearby tolerance values are grouped with the
   main dimension and DO NOT create separate balloons.
========================================================= */

  const autoDetect = async () => {
    if (!pdfPage) {
      setMessage('Please upload a PDF first');
      return;
    }

    if (autoDetectDoneRef.current && !roiRect) {
      setMessage(
        'Detection already complete. Select an area first (using "Select Area") to detect a different part, or use "Clear All Ballooning" to start over.'
      );
      return;
    }

    try {
      setAutoDetecting(true);
      setMode('auto');

      setMessage('Analyzing engineering drawing...');

      /* =========================================================
         1. PDF PAGE INFORMATION
      ========================================================= */

      const baseViewport = pdfPage.getViewport({
        scale: 1
      });

      let displayScale = 1;

      if (canvasRef.current) {
        displayScale =
          canvasRef.current.width /
          baseViewport.width;
      }

      /* =========================================================
         2. DETECTION REGEX
      ========================================================= */

      const tolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?(?:\s*[A-Za-z0-9]+)*\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const bilateralTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?(?:\s*[A-Za-z0-9]+)*\s*[+＋]\s*\d+(?:\.\d+)?\s*\/\s*[-−]\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const unilateralTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?\s*[+＋\-−]\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const diameterPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:C\/BORE\s*)?Ø\s*\d+(?:\.\d+)?(?:(?:\s*[x×]\s*\d+(?:\.\d+)?)?(?:\s*DP)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const radiusPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:SR|CR)?\s*R\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const dimensionPattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?(?:\s*(?:mm|in|inch|inches))?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const fitPattern =
        /^\s*(?:\d+[Xx*]\s*)?(?:Ø\s*)?\d+(?:\.\d+)?\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?(?:\s*(?:±|\+\/-|\+-|\+\s*-)\s*\d+(?:\.\d+)?)?(?:\s*[+＋]\s*\d+(?:\.\d+)?\s*\/?\s*[-−]?\s*\d+(?:\.\d+)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const anglePattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?\s*°\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const angleTolerancePattern =
        /^\s*(?:\d+[Xx*]\s*)?\d+(?:\.\d+)?\s*°\s*±\s*\d+(?:\.\d+)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const angularToleranceLinePattern =
        /^\s*±\s*\d+(?:\.\d+)?\s*°\s*$/i;

      const bareFitPattern =
        /^\s*[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i;

      const threadPattern =
        /^\s*(?:\d+[Xx*]\s*)?M\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?)?\s*(?:THRU|TYP|REF|BSC|DP|MAX|MIN|C\/BORE|C\/SINK|DEEP|HOLES|PLACES|PLCS|\(.*?\))*\s*$/i;

      const datumFeaturePattern =
        /^\s*\d+(?:\.\d+)?\s*[A-Z]\s*$/i;

      /*
        Standalone small tolerance.
      */
      const smallTolerancePattern =
        /^\s*[+-±]?\s*0?\.\d{1,3}\s*$/;

      /* =========================================================
         3. NORMALIZE TEXT
      ========================================================= */

      const normalizeText = (value) => {
        return String(value || '')
          .replace(/[−–—]/g, '-')
          .replace(/[＋]/g, '+')
          .replace(/[Øø]/g, 'Ø')
          .replace(/^[OQo](?=\d)/, 'Ø') // Fix O/Q misread as diameter
          .replace(/^0(?=[1-9])/, 'Ø') // Fix 0 misread as diameter (022 -> Ø22)
          .replace(/(\d),(\d)/g, '$1.$2')
          .replace(/\s+/g, ' ')
          .replace(/\s*\.\s*/g, '.') // Remove spaces around decimal
          .replace(/\s*\+\s*/g, '+') // Remove spaces around plus
          .replace(/\s*\-\s*/g, '-') // Remove spaces around minus
          .replace(/\s*±\s*/g, '±') // Remove spaces around plus/minus
          .replace(/\s*\/\s*/g, '/') // Remove spaces around slash
          .trim();
      };

      /* =========================================================
         4. CHARACTERISTIC CHECK
      ========================================================= */

      const isCharacteristicText = (rawText) => {
        const text = normalizeText(rawText);

        if (!text) {
          return false;
        }

        /*
          Ignore obvious non-dimension text.
        */

        if (
          /^(A[0-4]|REV|DATE|DESCRIPTION|WEIGHT|SHEET|SCALE)$/i.test(
            text
          )
        ) {
          return false;
        }

        /*
          Ignore dates.
        */

        if (
          /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(
            text
          )
        ) {
          return false;
        }

        /*
          Ignore drawing / part numbers.
        */

        if (
          /\d+[-_/]\d+[-_/]\d+/.test(text)
        ) {
          return false;
        }

        /*
          Ignore long numbers.
        */

        if (
          /^\d{4,}$/.test(text)
        ) {
          return false;
        }

        /*
          Accept engineering characteristics.
        */

        if (
          tolerancePattern.test(text) ||
          bilateralTolerancePattern.test(text) ||
          unilateralTolerancePattern.test(text) ||
          diameterPattern.test(text) ||
          radiusPattern.test(text) ||
          dimensionPattern.test(text) ||
          smallTolerancePattern.test(text) ||
          fitPattern.test(text) ||
          anglePattern.test(text) ||
          angleTolerancePattern.test(text) ||
          angularToleranceLinePattern.test(text) ||
          bareFitPattern.test(text) ||
          threadPattern.test(text) ||
          datumFeaturePattern.test(text)
        ) {
          return true;
        }

        return false;
      };

      /* =========================================================
         4.5 DETECT GARBLED / CUSTOM-ENCODED FONTS
         ---------------------------------------------------------
         Some engineering PDFs use custom font encodings where
         characters are shifted (e.g. by 29 positions). This makes
         the PDF text layer unreadable. If we detect this, we skip
         the text layer entirely and go straight to OCR.
      ========================================================= */

      const textContent =
        await pdfPage.getTextContent();

      const detected = [];
      const allTextItems = [];

      console.log('=== AUTO-DETECT DEBUG ===');
      console.log('Total PDF text items:', textContent.items.length);

      const nonEmptyItems = textContent.items.filter(
        (item) => item.str && item.str.trim()
      );

      let garbledCount = 0;

      for (const item of nonEmptyItems) {
        const str = item.str.trim();
        let controlChars = 0;

        for (let i = 0; i < str.length; i++) {
          const code = str.charCodeAt(i);
          // Control characters: ASCII 0-31 (excluding tab=9, newline=10, carriage return=13)
          if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
            controlChars++;
          }
        }

        // If more than 30% of the characters in this item are control chars, it's garbled
        if (controlChars / str.length > 0.3) {
          garbledCount++;
        }
      }

      const isGarbledPDF =
        nonEmptyItems.length > 0 &&
        garbledCount / nonEmptyItems.length > 0.4;

      console.log(
        'Garbled font check:',
        garbledCount, 'of', nonEmptyItems.length,
        'items have control chars. isGarbled =', isGarbledPDF
      );

      /* =========================================================
         5. READ SELECTABLE PDF TEXT (skip if garbled)
      ========================================================= */

      if (!isGarbledPDF) {
        for (
          const item of textContent.items
        ) {
          if (
            !item.str ||
            !item.str.trim()
          ) {
            continue;
          }

          const pdfX = item.transform?.[4] || 0;
          const pdfY = item.transform?.[5] || 0;
          const point = baseViewport.convertToViewportPoint(pdfX, pdfY);
          const x = point[0] * displayScale;
          const y = point[1] * displayScale;
          const width = Number(item.width || 0) * displayScale;
          const height = Number(item.height || 0) * displayScale;

          allTextItems.push({
            text: item.str.trim(),
            x, y, width, height,
            centerX: x + width / 2,
            centerY: y + height / 2
          });

          const text = normalizeText(item.str);

          // Only filter out pure text blocks without numbers
          const passes = /\d/.test(text);
          if (!passes) {
            console.log('REJECTED (no digits):', JSON.stringify(text));
            continue;
          }



          console.log('ACCEPTED:', JSON.stringify(text), 'at', Math.round(x), Math.round(y));

          detected.push({
            text,
            x,
            y,

            width:
              Number(item.width || 0) *
              displayScale,

            height:
              Number(item.height || 0) *
              displayScale,

            confidence: 1,

            source: 'pdf'
          });
        }
      } else {
        console.log('PDF text layer is garbled (custom font encoding). Skipping to OCR...');
      }

      /* =========================================================
         6. REMOVE DUPLICATE / OVERLAPPING DETECTIONS
      ========================================================= */

      console.log('Total ACCEPTED before dedup:', detected.length);

      /* =========================================================
         7. OCR FALLBACK
      ========================================================= */
      
      const uniqueDetected = cleanAndGroupDetections(detected);
      let finalDetected = uniqueDetected;

      if (isGarbledPDF || detected.length < 10) {
        setMessage('Scanning vector shapes and vertical text...');

        try {
          const ocrScale = 2.5;
          const ocrViewport = pdfPage.getViewport({ scale: ocrScale });
          const ocrCanvas = document.createElement('canvas');
          const ocrContext = ocrCanvas.getContext('2d');
          ocrCanvas.width = Math.ceil(ocrViewport.width);
          ocrCanvas.height = Math.ceil(ocrViewport.height);
          
          ocrContext.filter = 'grayscale(1) contrast(160%) brightness(105%)';
          await pdfPage.render({ canvasContext: ocrContext, viewport: ocrViewport }).promise;

          if (!ocrWorkerRef.current) {
            ocrWorkerRef.current = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract/tesseract-core.wasm.js', langPath: '/tesseract' });
            await ocrWorkerRef.current.setParameters({
              tessedit_pageseg_mode: 11,
              tessedit_char_whitelist: '0123456789.+-±ØRMDx°Hh ',
            });
          }

          const { data } = await ocrWorkerRef.current.recognize(ocrCanvas, {}, { blocks: true });
          let words = extractOcrWords(data) || [];

          const ocrDetected = [];
          for (const word of words) {
            if (!word.text || !word.text.trim()) continue;
            let text = word.text;
            
            const x = (word.bbox.x0 / ocrScale) * displayScale;
            const y = (word.bbox.y0 / ocrScale) * displayScale;
            const width = ((word.bbox.x1 - word.bbox.x0) / ocrScale) * displayScale;
            const height = ((word.bbox.y1 - word.bbox.y0) / ocrScale) * displayScale;
            
            allTextItems.push({
              text: word.text.trim(),
              x, y, width, height,
              centerX: x + width / 2,
              centerY: y + height / 2
            });

            if (!/\d/.test(text)) continue;

            ocrDetected.push({
              text,
              x,
              y,
              width: ((word.bbox.x1 - word.bbox.x0) / ocrScale) * displayScale,
              height: ((word.bbox.y1 - word.bbox.y0) / ocrScale) * displayScale,
              confidence: word.confidence,
              source: 'ocr'
            });
          }

          finalDetected =
            cleanAndGroupDetections(
              [
                ...finalDetected,
                ...ocrDetected
              ]
            );

        } catch (ocrError) {
          console.error(
            'OCR failed:',
            ocrError
          );

          setMessage(
            'OCR failed. Please use a clearer drawing.'
          );

          return;
        }
      }

      /* =========================================================
         8. CHECK RESULT
      ========================================================= */

      if (
        finalDetected.length === 0
      ) {
        setMessage(
          'No engineering dimensions or tolerances were detected.'
        );

        return;
      }

      if (roiRect) {
          const minX = Math.min(roiRect.x1, roiRect.x2);
          const maxX = Math.max(roiRect.x1, roiRect.x2);
          const minY = Math.min(roiRect.y1, roiRect.y2);
          const maxY = Math.max(roiRect.y1, roiRect.y2);

          finalDetected = finalDetected.filter(item => {
             const centerX = item.x + item.width / 2;
             const centerY = item.y + item.height / 2;
             return centerX >= minX && centerX <= maxX &&
                    centerY >= minY && centerY <= maxY;
          });
        }

        let limited = enhanceDetections(finalDetected, baseViewport.width * displayScale, baseViewport.height * displayScale);
      limited = contextualFilter(limited, allTextItems, baseViewport.width * displayScale, baseViewport.height * displayScale);

      /* =========================================================
         11. CHECK GROUPED RESULT
      ========================================================= */

      if (
        limited.length === 0
      ) {
        setMessage(
          'No usable engineering characteristics were detected.'
        );

        return;
      }

      /* =========================================================
         12. FIND NEXT BALLOON NUMBER
      ========================================================= */

      let currentMaxNumber = 0;

      displayedBalloons.forEach(
        (balloon) => {
          const number =
            Number(
              balloon.number
            );

          if (
            Number.isFinite(
              number
            ) &&
            number >
            currentMaxNumber
          ) {
            currentMaxNumber =
              number;
          }
        }
      );

      /* =========================================================
         13. CREATE BALLOONS + CHARACTERISTICS
      ========================================================= */

      let createdCount = 0;

      for (
        const item of limited
      ) {
        try {
          /*
            Increment only ONCE.
  
            Tolerances no longer receive
            separate balloon numbers.
          */

          currentMaxNumber += 1;

          const nextNumber =
            currentMaxNumber;

          /* =====================================================
             BALLOON + VALUE POSITIONS
             -----------------------------------------------------
             The balloon is placed AWAY from the value so the
             measurement stays visible. The arrow then points
             back at the value.
          ===================================================== */

          const valueCenterX =
            item.x +
            (item.width || 0) / 2;

          /*
            PDF text y is the BASELINE (bottom of the text).
            OCR text y is the TOP of the word box.
          */

          const valueCenterY =
            item.source === 'ocr'
              ? item.y +
                (item.height || 0) /
                  2
              : item.y -
                (item.height || 0) /
                  2;

          /*
            Offset the balloon above the value,
            alternating left / right to spread
            neighbouring balloons apart.
          */

          const arrowDistance =
            60;

          const horizontalSpread =
            40;

          const balloonX =
            valueCenterX +
            (createdCount % 2 === 0
              ? horizontalSpread
              : -horizontalSpread);

          const balloonY =
            valueCenterY -
            arrowDistance;

          /*
            Detection status:
            - Selectable PDF text is read exactly => Verified
            - Low-confidence OCR still needs review
          */

          const detectionStatus =
            item.source === 'ocr' &&
            Number(item.confidence || 0) < 80
              ? 'Needs verification'
              : 'Verified';

          /* =====================================================
             CREATE BALLOON
          ===================================================== */

          const balloon =
            await api.post(
              `/projects/${id}/balloons`,
              {
                drawingId: selectedDrawingId,

                x:
                  balloonX,

                y:
                  balloonY,

                anchorX:
                  valueCenterX,

                anchorY:
                  valueCenterY,

                /*
                  Store the ORIGINAL
                  dimension text.
  
                  Example:
  
                  16
  
                  or
  
                  25 ±0.05
                */

                text:
                  item.text,

                type:
                  item.type,

                number:
                  nextNumber,

                page:
                  pageNumber,

                status:
                  detectionStatus
              }
            );

          /* =====================================================
             CREATE CHARACTERISTIC
          ===================================================== */

          const characteristic =
            await api.post(
              `/projects/${id}/characteristics`,
              {
                drawingId: selectedDrawingId,

                balloonId:
                  balloon._id,

                number:
                  nextNumber,

                type:
                  item.type,

                /*
                  MAIN VALUE ONLY
  
                  Example:
                  16
                */

                value:
                  item.value,

                unit:
                  'mm',

                /*
                  GROUPED TOLERANCES
  
                  Example:
                  +0.05
                  -0.03
                */

                plusTolerance:
                  item.plusTolerance,

                minusTolerance:
                  item.minusTolerance,

                upperLimit:
                  item.upperLimit,

                lowerLimit:
                  item.lowerLimit,

                /*
                  Combined engineering
                  specification.
  
                  Example:
  
                  16 +0.05/-0.03
  
                  OR
  
                  25 ±0.05
                */

                specification:
                  item.specification,

                inspectionMethod:
                  'Vernier Caliper',

                instrument:
                  '',

                actualValue:
                  '',

                result:
                  'NOT INSPECTED',

                remarks:
                  '',

                page:
                  pageNumber,

                x:
                  item.x,

                y:
                  item.y,

                status:
                  detectionStatus
              }
            );

          /* =====================================================
             UPDATE BALLOONS
          ===================================================== */

          setBalloons(
            (prev) => [
              ...prev,

              {
                ...balloon,

                number:
                  nextNumber,

                x:
                  balloonX,

                y:
                  balloonY,

                page:
                  pageNumber,

                /*
                  Keep detected value
                  available to UI.
                */

                text:
                  item.text,

                type:
                  item.type
              }
            ]
          );

          /* =====================================================
             UPDATE CHARACTERISTICS
          ===================================================== */

          setCharacteristics(
            (prev) => [
              ...prev,

              {
                ...characteristic,

                number:
                  nextNumber,

                value:
                  item.value,

                plusTolerance:
                  item.plusTolerance,

                minusTolerance:
                  item.minusTolerance,

                upperLimit:
                  item.upperLimit,

                lowerLimit:
                  item.lowerLimit,

                specification:
                  item.specification,

                x:
                  item.x,

                y:
                  item.y,

                page:
                  pageNumber
              }
            ]
          );

          createdCount++;

        } catch (error) {
          console.error(
            'Balloon creation failed:',
            error
          );
        }
      }

      /* =========================================================
         14. FINAL MESSAGE
      ========================================================= */

      if (
        createdCount === 0
      ) {
        setMessage(
          'No usable engineering characteristics were detected.'
        );
      } else {
        autoDetectDoneRef.current = true;
        setMessage(
          `${createdCount} engineering characteristic(s) detected successfully.`
        );
      }

    } catch (error) {
      console.error(
        'Automatic detection error:',
        error
      );

      setMessage(
        error.message ||
        'Automatic detection failed'
      );

    } finally {
      setAutoDetecting(false);
    }
  };
  /* =========================================================
   BALLOON DRAG EVENTS
========================================================= */

  useEffect(() => {
    window.addEventListener(
      'pointermove',
      handleBalloonPointerMove
    );

    window.addEventListener(
      'pointerup',
      handleBalloonPointerUp
    );

    return () => {
      window.removeEventListener(
        'pointermove',
        handleBalloonPointerMove
      );

      window.removeEventListener(
        'pointerup',
        handleBalloonPointerUp
      );
    };
  }, [
    balloons,
    characteristics
  ]);

  /* =========================================================
     KEYBOARD SHORTCUT
     "A" toggles the Add Dimension tool.
  ========================================================= */

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;

      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (event.key.toLowerCase() === 'a') {
        setMode((prev) =>
          prev === 'manual'
            ? 'none'
            : 'manual'
        );
      }
    };

    window.addEventListener(
      'keydown',
      onKeyDown
    );

    return () => {
      window.removeEventListener(
        'keydown',
        onKeyDown
      );
    };
  }, []);

  return (
    <div className="space-y-4">

      {/* =====================================================
          HEADER
      ===================================================== */}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">

        <div>
          <div className="text-sm text-slate-500">
            Project / Drawing Workspace
          </div>

          <div className="font-semibold text-slate-900">
            {project?.projectNumber ||
              'New Project'}
          </div>

          <div className="text-sm text-slate-600">
            {project?.customerName} •{' '}
            {project?.drawingNumber} Rev{' '}
            {project?.revision}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">

          {/* SELECT AREA */}
            <button
              className={`rounded border px-3 py-2 text-sm flex items-center gap-1 ${mode === 'select_area' ? 'bg-yellow-600 text-white' : ''}`}
              onClick={() => {
                if (mode === 'select_area') {
                  setMode('none');
                } else {
                  setMode('select_area');
                  setRoiRect(null); // Clear previous area when entering mode
                }
              }}
            >
              <Maximize size={15} />
              {mode === 'select_area' ? 'Draw Area...' : (roiRect ? 'Area Selected (Click to Reset)' : 'Select Area')}
            </button>
            
            {/* ADD DIMENSION (toggle, shortcut: A) */}

          <button
            className={`rounded border px-3 py-2 text-sm flex items-center gap-1 ${mode === 'manual'
              ? 'bg-slate-900 text-white'
              : ''
              }`}
            onClick={() =>
              setMode((prev) =>
                prev === 'manual'
                  ? 'none'
                  : 'manual'
              )
            }
          >
            <Plus size={15} />
            {mode === 'manual'
              ? 'Add Dimension: ON'
              : 'Add Dimension (A)'}
          </button>

          {/* ADD DIMENSION HINT */}

          {mode === 'manual' ? (
            <span className="text-xs text-amber-700">
              Click or drag over a dimension to read it
            </span>
          ) : null}

          {/* AUTO */}

          <button
            className={`rounded border px-3 py-2 text-sm flex items-center gap-1 ${mode === 'auto'
              ? 'bg-blue-600 text-white'
              : ''
              }`}
            onClick={autoDetect}
            disabled={
              autoDetecting ||
              !pdfPage
            }
          >
            <Wand2 size={15} />

            {autoDetecting
              ? 'Detecting...'
              : 'Auto Detect'}
          </button>

          {/* CLEAR ALL */}

          <button
            className="rounded border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-1"
            onClick={
              clearAllBallooning
            }
            disabled={
              balloons.length === 0 &&
              characteristics.length === 0
            }
          >
            <Eraser size={15} />
            Clear All Ballooning
          </button>



          {/* DOWNLOAD PDF */}

          <button
            className="rounded border px-3 py-2 text-sm ml-2"
            onClick={downloadPdf}
            disabled={!selectedDrawing}
          >
            <Download size={15} className="inline mr-1" /> Download PDF
          </button>

          {/* ZOOM IN */}

          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() =>
              setZoom((z) =>
                Math.min(
                  2,
                  z + 0.1
                )
              )
            }
          >
            <ZoomIn
              size={15}
              className="inline mr-1"
            />
            Zoom +
          </button>

          {/* ZOOM OUT */}

          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() =>
              setZoom((z) =>
                Math.max(
                  0.5,
                  z - 0.1
                )
              )
            }
          >
            <ZoomOut
              size={15}
              className="inline mr-1"
            />
            Zoom -
          </button>

        </div>
      </div>

      {/* =====================================================
          MESSAGE
      ===================================================== */}

      {message ? (
        <div className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          {message}
        </div>
      ) : null}

      {/* =====================================================
          MAIN AREA
      ===================================================== */}

      <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_280px]">

        {/* ===================================================
            LEFT PANEL
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 font-semibold text-slate-900">
            Pages
          </div>

          <div className="flex items-center justify-between rounded border bg-slate-50 p-2 text-sm">

            <button
              onClick={
                previousPage
              }
              disabled={
                pageNumber <= 1
              }
              className="rounded p-1 hover:bg-white disabled:opacity-30"
            >
              <ChevronLeft
                size={18}
              />
            </button>

            <span>
              Page {pageNumber} /{' '}
              {pageCount}
            </span>

            <button
              onClick={nextPage}
              disabled={
                pageNumber >=
                pageCount
              }
              className="rounded p-1 hover:bg-white disabled:opacity-30"
            >
              <ChevronRight
                size={18}
              />
            </button>

          </div>

          {/* UPLOAD */}

          <div className="mt-4">

            <label className="block text-sm text-slate-600">
              Upload drawing
            </label>

            <input
              type="file"
              accept=".pdf,application/pdf"
              onChange={
                uploadDrawing
              }
              className="mt-2 block w-full text-sm"
            />

            {uploading ? (
              <div className="mt-2 text-sm text-slate-500">
                Uploading...
              </div>
            ) : null}

          </div>

          {/* DRAWINGS */}

          <div className="mt-4">

            <div className="mb-2 text-sm font-semibold text-slate-900">
              Drawings
            </div>

            <div className="space-y-2">

              {drawings.length ===
                0 ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  No drawings uploaded
                </div>
              ) : (
                drawings.map(
                  (item) => (

                    <div
                      key={
                        item._id
                      }
                      className={`relative group rounded border px-3 py-3 ${selectedDrawingId ===
                        item._id
                        ? 'border-slate-900 bg-slate-100'
                        : 'border-slate-200 bg-white'
                        }`}
                    >

                      <div className="flex items-center justify-between gap-3">

                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDrawingId(
                              item._id
                            );

                            setActiveDrawingMenuId(
                              null
                            );
                          }}
                          className="flex min-w-0 items-center gap-2 text-left text-sm text-slate-800"
                        >
                          <span className="text-slate-500">
                            📄
                          </span>

                          <span className="truncate">
                            {
                              item.fileName
                            }
                          </span>

                        </button>

                        <button
                          type="button"
                          onClick={(
                            event
                          ) => {
                            event.stopPropagation();

                            setActiveDrawingMenuId(
                              (
                                current
                              ) =>
                                current ===
                                  item._id
                                  ? null
                                  : item._id
                            );
                          }}
                          className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
                        >
                          ⋮
                        </button>

                      </div>

                      {activeDrawingMenuId ===
                        item._id ? (
                        <div className="absolute right-3 top-full z-20 mt-2 w-40 overflow-hidden rounded border bg-white shadow-lg">

                          <button
                            type="button"
                            onClick={() => {
                              window.open(
                                drawingUrlFor(
                                  item
                                ),
                                '_blank',
                                'noopener'
                              );

                              setActiveDrawingMenuId(
                                null
                              );
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                          >
                            Open PDF
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const newName =
                                window.prompt(
                                  'Rename drawing',
                                  item.fileName
                                );

                              if (
                                newName &&
                                newName.trim() &&
                                newName.trim() !==
                                item.fileName
                              ) {
                                renameDrawing(
                                  item._id,
                                  newName.trim()
                                );
                              }
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                          >
                            Rename
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setConfirmDeleteDrawingId(
                                item._id
                              );

                              setActiveDrawingMenuId(
                                null
                              );
                            }}
                            className="block w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-slate-50"
                          >
                            Delete
                          </button>

                        </div>
                      ) : null}

                    </div>

                  )
                )
              )}

            </div>

          </div>

        </div>

        {/* ===================================================
            PDF VIEWER
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">

            <div className="font-semibold text-slate-900">
              Engineering Drawing Viewer
            </div>

            <div className="flex items-center gap-2">

              <span className="rounded bg-slate-100 px-3 py-1 text-xs text-slate-600">
                {mode ===
                  'manual'
                  ? 'Manual Ballooning'
                  : 'Automatic Ballooning'}
              </span>

              <span className="text-xs text-slate-500">
                Zoom{' '}
                {Math.round(
                  zoom * 100
                )}
                %
              </span>

            </div>

          </div>

          <div
            ref={
              pdfContainerRef
            }
            className="relative min-h-[650px] overflow-auto rounded-lg border border-slate-300 bg-slate-200"
          >

            {!selectedDrawing ? (

              <div className="absolute inset-0 flex items-center justify-center text-slate-400">
                Upload a drawing to begin ballooning
              </div>

            ) : loadingPdf ? (

              <div className="absolute inset-0 flex items-center justify-center">
                <div className="rounded-lg bg-white px-5 py-4 shadow">
                  Loading engineering drawing...
                </div>
              </div>

            ) : drawingError ? (

              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-4 text-center">

                <div className="text-lg font-semibold">
                  Unable to load drawing
                </div>

                <div className="max-w-xl break-all text-sm text-slate-500">
                  {drawingUrl}
                </div>

                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      drawingUrl,
                      '_blank',
                      'noopener'
                    )
                  }
                  className="rounded bg-slate-900 px-4 py-2 text-sm text-white"
                >
                  Open PDF
                </button>

              </div>

            ) : isPdf ? (

              <div className="flex min-w-full justify-center p-5">

                <div
                  className="relative bg-white shadow-xl"
                  style={
                    mode === 'manual'
                      ? { touchAction: 'none' }
                      : undefined
                  }
                  onPointerDown={
                    handleAddPointerDown
                  }
                  onPointerMove={
                    handleAddPointerMove
                  }
                  onPointerUp={
                    handleAddPointerUp
                  }
                >

                  <canvas
                    ref={
                      canvasRef
                    }
                    className="block"
                  />

                  {/* BALLOON OVERLAY */}

                  <div className="pointer-events-none absolute inset-0">

                    {/* LEADER ARROWS: each balloon points an
                        arrow at its measurement / value */}

                    <svg
                      className="absolute inset-0 h-full w-full"
                      style={{ overflow: 'visible' }}
                    >
                      {displayedBalloons
                        .filter(
                          (
                            balloon
                          ) =>
                            !balloon.page ||
                            balloon.page ===
                            pageNumber
                        )
                        .map(
                          (
                            balloon
                          ) => {
                            const x =
                              balloon.x ?? 0;
                            const y =
                              balloon.y ?? 0;
                            const ax =
                              balloon.anchorX ??
                              x + 12;
                            const ay =
                              balloon.anchorY ??
                              y + 12;

                            /*
                              Direction from the balloon
                              TOWARDS the value.
                            */

                            const dx =
                              ax - x;

                            const dy =
                              ay - y;

                            const dist =
                              Math.hypot(
                                dx,
                                dy
                              ) || 1;

                            const ux =
                              dx / dist;

                            const uy =
                              dy / dist;

                            /*
                              Balloon marker radius
                              (h-6 circle => 12px).
                            */

                            const R = 10;
                            const head = 7;

                            /*
                              Line starts at the balloon
                              edge and ends at the value.
                            */

                            const startX =
                              x + ux * R;

                            const startY =
                              y + uy * R;

                            const angle =
                              Math.atan2(
                                uy,
                                ux
                              );

                            return (
                              <g
                                key={`arrow-${balloon._id}`}
                              >
                                {/* leader line */}
                                <line
                                  x1={startX}
                                  y1={startY}
                                  x2={ax}
                                  y2={ay}
                                  stroke="rgba(220, 38, 38, 0.4)"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                />

                                {/* arrowhead pointing AT
                                    the measurement */}
                                <polygon
                                  points={`${ax},${ay} ${ax - head * Math.cos(angle - 0.35)},${ay - head * Math.sin(angle - 0.35)} ${ax - head * Math.cos(angle + 0.35)},${ay - head * Math.sin(angle + 0.35)}`}
                                  fill="rgba(220, 38, 38, 0.7)"
                                />

                                {/* draggable anchor tip */}
                                <circle
                                  cx={ax}
                                  cy={ay}
                                  r={8}
                                  fill="#3b82f6"
                                  opacity="0.8"
                                  className="cursor-move pointer-events-auto"
                                  onPointerDown={(e) => handleAnchorPointerDown(e, balloon)}
                                />
                              </g>
                            );
                          }
                        )}
                    </svg>

                    {displayedBalloons
                      .filter(
                        (
                          balloon
                        ) =>
                          !balloon.page ||
                          balloon.page ===
                          pageNumber
                      )
                      .map(
                        (
                          balloon
                        ) => (

                          <div
                            key={balloon._id}
                            className="absolute pointer-events-auto balloon-marker cursor-move select-none"
                            style={{
                              left: balloon.x / dRatio,
                              top: balloon.y / dRatio,
                              transform:
                                'translate(-50%, -50%)',
                              touchAction: 'none'
                            }}
                            onPointerDown={(event) =>
                              handleBalloonPointerDown(
                                event,
                                balloon
                              )
                            }
                          >

                            <button
                              type="button"
                              className={`flex h-6 min-w-6 items-center justify-center rounded-full border-[1.5px] px-1.5 text-[10px] font-bold shadow-sm ${selectedBalloonId ===
                                balloon._id
                                ? 'border-yellow-500 bg-yellow-400/50 text-yellow-900 backdrop-blur-[1px]'
                                : 'border-red-500 bg-red-500/40 text-red-900 backdrop-blur-[1px]'
                                }`}
                              onPointerDown={(event) => {
                                event.stopPropagation();

                                handleBalloonPointerDown(
                                  event,
                                  balloon
                                );
                              }}
                            >
                              {balloon.number}
                            </button>

                          </div>

                        )
                      )}

                    {/* ROI RECTANGLE */}
                    {roiRect ? (
                      <div
                        className="absolute border-2 border-yellow-500 bg-yellow-400/20"
                        style={{
                          left: Math.min(roiRect.x1, roiRect.x2) / dRatio,
                          top: Math.min(roiRect.y1, roiRect.y2) / dRatio,
                          width: Math.abs(roiRect.x2 - roiRect.x1) / dRatio,
                          height: Math.abs(roiRect.y2 - roiRect.y1) / dRatio,
                          pointerEvents: 'none'
                        }}
                      />
                    ) : null}

                    {/* ADD DIMENSION SELECTION RECTANGLE */}

                    {mode === 'manual' &&
                    selectRect ? (
                      <div
                        className="absolute border-2 border-blue-500 bg-blue-400/20"
                        style={{
                          left: selectRect.x1 / dRatio,
                            top: selectRect.y1 / dRatio,
                            width: (selectRect.x2 - selectRect.x1) / dRatio,
                            height: (selectRect.y2 - selectRect.y1) / dRatio
                        }}
                      />
                    ) : null}

                    {mode === 'manual' &&
                    addScanning ? (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="rounded-lg bg-slate-900/80 px-5 py-4 text-sm text-white shadow">
                          Reading dimension from drawing...
                        </div>
                      </div>
                    ) : null}

                  </div>

                </div>

              </div>

            ) : (

              <div className="flex h-full min-h-[650px] items-center justify-center p-5">

                <img
                  src={
                    drawingUrl
                  }
                  alt={
                    selectedDrawing.fileName
                  }
                  className="max-h-[650px] max-w-full object-contain"
                />

              </div>

            )}

          </div>

          {/* VIEWER CONTROLS */}

          {isPdf &&
            pdfPage ? (

            <div className="mt-3 flex items-center justify-center gap-2">

              <button
                onClick={() =>
                  setZoom(1)
                }
                className="rounded border bg-white px-3 py-2 text-sm"
              >
                <Maximize
                  size={14}
                  className="inline mr-1"
                />
                Fit
              </button>

              <button
                onClick={
                  previousPage
                }
                disabled={
                  pageNumber <=
                  1
                }
                className="rounded border px-3 py-2 text-sm disabled:opacity-40"
              >
                Previous
              </button>

              <span className="px-3 text-sm text-slate-600">
                {pageNumber} /{' '}
                {pageCount}
              </span>

              <button
                onClick={
                  nextPage
                }
                disabled={
                  pageNumber >=
                  pageCount
                }
                className="rounded border px-3 py-2 text-sm disabled:opacity-40"
              >
                Next
              </button>

            </div>

          ) : null}

        </div>

        {/* ===================================================
            SELECTED BALLOON
        =================================================== */}

        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">

          <div className="mb-3 font-semibold text-slate-900">
            Edit Balloon / Characteristic
          </div>

          <div className="space-y-4">

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Balloon No
              </label>

              <input
                type="text"
                value={currentBalloonNo}
                onFocus={() => setFocusedField('currentBalloonNo')}
                onChange={(e) =>
                  handleBalloonNumberChange(e.target.value)
                }
                onKeyDown={handleBalloonNumberKeyDown}
                onBlur={saveEdit}
                placeholder="Enter balloon number"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap gap-1">
                {['Ø', 'R', '↧', '⌴', '⌵', '°', '±', '×', 'Ⓜ', 'Ⓛ', '⟂', '∥', '∠', '⌖', '◯', '▱'].map(sym => (
                  <button
                    key={sym}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertSymbol(sym)}
                    className="rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200"
                  >
                    {sym}
                  </button>
                ))}
              </div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Description
              </label>

              <input
                type="text"
                value={editData?.specification ?? ''}
                onFocus={() => setFocusedField('specification')}
                onChange={(e) =>
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          specification: e.target.value
                        }
                      : prev
                  )
                }
                onBlur={saveEdit}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Dimensions No</label>

              <input
                type="text"
                value={editData?.value ?? ''}
                onFocus={() => setFocusedField('value')}
                onChange={(e) =>
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          value: e.target.value
                        }
                      : prev
                  )
                }
                onBlur={saveEdit}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Upper Tolerance</label>

              <input
                type="text"
                value={editData?.plusTolerance ?? ''}
                onFocus={() => setFocusedField('plusTolerance')}
                onChange={(e) =>
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          plusTolerance: e.target.value
                        }
                      : prev
                  )
                }
                onBlur={saveEdit}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Lower Tolerance</label>

              <input
                type="text"
                value={editData?.minusTolerance ?? ''}
                onFocus={() => setFocusedField('minusTolerance')}
                onChange={(e) =>
                  setEditData((prev) =>
                    prev
                      ? {
                          ...prev,
                          minusTolerance: e.target.value
                        }
                      : prev
                  )
                }
                onBlur={saveEdit}
                placeholder="—"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={saveEdit}
              disabled={!editData || !!savingCharacteristicId}
              className="flex w-full items-center justify-center gap-2 rounded border border-slate-900 bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingCharacteristicId ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {savingCharacteristicId ? 'Saving...' : 'Save'}
            </button>

            <button
              onClick={() => deleteBalloon(selectedBalloonId)}
              disabled={!editData}
              className="flex w-full items-center justify-center gap-2 rounded border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={14} />
              Delete Balloon
            </button>

            <button
              type="button"
              onClick={() => setShowCharacteristicsTable(true)}
              className="flex w-full items-center justify-center gap-2 rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              <Table2 size={14} />
              Table
            </button>

          </div>

        </div>

        {/* =====================================================
          DELETE DRAWING CONFIRMATION
      ===================================================== */}

        {confirmDeleteDrawingId ? (

          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">

            <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">

              <div className="mb-4 text-lg font-semibold">
                Confirm drawing delete
              </div>

              <div className="mb-6 text-sm text-slate-600">
                This will remove the drawing file and its viewer entry. Are you sure?
              </div>

              <div className="flex justify-end gap-3">

                <button
                  onClick={() =>
                    setConfirmDeleteDrawingId(
                      null
                    )
                  }
                  className="rounded border px-4 py-2 text-sm"
                >
                  Cancel
                </button>

                <button
                  onClick={() =>
                    deleteDrawing(
                      confirmDeleteDrawingId
                    )
                  }
                  className="rounded bg-red-600 px-4 py-2 text-sm text-white"
                >
                  Delete
                </button>

              </div>

            </div>

          </div>

        ) : null}

        {/* =====================================================
          CHARACTERISTICS TABLE MODAL
      ===================================================== */}

        {showCharacteristicsTable ? (

          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">

            <div className="flex max-h-[85vh] w-full max-w-4xl flex-col rounded-xl bg-white p-6 shadow-xl">

              <div className="mb-4 flex items-center justify-between">

                <div className="text-lg font-semibold">
                  Ballooning Table
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={exportToExcel}
                    className="flex items-center gap-2 rounded bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700"
                  >
                    <Download size={14} />
                    Download Excel
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setShowCharacteristicsTable(false)
                    }
                    className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    Close
                  </button>
                </div>

              </div>

              {characteristics.length === 0 ? (

                <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
                  No ballooning yet for this project.
                </div>

              ) : (

                <div className="overflow-auto rounded-lg border border-slate-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                      <tr>
                        <th className="px-4 py-3">Balloon No</th>
                        <th className="px-4 py-3">Description</th>
                        <th className="px-4 py-3">Dimensions No</th>
                        <th className="px-4 py-3">Upper Tolerance</th>
                        <th className="px-4 py-3">Lower Tolerance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {characteristics
                        .slice()
                        .sort((a, b) =>
                          Number(a.number || 0) - Number(b.number || 0)
                        )
                        .map((characteristic) => (
                          <tr
                            key={characteristic._id}
                            className="border-t border-slate-100 hover:bg-slate-50"
                          >
                            <td className="px-4 py-3 font-semibold text-slate-800">
                              {characteristic.number || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {characteristic.specification || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {characteristic.value || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {characteristic.plusTolerance || '-'}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {characteristic.minusTolerance || '-'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

              )}

            </div>

          </div>

        ) : null}

    </div>
  </div>
  );
}
