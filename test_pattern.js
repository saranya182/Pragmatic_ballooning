


export const detectPatterns = (rawText) => {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const normText = text.replace(/,/g, '.');

  // Using unicode escapes to prevent any file encoding corruption on Windows
  // \u00D8 = Ø, \u2205 = ∅, \u03A6 = Φ
  // \u00B1 = ±
  // \u00B0 = °
  // \u00D7 = ×
  
  const rules = [
    { id: 'P01', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?(?:\s*(?:mm|in|inch|inches))?\s*$/i, type: 'Dimension' },
    { id: 'P02', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s*\u00B1\s*\d+(?:\.\d+)?\s*$/i, type: 'Dimension' },
    { id: 'P03', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s*\+\s*\d+(?:\.\d+)?\s*$/i, type: 'Dimension' },
    { id: 'P04', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*$/i, type: 'Dimension' },
    { id: 'P05', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s*\+\s*\d+(?:\.\d+)?\s*\/\s*-\s*\d+(?:\.\d+)?\s*$/i, type: 'Dimension' },
    { id: 'P06', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?(?:\u00D8|\u2205|\u03A6|O|Q|0)\s*\d+(?:\.\d+)?\s*$/i, type: 'Diameter' },
    { id: 'P07', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?(?:\u00D8|\u2205|\u03A6|O|Q|0)\s*\d+(?:\.\d+)?\s+[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i, type: 'Diameter' },
    { id: 'P08', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?R\s*\d+(?:\.\d+)?(?:\s*\u00B1\s*\d+(?:\.\d+)?)?\s*$/i, type: 'Radius' },
    { id: 'P09', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s*\u00B0(?:\s*\u00B1\s*\d+(?:\.\d+)?\s*\u00B0?)?\s*$/i, type: 'Angle' },
    { id: 'P10', regex: /^\s*\d+(?:\.\d+)?\s*[xX\u00D7]\s*\d+(?:\.\d+)?(?:\s*\u00B0)?\s*$/i, type: 'Chamfer' },
    { id: 'P11', regex: /^\s*\d+(?:\.\d+)?\s*[xX\u00D7]\s*\d+(?:\.\d+)?(?:\s*\u00B0)?\s*TYP\s*$/i, type: 'Chamfer' },
    { id: 'P12', regex: /^\s*[1-9]\d*\s*[xX\u00D7]\s*(.*)$/i, type: 'Feature' },
    { id: 'P13', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?(?:\u00D8|\u2205|\u03A6|O|Q|0)?\s*\d+(?:\.\d+)?\s*THRU\s*$/i, type: 'Hole' },
    { id: 'P14', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?(?:\u00D8|\u2205|\u03A6|O|Q|0)?\s*\d+(?:\.\d+)?\s*THRU\s+ALL\s*$/i, type: 'Hole' },
    { id: 'P15', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?M\d+(?:\.\d+)?\s*$/i, type: 'Thread' },
    { id: 'P16', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?M\d+(?:\.\d+)?\s*[xX\u00D7]\s*\d+(?:\.\d+)?\s*$/i, type: 'Thread' },
    { id: 'P17', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?M\d+(?:\.\d+)?\s*[xX\u00D7]\s*\d+(?:\.\d+)?\s*THRU\s+ALL\s*$/i, type: 'Thread' },
    { id: 'P18', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?M\d+(?:\.\d+)?(?:\s*[xX\u00D7]\s*\d+(?:\.\d+)?)?\s*THRU\s*$/i, type: 'Thread' },
    { id: 'P19', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s+[A-Za-z]{1,2}\d{1,2}(?:\s*\/\s*[A-Za-z]{1,2}\d{1,2})?\s*$/i, type: 'Fit' },
    { id: 'P20', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?(?:\u00D8|\u2205|\u03A6|O|Q|0)?\s*\d+(?:\.\d+)?\s+(?:DEEP|DEPTH)\s*$/i, type: 'Depth' },
    { id: 'P21', regex: /^\s*(.*)\s+TYP\s*$/i, type: 'Modifier' },
    { id: 'P22', regex: /^\s*(.*)\s+FROM\s+OTHER\s+SIDE\s*$/i, type: 'Modifier' },
    { id: 'P23', regex: /^\s*(?:[1-9]\d*[Xx\u00D7]\s*)?\d+(?:\.\d+)?\s+[A-Z]\s*$/i, type: 'Datum' }
  ];

  for (const rule of rules) {
    if (rule.regex.test(normText)) {
      return { matchedId: rule.id, type: rule.type, text: rawText };
    }
  }

  if (/^\s*[+-\u00B1]?\s*0?\.\d{1,3}\s*$/.test(normText)) {
    return { matchedId: 'P01', type: 'Tolerance_Fragment', text: rawText };
  }
  
  // Fallback dimension logic for when OCR gets completely garbled but it's obviously a number
  if (/^\s*\d+(?:\.\d+)?\s*$/.test(normText)) {
     return { matchedId: 'P01', type: 'Dimension', text: rawText };
  }

  return null;
};
