import fs from 'fs';
const file = 'C:/Users/saran/OneDrive/Desktop/pragmatic_project/ballooning/frontend/src/pages/DrawingWorkspace.jsx';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

const startIndex = lines.findIndex(line => line.includes('let words = [];'));
const endIndex = lines.findIndex((line, i) => i > startIndex && line.includes('if (!ocrWorkerRef.current) {'));

if (startIndex !== -1 && endIndex !== -1) {
  lines.splice(startIndex, endIndex - startIndex);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('Replaced ocrReadRegion lines');
} else {
  console.log('Could not find startIndex or endIndex', startIndex, endIndex);
}
