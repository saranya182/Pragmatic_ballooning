import fs from 'fs';
const file = 'C:/Users/saran/OneDrive/Desktop/pragmatic_project/ballooning/frontend/src/pages/DrawingWorkspace.jsx';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');

const startIndex = lines.findIndex(line => line.includes('finalDetected.sort('));
const endIndex = lines.findIndex((line, i) => i > startIndex && line.includes('const limited ='));

if (startIndex !== -1 && endIndex !== -1) {
  lines.splice(startIndex - 4, (endIndex - startIndex) + 9, `      let limited = enhanceDetections(finalDetected);`);
  fs.writeFileSync(file, lines.join('\n'));
  console.log('Replaced lines from', startIndex, 'to', endIndex);
} else {
  console.log('Could not find startIndex or endIndex', startIndex, endIndex);
}
