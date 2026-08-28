import fs from 'fs';
const file = 'C:/Users/saran/OneDrive/Desktop/pragmatic_project/ballooning/frontend/src/pages/DrawingWorkspace.jsx';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

const startIndex = lines.findIndex(line => line.includes('// ALWAYS run OCR to catch vector dimensions'));
const endIndex = lines.findIndex((line, i) => i > startIndex && line.includes('finalDetected ='));

if (startIndex !== -1 && endIndex !== -1) {
  lines.splice(startIndex, endIndex - startIndex, `      const isGarbledPDF = detected.length < 5 && pdfDetected.length > 20;
      if (isGarbledPDF || detected.length < 10) {
        setMessage('Scanning vector shapes and vertical text...');

        try {
          const ocrScale = 1.5;
          const ocrViewport = pdfPage.getViewport({ scale: ocrScale });
          const ocrCanvas = document.createElement('canvas');
          const ocrContext = ocrCanvas.getContext('2d');
          ocrCanvas.width = Math.ceil(ocrViewport.width);
          ocrCanvas.height = Math.ceil(ocrViewport.height);
          
          ocrContext.filter = 'grayscale(1) contrast(160%) brightness(105%)';
          await pdfPage.render({ canvasContext: ocrContext, viewport: ocrViewport }).promise;

          const worker = await createWorker('eng');
          await worker.setParameters({
            tessedit_pageseg_mode: 11,
            tessedit_char_whitelist: '0123456789.+-±ØRMDx°Hh ',
          });

          const { data } = await worker.recognize(ocrCanvas);
          let words = data.words || [];

          await worker.terminate();

          const ocrDetected = [];
          for (const word of words) {
            if (!word.text || !word.text.trim()) continue;
            let text = word.text;
            if (!/\\d/.test(text)) continue;

            const x = (word.bbox.x0 / ocrScale) * displayScale;
            const y = (word.bbox.y0 / ocrScale) * displayScale;

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
`);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('Replaced OCR lines');
} else {
  console.log('Could not find startIndex or endIndex', startIndex, endIndex);
}
