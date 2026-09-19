const fs = require('fs');

const file = 'frontend/src/pages/DrawingWorkspace.jsx';
let code = fs.readFileSync(file, 'utf8');

// Fix any leftover bad brace
code = code.replace(/} \/\/ End of else block for extraction/g, '');

const shortCircuitCode = `
    if (previewDetections.length > 0) {
      try {
        setAutoDetecting(true);
        setMode('auto');
        let finalDetected = previewDetections;
        let createdCount = 0;
        
        for (const detected of finalDetected) {
          const status = statusForDetection(detected);
          const balloon = await api.post(\`/projects/\${id}/balloons\`, {
            drawingId: selectedDrawingId,
            text: detected.specification || detected.text,
            type: detected.type || 'Dimension',
            x: detected.x,
            y: detected.y,
            anchorX: detected.x + 20,
            anchorY: detected.y + 20,
            page: pageNumber,
            status
          });
          await api.post(\`/projects/\${id}/characteristics\`, {
            drawingId: selectedDrawingId,
            balloonId: balloon.data._id || balloon.data.id,
            type: detected.type || 'Dimension',
            value: detected.value || detected.text,
            specification: detected.specification || detected.text,
            plusTolerance: detected.plusTolerance || '0.00',
            minusTolerance: detected.minusTolerance || '0.00',
            x: detected.x,
            y: detected.y,
            page: pageNumber,
            status
          });
          createdCount++;
        }
        
        autoDetectDoneRef.current = true;
        setMessage(\`\${createdCount} engineering characteristic(s) detected successfully.\`);
        await loadData();
      } finally {
        setAutoDetecting(false);
        setPreviewDetections([]);
        setRoiRect(null);
      }
      return;
    }
`;

if (!code.includes('if (previewDetections.length > 0) {')) {
  code = code.replace(
    /const autoDetect = async \(\) => \{\s*if \(\!pdfPage\) \{/,
    `const autoDetect = async () => {\n${shortCircuitCode}\n    if (!pdfPage) {`
  );
}

fs.writeFileSync(file, code);
console.log('autoDetect short circuit injected.');
