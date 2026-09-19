export const enhanceDetections = (items, pageWidth = 0, pageHeight = 0) => {
  if (!items || items.length === 0) return [];

  const processedItems = items.map(item => ({
    ...item,
    normText: item.text.trim().toUpperCase()
  }));

  const grouped = [];
  const used = new Set();

  for (let i = 0; i < processedItems.length; i++) {
    if (used.has(i)) continue;
    const base = processedItems[i];
    let clusterText = base.text;
    let minX = base.x;
    let minY = base.y;
    let maxX = base.x + (base.width || 0);
    let maxY = base.y + (base.height || 0);
    let confidence = base.confidence;

    for (let j = i + 1; j < processedItems.length; j++) {
      if (used.has(j)) continue;
      const other = processedItems[j];
      
      const dx = Math.abs(base.x - other.x);
      const dy = Math.abs(base.y - other.y);
      
      if (dx < 50 && dy < 40) {
        clusterText += ' ' + other.text;
        used.add(j);
        minX = Math.min(minX, other.x);
        minY = Math.min(minY, other.y);
        maxX = Math.max(maxX, other.x + (other.width || 0));
        maxY = Math.max(maxY, other.y + (other.height || 0));
      }
    }
    
    grouped.push({
      text: clusterText,
      normText: clusterText.toUpperCase(),
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      confidence
    });
  }

  const xTols = 15;
  const yTols = 15;
  
  grouped.forEach(item => {
    item.colDensity = grouped.filter(o => Math.abs(o.centerX - item.centerX) < xTols).length;
    item.rowDensity = grouped.filter(o => Math.abs(o.centerY - item.centerY) < yTols).length;
  });

  const keywords = grouped.filter(i => /^(REV|DATE|SCALE|WEIGHT|SHEET|MATERIAL|DRAWN|CHECKED)/.test(i.normText));

  const finalCandidates = [];

  grouped.forEach(item => {
    let score = 0;
    let parsed = parseCallout(item.text);
    if (!parsed) return;

    score += parsed.score;

    if (item.colDensity > 3 && item.rowDensity > 3) {
      score -= 50;
    } else if (item.colDensity > 4) {
      score -= 50;
    }

    const nearKeyword = keywords.some(k => Math.hypot(k.centerX - item.centerX, k.centerY - item.centerY) < 150);
    if (nearKeyword) {
      score -= 40;
    }
    
    if (/^(COMMON FOR|NOTES|ALL UNSPECIFIED|UNLESS OTHERWISE)/.test(item.normText)) {
      score -= 35;
    }


    if (score > 0) {
      finalCandidates.push({
        ...item,
        ...parsed,
        confidence: score
      });
    }
  });

  const unique = [];
  finalCandidates.sort((a, b) => b.confidence - a.confidence).forEach(c => {
    if (!unique.some(u => Math.hypot(u.centerX - c.centerX, u.centerY - c.centerY) < 20)) {
      unique.push(c);
    }
  });

  return unique;
};


const parseCallout = (text) => {
  const norm = text.toUpperCase().replace(/\s+/g, ' ');
  let result = { type: 'Dimension', value: norm, specification: text, plusTolerance: '0.00', minusTolerance: '0.00', score: 0 };

  // Plus/Minus matching (± or +/- or +- or + -)
  const plusMinusRe = /^\s*(?:[1-9]\d*X\s*)?(?:\u00d8|\u2205|R|M|S\u00d8|SR)?\s*(\d+(?:\.\d+)?)(?:\s*[A-Z0-9]+)*\s*(?:\u00b1|\+\s*\/\s*-|\+\s*-)\s*(\d+(?:\.\d+)?)/i;
  const pmMatch = norm.match(plusMinusRe);
  if (pmMatch) {
    result.type = norm.includes('Ø') || norm.includes('A~') ? 'Diameter' : norm.includes('R') ? 'Radius' : norm.includes('M') ? 'Thread' : 'Dimension';
    result.score += 25;
    
    // Extract proper values
    let prefix = '';
    const prefixMatch = text.match(/^\s*([1-9]\d*X\s*)?(Ø|A~|R|M|SØ|SR)/i);
    if (prefixMatch) {
      prefix = prefixMatch[0].trim() + (prefixMatch[0].endsWith('X') ? ' ' : '');
    }
    result.value = prefix + pmMatch[1];
    result.plusTolerance = '+' + pmMatch[2];
    result.minusTolerance = '-' + pmMatch[2];
    return result;
  }

  // Bilateral matching (+X/-Y)
  const bilateralRe = /^\s*(?:[1-9]\d*X\s*)?(?:\u00d8|\u2205|R|M|S\u00d8|SR)?\s*(\d+(?:\.\d+)?)(?:\s*[A-Z0-9]+)*\s*\+\s*(\d+(?:\.\d+)?)\s*\/\s*-\s*(\d+(?:\.\d+)?)/i;
  const blMatch = norm.match(bilateralRe);
  if (blMatch) {
    result.type = norm.includes('Ø') || norm.includes('A~') ? 'Diameter' : norm.includes('R') ? 'Radius' : norm.includes('M') ? 'Thread' : 'Dimension';
    result.score += 30;
    
    let prefix = '';
    const prefixMatch = text.match(/^\s*([1-9]\d*X\s*)?(Ø|A~|R|M|SØ|SR)/i);
    if (prefixMatch) {
      prefix = prefixMatch[0].trim() + (prefixMatch[0].endsWith('X') ? ' ' : '');
    }
    result.value = prefix + blMatch[1];
    result.plusTolerance = '+' + blMatch[2];
    result.minusTolerance = '-' + blMatch[3];
    return result;
  }

  if (/M\d+(?:\.\d+)?(?:\s*[XA-]\s*\d+(?:\.\d+)?)?(?:\s*THRU)?/i.test(norm)) {
    result.type = 'Thread';
    result.score += 25;
    result.value = norm.match(/M\d+(?:\.\d+)?(?:\s*[XA-]\s*\d+(?:\.\d+)?)?/i)[0];
    return result;
  }

  if (/(?:Ø|A~|^.)\s*(\d+(?:\.\d+)?)/i.test(norm)) {
    result.type = 'Diameter';
    result.score += 15;
    const match = norm.match(/(?:Ø|A~|^.)\s*(\d+(?:\.\d+)?)/i);
    result.value = 'Ø' + match[1];
    return result;
  }

  if (/R\s*(\d+(?:\.\d+)?)/i.test(norm)) {
    result.type = 'Radius';
    result.score += 15;
    const match = norm.match(/R\s*(\d+(?:\.\d+)?)/i);
    result.value = 'R' + match[1];
    return result;
  }

  if (/(\d+(?:\.\d+)?)\s*([A-Z]{1,2}\d{1,2})/.test(norm)) {
    result.type = 'Fit';
    result.score += 25;
    const match = norm.match(/(\d+(?:\.\d+)?)\s*([A-Z]{1,2}\d{1,2})/);
    result.value = match[1] + ' ' + match[2];
    return result;
  }

  if (/(?:[1-9]\d*X\s*)?\d+(?:\.\d+)?/.test(norm) && text.length < 15 && !/[A-Z]{3,}/.test(norm)) {
    result.type = 'Dimension';
    result.score += 10;
    const match = norm.match(/(?:[1-9]\d*X\s*)?(\d+(?:\.\d+)?)/);
    result.value = match[0];
    return result;
  }

  return null;
};
