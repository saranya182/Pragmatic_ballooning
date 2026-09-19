const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'frontend/src/pages/DrawingWorkspace.jsx');
let content = fs.readFileSync(file, 'utf8');

// 1. Add previewDetections state
if (!content.includes('const [previewDetections')) {
  content = content.replace(
    /const \[roiRect, setRoiRect\] = useState\(null\);/,
    "const [roiRect, setRoiRect] = useState(null);\n  const [previewDetections, setPreviewDetections] = useState([]);"
  );
}

// 2. Add detectPatterns import if not present
if (!content.includes('detectPatterns')) {
  content = content.replace(
    /import { contextualFilter } from '\.\.\/utils\/contextualFilter';/,
    "import { contextualFilter } from '../utils/contextualFilter';\nimport { detectPatterns } from '../utils/patternMatcher';"
  );
}

// 3. Create analyzeArea function right above autoDetect
const analyzeAreaFunc = `
  const analyzeArea = async (rect) => {
    if (!pdfPage || !rect) return;
    try {
      setAddScanning(true);
      const textContent = await pdfPage.getTextContent();
      let detected = [];
      
      const minX = Math.min(rect.x1, rect.x2);
      const maxX = Math.max(rect.x1, rect.x2);
      const minY = Math.min(rect.y1, rect.y2);
      const maxY = Math.max(rect.y1, rect.y2);
      
      const viewport = pdfPage.getViewport({ scale: 1 });
      const displayScale = 1;
      
      for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue;
        const tx = item.transform;
        const itemX = tx[4] * displayScale;
        const itemY = (viewport.height - tx[5]) * displayScale;
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
      
      // Attempt OCR for missing/garbled areas (simple fallback)
      if (detected.length < 2) {
        const base64 = canvasRef.current?.toDataURL('image/jpeg', 0.8);
        if (base64) {
          try {
            const ocrRes = await api.post('/ocr/detect', { imageBase64: base64, isCrop: true });
            if (ocrRes.data && ocrRes.data.detections) {
               for (const d of ocrRes.data.detections) {
                  const centerX = d.x + d.width / 2;
                  const centerY = d.y + d.height / 2;
                  if (centerX >= minX && centerX <= maxX && centerY >= minY && centerY <= maxY) {
                      detected.push({...d, source: 'ocr'});
                  }
               }
            }
          } catch(e) {}
        }
      }
      
      // Cluster items 
      let finalDetected = clusterDetectionsIntoDimensions(detected);
      
      // Match against Pattern Library
      finalDetected = finalDetected.map(item => {
        const match = detectPatterns(item.text);
        if (match) {
           return { ...item, type: match.type, specification: item.text, confidence: 100 };
        }
        return item;
      }).filter(item => detectPatterns(item.text) !== null);
      
      // Enhance
      finalDetected = enhanceDetections(finalDetected, viewport.width, viewport.height);
      setPreviewDetections(finalDetected);
    } catch(err) {
      console.error(err);
    } finally {
      setAddScanning(false);
    }
  };
`;

if (!content.includes('const analyzeArea = async')) {
  content = content.replace(
    /const autoDetect = async \(\) => \{/,
    analyzeAreaFunc + "\n  const autoDetect = async () => {"
  );
}

// 4. Update handleAddPointerUp
if (!content.includes('analyzeArea(rectToAnalyze);')) {
  content = content.replace(
    /\} else if \(mode === 'select_area' && roiSelectRef\.current\) \{\s*roiSelectRef\.current = null;\s*setMode\('none'\);\s*\}/,
    `} else if (mode === 'select_area' && roiSelectRef.current) {
      const start = roiSelectRef.current;
      roiSelectRef.current = null;
      const point = clientToCanvasPoint(event);
      let rectToAnalyze = {
        x1: Math.min(start.startX, point.x),
        y1: Math.min(start.startY, point.y),
        x2: Math.max(start.startX, point.x),
        y2: Math.max(start.startY, point.y)
      };
      setMode('none');
      setRoiRect(rectToAnalyze); // Keep it visible
      analyzeArea(rectToAnalyze);
    }`
  );
}

// 5. Update autoDetect to use previewDetections
if (!content.includes('let finalDetected = previewDetections;')) {
  // We need to bypass the entire extraction logic in autoDetect if previewDetections has items
  // Find where finalDetected is manipulated and just wrap it or inject at the beginning of try
  content = content.replace(
    /let finalDetected = \[\];/,
    `let finalDetected = [];
      if (previewDetections.length > 0) {
        finalDetected = previewDetections;
        // Skip extraction, proceed directly to creating balloons
      } else {`
  );
  
  // Close the else block after `finalDetected = contextualFilter(limited);`
  // This is tricky, let's look for `let createdCount = 0;` and insert `}` before it.
  content = content.replace(
    /let createdCount = 0;/,
    `} // End of else block for extraction
      let createdCount = 0;`
  );
}

// 6. Add rendering for previewDetections
if (!content.includes('border-green-500')) {
  content = content.replace(
    /\{roiRect \? \(/,
    `{previewDetections.map((det, i) => (
                        <div
                          key={\`preview-\${i}\`}
                          className="absolute border-2 border-green-500 bg-green-400/30"
                          style={{
                            left: det.x / dRatio,
                            top: det.y / dRatio,
                            width: det.width / dRatio,
                            height: det.height / dRatio,
                            pointerEvents: 'none'
                          }}
                        />
                      ))}
                      {roiRect ? (`
  );
}

// 7. Clear previewDetections if area changes or resets
if (!content.includes('setPreviewDetections([])')) {
  content = content.replace(
    /setRoiRect\(null\); \/\/ Clear previous area when entering mode/,
    "setRoiRect(null); setPreviewDetections([]); // Clear previous area when entering mode"
  );
  content = content.replace(
    /autoDetectDoneRef\.current = false;/g,
    "autoDetectDoneRef.current = false; setPreviewDetections([]);"
  );
}

fs.writeFileSync(file, content);
console.log('Patched DrawingWorkspace.jsx successfully!');
