import fs from 'fs';
const file = 'C:/Users/saran/OneDrive/Desktop/pragmatic_project/ballooning/frontend/src/pages/DrawingWorkspace.jsx';
let content = fs.readFileSync(file, 'utf8');

content = content.replace('      const isGarbledPDF = detected.length < 5 && pdfDetected.length > 20;\n      if (isGarbledPDF || detected.length < 10) {', '      if (isGarbledPDF || detected.length < 10) {');

fs.writeFileSync(file, content);
console.log('Fixed double declaration');
