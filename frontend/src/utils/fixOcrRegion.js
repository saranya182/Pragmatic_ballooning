import fs from 'fs';
const file = 'C:/Users/saran/OneDrive/Desktop/pragmatic_project/ballooning/frontend/src/pages/DrawingWorkspace.jsx';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

const startIndex = lines.findIndex(line => line.includes('        if (!ocrWorkerRef.current) {'));
const endIndex = lines.findIndex((line, i) => i > startIndex && line.includes('      const items = [];'));

if (startIndex !== -1 && endIndex !== -1) {
  const block = `
      let words = [];
      if (!ocrWorkerRef.current) {
        ocrWorkerRef.current = await createWorker('eng');
      }
      let { data } = await ocrWorkerRef.current.recognize(crop);
      words = data.words.map(w => ({
        text: w.text,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
        confidence: w.confidence
      }));

      const hasValidText = words.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\\d)/gi, 'Ø').replace(/^0(?=\\d)/, 'Ø')));
      if (!hasValidText && words.length <= 2) {
        // Try counter-clockwise rotation (bottom-to-top text)
        const rotCanvas = document.createElement('canvas');
        rotCanvas.width = crop.height;
        rotCanvas.height = crop.width;
        const rctx = rotCanvas.getContext('2d');
        rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
        rctx.rotate(-Math.PI / 2);
        rctx.drawImage(crop, -crop.width / 2, -crop.height / 2);
        
        const { data: rotData } = await ocrWorkerRef.current.recognize(rotCanvas);
        const rotWords = rotData.words.map(w => ({
          text: w.text,
          bbox: {
            x0: crop.width - w.bbox.y1,
            y0: w.bbox.x0,
            x1: crop.width - w.bbox.y0,
            y1: w.bbox.x1
          },
          confidence: w.confidence
        }));
        
        if (rotWords.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\\d)/gi, 'Ø').replace(/^0(?=\\d)/, 'Ø')))) {
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
          
          const { data: rotData2 } = await ocrWorkerRef.current.recognize(rotCanvas2);
          const rotWords2 = rotData2.words.map(w => ({
            text: w.text,
            bbox: {
              x0: w.bbox.y0,
              y0: crop.height - w.bbox.x1,
              x1: w.bbox.y1,
              y1: crop.height - w.bbox.x0
            },
            confidence: w.confidence
          }));
          if (rotWords2.some(w => isDetectionText(normalizeDetectionText(w.text).replace(/O(?=\\d)/gi, 'Ø').replace(/^0(?=\\d)/, 'Ø')))) {
             words = rotWords2;
          }
        }
      }
`;
  lines.splice(startIndex, endIndex - startIndex, block);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('Fixed syntax error in ocrReadRegion');
}
