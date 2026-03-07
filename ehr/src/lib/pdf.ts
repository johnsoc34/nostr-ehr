/**
 * src/lib/pdf.ts
 * Client-side PDF generation for clinical forms and documents.
 * Uses jsPDF — install: npm install jspdf @types/jspdf
 *
 * All generators follow the same pattern:
 *   1. Accept patient data + relevant FHIR resources
 *   2. Build a jsPDF document with practice letterhead
 *   3. Return the doc (caller does doc.save() or doc.output())
 *
 * Document types:
 *   1. School Excuse
 *   2. Immunization Record (yellow-card style)
 *   3. Growth Chart (accepts a canvas/image data URL)
 *   4. Sports Physical (PPE — generic AAP-style)
 *   5. Child Care Form (California LIC 701)
 *   6. Kindergarten Entry Form (California PM 171 A)
 */

import jsPDF from "jspdf";

// ─── Practice Config ──────────────────────────────────────────────────────────
// Generic placeholders — update when practice details are finalized

const PRACTICE = {
  name: process.env.NEXT_PUBLIC_PRACTICE_NAME || "My Practice",
  address: process.env.NEXT_PUBLIC_PRACTICE_ADDRESS || "",
  cityStateZip: process.env.NEXT_PUBLIC_PRACTICE_CITY_STATE_ZIP || "",
  phone: process.env.NEXT_PUBLIC_PRACTICE_PHONE || "",
  fax: process.env.NEXT_PUBLIC_PRACTICE_FAX || "",
  provider: process.env.NEXT_PUBLIC_PRACTICE_PROVIDER || "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PX = 72;  // points per inch
const LM = 54;  // left margin
const RM = 54;  // right margin
const TM = 54;  // top margin
const PW = 612; // page width (letter)
const PH = 792; // page height (letter)
const CW = PW - LM - RM; // content width

function fmtDate(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : d;
  return dt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function fmtDateLong(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d + (d.length === 10 ? "T00:00:00" : "")) : d;
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function ageFromDob(dob: string): string {
  const birth = new Date(dob + "T00:00:00");
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (now.getDate() < birth.getDate()) months--;
  const totalMonths = years * 12 + months;
  if (totalMonths < 24) return `${totalMonths} months`;
  return months > 0 ? `${years} yr ${months} mo` : `${years} yr`;
}

interface PatientInfo {
  name: string;
  dob: string;
  sex: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
}

// ─── Letterhead ───────────────────────────────────────────────────────────────

function drawLetterhead(doc: jsPDF): number {
  // Practice name
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59); // slate-800
  doc.text(PRACTICE.name, PW / 2, TM, { align: "center" });

  // Address line
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // slate-500
  doc.text(`${PRACTICE.address} · ${PRACTICE.cityStateZip}`, PW / 2, TM + 14, { align: "center" });
  doc.text(`Phone: ${PRACTICE.phone} · Fax: ${PRACTICE.fax}`, PW / 2, TM + 24, { align: "center" });

  // Divider line
  doc.setDrawColor(203, 213, 225); // slate-300
  doc.setLineWidth(0.5);
  doc.line(LM, TM + 34, PW - RM, TM + 34);

  return TM + 48; // return Y position after letterhead
}

function drawSignatureLine(doc: jsPDF, y: number, label: string): number {
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.5);
  doc.line(LM, y, LM + 250, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(label, LM, y + 10);

  // Date line
  doc.line(LM + 300, y, PW - RM, y);
  doc.text("Date", LM + 300, y + 10);

  return y + 24;
}

function drawCheckbox(doc: jsPDF, x: number, y: number, checked: boolean, label: string): void {
  doc.setDrawColor(100, 116, 139);
  doc.setLineWidth(0.5);
  doc.rect(x, y - 7, 8, 8);
  if (checked) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(30, 41, 59);
    doc.text("✓", x + 1.5, y);
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text(label, x + 12, y);
}

function drawField(doc: jsPDF, x: number, y: number, label: string, value: string, width: number): number {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(label, x, y);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(value || "", x, y + 12);
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(x, y + 14, x + width, y + 14);
  return y + 24;
}

function ensurePage(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PH - 60) {
    doc.addPage();
    return TM;
  }
  return y;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. SCHOOL EXCUSE
// ═══════════════════════════════════════════════════════════════════════════════

export interface SchoolExcuseOpts {
  patient: PatientInfo;
  startDate: string;      // YYYY-MM-DD
  endDate: string;        // YYYY-MM-DD
  amOnly: boolean;
  pmOnly: boolean;
  reason: "illness" | "chronic-condition" | "appointment";
}

export function generateSchoolExcuse(opts: SchoolExcuseOpts): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = drawLetterhead(doc);

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 41, 59);
  doc.text("School Excuse", PW / 2, y + 10, { align: "center" });
  y += 36;

  // Date
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(`Date: ${fmtDateLong(new Date())}`, LM, y);
  y += 20;

  // To whom it may concern
  doc.text("To Whom It May Concern:", LM, y);
  y += 24;

  // Patient info
  const { patient } = opts;
  const patientAge = ageFromDob(patient.dob);

  // Build absence description
  const startFmt = fmtDateLong(opts.startDate);
  const endFmt = fmtDateLong(opts.endDate);
  const sameDay = opts.startDate === opts.endDate;
  let dateRange = sameDay ? `on ${startFmt}` : `from ${startFmt} through ${endFmt}`;
  if (opts.amOnly) dateRange += " (AM only)";
  if (opts.pmOnly) dateRange += " (PM only)";

  const reasonMap = {
    "illness": "illness",
    "chronic-condition": "a chronic medical condition",
    "appointment": "a medical appointment",
  };

  const body = `Please excuse ${patient.name} (Date of Birth: ${fmtDate(patient.dob)}, Age: ${patientAge}) from school ${dateRange} due to ${reasonMap[opts.reason]}.`;

  // Word-wrap the body
  const lines = doc.splitTextToSize(body, CW);
  doc.text(lines, LM, y);
  y += lines.length * 14 + 16;

  // Follow-up line
  doc.text("The student may return to regular activities unless otherwise noted below.", LM, y);
  y += 24;

  // Additional notes area
  doc.setFont("helvetica", "italic");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("Additional notes:", LM, y);
  y += 6;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 3; i++) {
    y += 18;
    doc.line(LM, y, PW - RM, y);
  }
  y += 36;

  // Signature
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text("Sincerely,", LM, y);
  y += 40;

  y = drawSignatureLine(doc, y, `${PRACTICE.provider} — ${PRACTICE.name}`);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. IMMUNIZATION RECORD
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImmunizationEntry {
  vaccine: string;        // e.g. "DTaP", "IPV"
  date: string;           // YYYY-MM-DD
  dose?: number;          // dose number
}

export function generateImmunizationRecord(
  patient: PatientInfo,
  immunizations: ImmunizationEntry[]
): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = drawLetterhead(doc);

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59);
  doc.text("Official Immunization Record", PW / 2, y + 10, { align: "center" });
  y += 30;

  // Patient info row
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("Patient:", LM, y);
  doc.setFont("helvetica", "normal");
  doc.text(patient.name, LM + 50, y);

  doc.setFont("helvetica", "bold");
  doc.text("DOB:", LM + 250, y);
  doc.setFont("helvetica", "normal");
  doc.text(fmtDate(patient.dob), LM + 280, y);

  doc.setFont("helvetica", "bold");
  doc.text("Sex:", LM + 380, y);
  doc.setFont("helvetica", "normal");
  doc.text(patient.sex === "male" ? "M" : patient.sex === "female" ? "F" : patient.sex, LM + 405, y);
  y += 20;

  // Divider
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 16;

  // Group immunizations by vaccine name
  const grouped: Record<string, { date: string; dose?: number }[]> = {};
  for (const imm of immunizations) {
    const key = imm.vaccine;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ date: imm.date, dose: imm.dose });
  }
  // Sort each group by date
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }

  // Vaccine display order (common pediatric vaccines first)
  const vaccineOrder = [
    "DTaP", "Tdap", "DT", "Td",
    "IPV", "OPV", "Polio",
    "MMR",
    "Hep B", "Hepatitis B", "HepB",
    "Hep A", "Hepatitis A", "HepA",
    "Varicella", "Chickenpox",
    "Hib",
    "PCV13", "Prevnar",
    "RV", "Rotavirus",
    "Flu", "Influenza",
    "HPV", "Gardasil",
    "MenACWY", "Menactra",
    "MenB",
    "COVID-19", "COVID",
  ];

  const sortedKeys = Object.keys(grouped).sort((a, b) => {
    const ai = vaccineOrder.findIndex(v => a.toLowerCase().includes(v.toLowerCase()));
    const bi = vaccineOrder.findIndex(v => b.toLowerCase().includes(v.toLowerCase()));
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  // Yellow card background for the table area
  const tableTop = y;
  const maxDoses = Math.max(...Object.values(grouped).map(g => g.length), 5);
  const colW = Math.min(80, (CW - 140) / maxDoses);
  const rowH = 22;
  const tableH = (sortedKeys.length + 1) * rowH + 4;

  // Yellow background
  doc.setFillColor(255, 251, 235); // amber-50
  doc.rect(LM - 4, tableTop - 4, CW + 8, tableH + 8, "F");

  // Table border
  doc.setDrawColor(217, 186, 100);
  doc.setLineWidth(1);
  doc.rect(LM - 4, tableTop - 4, CW + 8, tableH + 8, "S");

  // Header row
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(120, 80, 0);
  doc.text("VACCINE", LM + 4, y + 6);
  for (let i = 0; i < maxDoses; i++) {
    doc.text(`Dose ${i + 1}`, LM + 140 + i * colW, y + 6);
  }
  y += rowH;

  // Divider under header
  doc.setDrawColor(217, 186, 100);
  doc.setLineWidth(0.5);
  doc.line(LM, y - 8, PW - RM, y - 8);

  // Data rows
  doc.setFontSize(9);
  for (const vaccine of sortedKeys) {
    y = ensurePage(doc, y, rowH + 10);

    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59);
    doc.text(vaccine, LM + 4, y + 6);

    doc.setFont("helvetica", "normal");
    doc.setTextColor(60, 60, 60);
    const doses = grouped[vaccine];
    for (let i = 0; i < doses.length; i++) {
      doc.text(fmtDate(doses[i].date), LM + 140 + i * colW, y + 6);
    }

    // Row separator
    doc.setDrawColor(230, 210, 150);
    doc.setLineWidth(0.2);
    doc.line(LM, y + 12, PW - RM, y + 12);

    y += rowH;
  }
  y += 20;

  // Footer
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated: ${fmtDateLong(new Date())} — ${PRACTICE.name}`, LM, y);
  y += 14;
  doc.text("This record should be kept with the patient's personal health records.", LM, y);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. GROWTH CHART
// ═══════════════════════════════════════════════════════════════════════════════

export interface GrowthMeasurement {
  date: string;
  ageMonths: number;
  weight?: number;    // kg
  height?: number;    // cm
  hc?: number;        // cm
  bmi?: number;
  hv?: number;        // cm/yr (height velocity)
}

export interface GrowthChartCurvePoint {
  age: number;
  p3: number; p10: number; p25: number; p50: number; p75: number; p90: number; p97: number;
}

export interface GrowthChartDot {
  ageMonths: number;
  val: number;
  date: string;
}

export function generateGrowthChart(
  patient: PatientInfo,
  chartTitle: string,           // e.g. "Weight-for-Age (WHO 0-24 months)"
  chartCurves: GrowthChartCurvePoint[],
  dots: GrowthChartDot[],
  dotColor: string,
  yLabel: string,
  xLabel: string,
  yStep: number,
  currentAgeMonths: number,
  measurements: GrowthMeasurement[],
  existingDoc?: jsPDF            // if provided, adds a new page to this doc instead of creating one
): jsPDF {
  const doc = existingDoc || new jsPDF({ unit: "pt", format: "letter" });
  if (existingDoc) doc.addPage();
  let y = drawLetterhead(doc);

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text(`Growth Chart — ${patient.name}`, PW / 2, y + 10, { align: "center" });
  y += 20;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`DOB: ${fmtDate(patient.dob)} · Age: ${ageFromDob(patient.dob)} · ${chartTitle}`, PW / 2, y + 4, { align: "center" });
  y += 16;

  // ── Draw chart natively in jsPDF ──────────────────────────
  const chartW = CW;
  const chartH = chartW * 0.5;
  const cPL = 36, cPR = 30, cPT = 12, cPB = 22;
  const plotW = chartW - cPL - cPR;
  const plotH = chartH - cPT - cPB;
  const chartX = LM;
  const chartY = y;

  // Chart background
  doc.setFillColor(240, 245, 250);
  doc.rect(chartX + cPL, chartY + cPT, plotW, plotH, "F");
  doc.setDrawColor(200, 210, 220);
  doc.setLineWidth(0.3);
  doc.rect(chartX + cPL, chartY + cPT, plotW, plotH, "S");

  // Axes math — curves define scale, dots clamp to chart edges
  const allAges = chartCurves.map(c => c.age);
  const minAge = Math.min(...allAges), maxAge = Math.max(...allAges);

  // Y-axis: use fixed config for CDC height/weight, dynamic for others
  type YAxisCfg = { min: number; max: number; gridStep: number; labelStep: number; fmtLeft: (v: number) => string; fmtRight?: (v: number) => string };
  let yAxisCfg: YAxisCfg | null = null;
  const isWHO = maxAge <= 24;
  if (!isWHO && yLabel.startsWith("Height")) {
    yAxisCfg = { min: 75, max: 198, gridStep: 3, labelStep: 9,
      fmtLeft: v => `${v}`, fmtRight: v => `${Math.round(v / 2.54)}″` };
  } else if (!isWHO && yLabel.startsWith("Weight")) {
    yAxisCfg = { min: 5, max: 105, gridStep: 5, labelStep: 10,
      fmtLeft: v => `${v}`, fmtRight: v => `${Math.round(v * 2.205)} lb` };
  }

  let minVal: number, maxVal: number;
  if (yAxisCfg) {
    minVal = yAxisCfg.min; maxVal = yAxisCfg.max;
  } else {
    const allVals = chartCurves.flatMap(c => [c.p3, c.p97]);
    minVal = Math.floor(Math.min(...allVals)); maxVal = Math.ceil(Math.max(...allVals));
  }

  const ax = (a: number) => chartX + cPL + Math.max(0, Math.min(plotW, (a - minAge) / (maxAge - minAge) * plotW));
  const ay = (v: number) => chartY + cPT + plotH - (v - minVal) / (maxVal - minVal) * plotH;
  const ayClamp = (v: number) => Math.max(chartY + cPT + 2, Math.min(chartY + cPT + plotH - 2, ay(v)));

  // Y grid lines + labels (left metric, right imperial where applicable)
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  if (yAxisCfg) {
    for (let v = yAxisCfg.min; v <= yAxisCfg.max; v += yAxisCfg.gridStep) {
      const isLabel = (v - yAxisCfg.min) % yAxisCfg.labelStep === 0;
      doc.setDrawColor(isLabel ? 180 : 220, isLabel ? 190 : 230, isLabel ? 200 : 240);
      doc.setLineWidth(isLabel ? 0.3 : 0.15);
      doc.line(chartX + cPL, ay(v), chartX + cPL + plotW, ay(v));
      if (isLabel) {
        doc.setTextColor(120, 130, 140);
        doc.text(yAxisCfg.fmtLeft(v), chartX + cPL - 3, ay(v) + 2, { align: "right" });
        if (yAxisCfg.fmtRight) {
          doc.text(yAxisCfg.fmtRight(v), chartX + cPL + plotW + 3, ay(v) + 2);
        }
      }
    }
  } else {
    doc.setDrawColor(210, 220, 230);
    doc.setLineWidth(0.2);
    doc.setTextColor(120, 130, 140);
    for (let v = minVal; v <= maxVal; v += yStep) {
      doc.line(chartX + cPL, ay(v), chartX + cPL + plotW, ay(v));
      doc.text(String(v), chartX + cPL - 3, ay(v) + 2, { align: "right" });
    }
  }

  // X grid lines + labels: gridlines every 6mo for CDC, every 2mo for WHO; labels every 2yr/2mo
  const xGridLines: number[] = [];
  const xLabelTicks: number[] = [];
  if (maxAge <= 24) {
    for (let a = 0; a <= 24; a += 2) { xGridLines.push(a); xLabelTicks.push(a); }
  } else {
    for (let a = minAge; a <= maxAge; a += 6) xGridLines.push(a);
    for (let a = minAge; a <= maxAge; a += 24) xLabelTicks.push(a);
  }
  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  for (const a of xGridLines) {
    const isLabel = xLabelTicks.includes(a);
    doc.setDrawColor(isLabel ? 180 : 220, isLabel ? 190 : 230, isLabel ? 200 : 240);
    doc.setLineWidth(isLabel ? 0.3 : 0.15);
    doc.line(ax(a), chartY + cPT, ax(a), chartY + cPT + plotH);
  }
  for (const a of xLabelTicks) {
    doc.setTextColor(120, 130, 140);
    const lbl = a < 48 ? `${a}mo` : `${Math.round(a / 12)}y`;
    doc.text(lbl, ax(a), chartY + cPT + plotH + 8, { align: "center" });
  }

  // Percentile curves
  const pctDefs: { key: "p97"|"p90"|"p75"|"p50"|"p25"|"p10"|"p3"; r: number; g: number; b: number; label: string }[] = [
    { key: "p97", r: 220, g: 80, b: 80, label: "97th" },
    { key: "p90", r: 200, g: 160, b: 50, label: "90th" },
    { key: "p75", r: 60, g: 180, b: 100, label: "75th" },
    { key: "p50", r: 50, g: 140, b: 220, label: "50th" },
    { key: "p25", r: 60, g: 180, b: 100, label: "25th" },
    { key: "p10", r: 200, g: 160, b: 50, label: "10th" },
    { key: "p3", r: 220, g: 80, b: 80, label: "3rd" },
  ];

  const chartTop = chartY + cPT;
  const chartBot = chartY + cPT + plotH;
  // Clip a line segment to the chart's vertical bounds using interpolation
  function clipSegment(x1:number,y1:number,x2:number,y2:number):{x1:number;y1:number;x2:number;y2:number}|null{
    // Both above or both below — skip
    if((y1<chartTop&&y2<chartTop)||(y1>chartBot&&y2>chartBot))return null;
    let cx1=x1,cy1=y1,cx2=x2,cy2=y2;
    const dy=y2-y1;
    if(dy!==0){
      if(cy1<chartTop){const t=(chartTop-y1)/dy;cx1=x1+(x2-x1)*t;cy1=chartTop;}
      else if(cy1>chartBot){const t=(chartBot-y1)/dy;cx1=x1+(x2-x1)*t;cy1=chartBot;}
      if(cy2<chartTop){const t=(chartTop-y1)/dy;cx2=x1+(x2-x1)*t;cy2=chartTop;}
      else if(cy2>chartBot){const t=(chartBot-y1)/dy;cx2=x1+(x2-x1)*t;cy2=chartBot;}
    }
    return{x1:cx1,y1:cy1,x2:cx2,y2:cy2};
  }
  for (const { key, r, g, b, label } of pctDefs) {
    doc.setDrawColor(r, g, b);
    doc.setLineWidth(key === "p50" ? 1.2 : 0.6);
    for (let i = 1; i < chartCurves.length; i++) {
      const seg=clipSegment(
        ax(chartCurves[i-1].age),ay(chartCurves[i-1][key]),
        ax(chartCurves[i].age),ay(chartCurves[i][key])
      );
      if(seg)doc.line(seg.x1,seg.y1,seg.x2,seg.y2);
    }
    // Label at end — clamp Y position to chart area
    doc.setFontSize(5);
    doc.setTextColor(r, g, b);
    const lastPt = chartCurves[chartCurves.length - 1];
    const labelY = Math.max(chartTop + 3, Math.min(chartBot - 1, ay(lastPt[key]) + 2));
    doc.text(label, chartX + cPL + plotW + (yAxisCfg?.fmtRight ? 22 : 2), labelY);
  }

  // Current age line
  if (currentAgeMonths >= minAge && currentAgeMonths <= maxAge) {
    doc.setDrawColor(140, 100, 200);
    doc.setLineWidth(0.8);
    const cx = ax(currentAgeMonths);
    // Dashed line (manual segments)
    for (let yy = chartY + cPT; yy < chartY + cPT + plotH; yy += 6) {
      doc.line(cx, yy, cx, Math.min(yy + 3, chartY + cPT + plotH));
    }
  }

  // Dot connecting line (dashed)
  if (dots.length > 1) {
    // Parse dot color hex to RGB
    const dcR = parseInt(dotColor.slice(1, 3), 16);
    const dcG = parseInt(dotColor.slice(3, 5), 16);
    const dcB = parseInt(dotColor.slice(5, 7), 16);
    doc.setDrawColor(dcR, dcG, dcB);
    doc.setLineWidth(0.8);
    for (let i = 1; i < dots.length; i++) {
      const x1 = ax(dots[i - 1].ageMonths), y1 = ayClamp(dots[i - 1].val);
      const x2 = ax(dots[i].ageMonths), y2 = ayClamp(dots[i].val);
      // Dashed
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const segs = Math.max(1, Math.round(dist / 5));
      for (let s = 0; s < segs; s += 2) {
        const t1 = s / segs, t2 = Math.min((s + 1) / segs, 1);
        doc.line(x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2);
      }
    }
  }

  // Data dots
  if (dots.length > 0) {
    const dcR = parseInt(dotColor.slice(1, 3), 16);
    const dcG = parseInt(dotColor.slice(3, 5), 16);
    const dcB = parseInt(dotColor.slice(5, 7), 16);
    for (const d of dots) {
      const cx = ax(d.ageMonths), cy = ayClamp(d.val);
      doc.setFillColor(dcR, dcG, dcB);
      doc.circle(cx, cy, 3.5, "F");
      doc.setDrawColor(255, 255, 255);
      doc.setLineWidth(0.8);
      doc.circle(cx, cy, 3.5, "S");
    }
  }

  // Axis labels
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(xLabel, chartX + cPL + plotW / 2, chartY + chartH - 2, { align: "center" });
  // Y label (rotated)
  doc.text(yLabel, chartX + 4, chartY + cPT + plotH / 2, { angle: 90 });
  // Right-side Y label for imperial units
  if (yAxisCfg?.fmtRight) {
    const rightLabel = yLabel.startsWith("Weight") ? "Weight (lbs)" : yLabel.startsWith("Height") ? "Height (in)" : "";
    if (rightLabel) {
      doc.text(rightLabel, chartX + cPL + plotW + 20, chartY + cPT + plotH / 2, { angle: -90 });
    }
  }

  y += chartH + 12;

  // Measurement table — show only columns that have data
  if (measurements.length > 0) {
    y = ensurePage(doc, y, 60);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 41, 59);
    doc.text("Measurement History", LM, y);
    y += 14;

    // Determine which value columns have data
    const hasWeight = measurements.some(m => m.weight);
    const hasHeight = measurements.some(m => m.height);
    const hasHC = measurements.some(m => m.hc);
    const hasBMI = measurements.some(m => m.bmi);
    const hasHV = measurements.some(m => m.hv);

    // Build dynamic columns: always Date + Age, then only populated value columns
    const cols: { label: string; render: (m: GrowthMeasurement) => string }[] = [
      { label: "Date", render: m => fmtDate(m.date) },
      { label: "Age", render: m => `${Math.floor(m.ageMonths / 12)}y ${Math.round(m.ageMonths % 12)}m` },
    ];
    if (hasWeight) cols.push({ label: "Weight", render: m => m.weight ? `${m.weight} kg (${(m.weight * 2.205).toFixed(1)} lb)` : "—" });
    if (hasHeight) cols.push({ label: "Height", render: m => m.height ? `${m.height} cm (${(m.height / 2.54).toFixed(1)} in)` : "—" });
    if (hasHC) cols.push({ label: "Head Circ", render: m => m.hc ? `${m.hc} cm (${(m.hc / 2.54).toFixed(1)} in)` : "—" });
    if (hasBMI) cols.push({ label: "BMI", render: m => m.bmi ? m.bmi.toFixed(1) : "—" });
    if (hasHV) cols.push({ label: "Ht Velocity", render: m => m.hv ? `${m.hv.toFixed(1)} cm/yr` : "—" });

    // Distribute columns evenly across content width
    const colW = CW / cols.length;
    const colX = cols.map((_, i) => LM + i * colW);

    // Table header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    cols.forEach((c, i) => doc.text(c.label, colX[i], y));
    y += 4;
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.line(LM, y, PW - RM, y);
    y += 10;

    // Rows
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    const sorted = [...measurements].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    for (const m of sorted.slice(0, 20)) {
      y = ensurePage(doc, y, 14);
      cols.forEach((c, i) => doc.text(c.render(m), colX[i], y));
      y += 12;
    }
  }

  // Footer
  y += 10;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated: ${fmtDateLong(new Date())} — ${PRACTICE.name}`, LM, y);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SPORTS PHYSICAL (PPE)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SportsPhysicalData {
  patient: PatientInfo;
  vitals?: {
    height?: string;    // display string e.g. "5'4\""
    weight?: string;    // display string e.g. "120 lbs"
    bp?: string;        // e.g. "110/70"
    pulse?: string;
    visionR?: string;   // e.g. "20/20"
    visionL?: string;
    corrected?: boolean;
  };
  allergies: string[];
  medications: string[];
  conditions: string[];
}

export function generateSportsPhysical(data: SportsPhysicalData): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = drawLetterhead(doc);

  // Title
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59);
  doc.text("Preparticipation Physical Evaluation", PW / 2, y + 10, { align: "center" });
  y += 18;
  doc.setFontSize(10);
  doc.text("Physical Examination Form", PW / 2, y + 4, { align: "center" });
  y += 24;

  const { patient, vitals } = data;

  // Patient info
  y = drawField(doc, LM, y, "Name", patient.name, 250);
  const fieldY = y - 24;
  drawField(doc, LM + 280, fieldY, "Date of Birth", fmtDate(patient.dob), 130);
  drawField(doc, LM + 430, fieldY, "Sex", patient.sex === "male" ? "Male" : patient.sex === "female" ? "Female" : patient.sex, 70);

  // Vitals
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text("VITALS", LM, y + 4);
  y += 16;

  const v = vitals || {};
  const vitalsGrid = [
    ["Height", v.height || ""], ["Weight", v.weight || ""], ["BP", v.bp || "       /       "],
    ["Pulse", v.pulse || ""], ["Vision R", v.visionR ? `20/${v.visionR}` : "20/    "], ["Vision L", v.visionL ? `20/${v.visionL}` : "20/    "],
  ];
  const vColW = CW / 3;
  for (let i = 0; i < vitalsGrid.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    if (col === 0 && row > 0) y += 24;
    drawField(doc, LM + col * vColW, y, vitalsGrid[i][0], vitalsGrid[i][1], vColW - 20);
  }
  y += 30;

  // Corrected vision checkbox
  drawCheckbox(doc, LM, y, v.corrected || false, "Corrected");
  y += 18;

  // Exam table
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("MEDICAL EXAMINATION", LM, y);
  y += 14;

  const examSections = [
    "Appearance / Marfan stigmata",
    "Eyes, ears, nose, and throat",
    "Lymph nodes",
    "Heart (auscultation standing, supine, ± Valsalva)",
    "Lungs",
    "Abdomen",
    "Skin (HSV, MRSA, tinea)",
    "Neurological",
  ];

  // Table header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text("SYSTEM", LM + 4, y);
  doc.text("NORMAL", LM + 260, y);
  doc.text("ABNL", LM + 310, y);
  doc.text("FINDINGS", LM + 360, y);
  y += 4;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 10;

  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  for (const section of examSections) {
    y = ensurePage(doc, y, 20);
    doc.setFont("helvetica", "normal");
    doc.text(section, LM + 4, y);
    // Empty checkboxes for normal/abnormal
    doc.rect(LM + 268, y - 7, 8, 8);
    doc.rect(LM + 314, y - 7, 8, 8);
    // Findings line
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.2);
    doc.line(LM + 360, y + 2, PW - RM, y + 2);
    y += 18;
  }

  // Musculoskeletal
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("MUSCULOSKELETAL", LM, y);
  y += 14;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text("AREA", LM + 4, y);
  doc.text("NORMAL", LM + 260, y);
  doc.text("ABNL", LM + 310, y);
  doc.text("FINDINGS", LM + 360, y);
  y += 4;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 10;

  const mskSections = [
    "Neck", "Back", "Shoulder / arm", "Elbow / forearm",
    "Wrist / hand / fingers", "Hip / thigh", "Knee",
    "Leg / ankle", "Foot / toes", "Functional (squat tests)",
  ];

  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  for (const section of mskSections) {
    y = ensurePage(doc, y, 20);
    doc.setFont("helvetica", "normal");
    doc.text(section, LM + 4, y);
    doc.rect(LM + 268, y - 7, 8, 8);
    doc.rect(LM + 314, y - 7, 8, 8);
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.2);
    doc.line(LM + 360, y + 2, PW - RM, y + 2);
    y += 18;
  }

  // Page 2 — Eligibility
  doc.addPage();
  y = drawLetterhead(doc);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59);
  doc.text("Medical Eligibility Form", PW / 2, y + 10, { align: "center" });
  y += 30;

  y = drawField(doc, LM, y, "Name", patient.name, 280);
  drawField(doc, LM + 310, y - 24, "Date of Birth", fmtDate(patient.dob), 180);

  // Eligibility checkboxes
  y += 8;
  const eligOpts = [
    "Medically eligible for all sports without restriction",
    "Medically eligible for all sports with recommendations for further evaluation or treatment",
    "Medically eligible for certain sports",
    "Not medically eligible pending further evaluation",
    "Not medically eligible for any sports",
  ];
  for (const opt of eligOpts) {
    drawCheckbox(doc, LM, y, false, opt);
    y += 18;
  }

  // Recommendations
  y += 8;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("Recommendations:", LM, y);
  y += 6;
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  for (let i = 0; i < 3; i++) { y += 16; doc.line(LM, y, PW - RM, y); }
  y += 24;

  // Clearance statement
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  const clearance = "I have examined the student named on this form and completed the preparticipation physical evaluation. The athlete does not have apparent clinical contraindications to practice and can participate in the sport(s) as outlined on this form.";
  const cLines = doc.splitTextToSize(clearance, CW);
  doc.text(cLines, LM, y);
  y += cLines.length * 10 + 20;

  y = drawSignatureLine(doc, y, "Signature of Health Care Professional, MD, DO, NP, or PA");
  y += 8;
  drawField(doc, LM, y, "Name (print)", PRACTICE.provider, 250);
  drawField(doc, LM + 280, y, "Phone", PRACTICE.phone, 220);

  // Emergency info section
  y += 36;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text("SHARED EMERGENCY INFORMATION", LM, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Allergies: ${data.allergies.length > 0 ? data.allergies.join(", ") : "NKDA"}`, LM, y);
  y += 14;
  doc.text(`Medications: ${data.medications.length > 0 ? data.medications.join(", ") : "None"}`, LM, y);
  y += 14;
  doc.text(`Medical Conditions: ${data.conditions.length > 0 ? data.conditions.join(", ") : "None"}`, LM, y);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. CHILD CARE FORM (California LIC 701)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChildCareFormData {
  patient: PatientInfo;
  centerName: string;
  hoursFrom: string;         // e.g. "8:00 AM"
  hoursTo: string;
  daysPerWeek: string;
  allergies: { medicine: string; insect: string; food: string; asthma: boolean };
  hearingNotes: string;
  visionNotes: string;
  developmentalNotes: string;
  speechNotes: string;
  dentalNotes: string;
  otherNotes: string;
  comments: string;
  medications: string;
  immunizations: ImmunizationEntry[];
  tbRiskPresent: boolean;
  tbTestPerformed: boolean;
  reviewedWithParent: boolean;
}

export function generateChildCareForm(data: ChildCareFormData): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = TM;

  // State header
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("STATE OF CALIFORNIA · HEALTH AND HUMAN SERVICES AGENCY · CALIFORNIA DEPARTMENT OF SOCIAL SERVICES", PW / 2, y, { align: "center" });
  y += 10;
  doc.text("COMMUNITY CARE LICENSING", PW / 2, y, { align: "center" });
  y += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.text("PHYSICIAN'S REPORT — CHILD CARE CENTERS", PW / 2, y, { align: "center" });
  y += 10;
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("(CHILD'S PRE-ADMISSION HEALTH EVALUATION)", PW / 2, y, { align: "center" });
  y += 18;

  // Part A
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("PART A — PARENT'S CONSENT", LM, y);
  y += 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const partA = `${data.patient.name}, born ${fmtDate(data.patient.dob)}, is being studied for readiness to enter ${data.centerName}. This Child Care Center provides a program which extends from ${data.hoursFrom} to ${data.hoursTo}, ${data.daysPerWeek} days a week.`;
  const paLines = doc.splitTextToSize(partA, CW);
  doc.text(paLines, LM, y);
  y += paLines.length * 12 + 10;

  // Signature line for parent
  doc.setDrawColor(180, 180, 180);
  doc.line(LM, y, LM + 320, y);
  doc.line(LM + 340, y, PW - RM, y);
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("Signature of Parent/Guardian", LM, y + 9);
  doc.text("Date", LM + 340, y + 9);
  y += 22;

  // Part B
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 12;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("PART B — PHYSICIAN'S REPORT", LM, y);
  y += 14;

  // Problems grid
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  const hW = CW / 2;
  const problemFields = [
    ["Hearing:", data.hearingNotes, "Allergies—Medicine:", data.allergies.medicine],
    ["Vision:", data.visionNotes, "Insect Stings:", data.allergies.insect],
    ["Developmental:", data.developmentalNotes, "Food:", data.allergies.food],
    ["Language/Speech:", data.speechNotes, "Asthma:", data.allergies.asthma ? "Yes" : "No"],
    ["Dental:", data.dentalNotes, "", ""],
    ["Other:", data.otherNotes, "", ""],
  ];
  for (const [lbl1, val1, lbl2, val2] of problemFields) {
    doc.setFont("helvetica", "bold");
    doc.setTextColor(60, 60, 60);
    doc.text(lbl1, LM, y);
    doc.setFont("helvetica", "normal");
    doc.text(val1 || "", LM + 80, y);
    if (lbl2) {
      doc.setFont("helvetica", "bold");
      doc.text(lbl2, LM + hW, y);
      doc.setFont("helvetica", "normal");
      doc.text(val2 || "", LM + hW + 90, y);
    }
    y += 13;
  }
  y += 6;

  // Comments
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("Comments:", LM, y);
  doc.setFont("helvetica", "normal");
  const cmtLines = doc.splitTextToSize(data.comments || "", CW - 60);
  doc.text(cmtLines, LM + 60, y);
  y += Math.max(cmtLines.length * 10, 10) + 8;

  // Medications
  doc.setFont("helvetica", "bold");
  doc.text("Medications/Restrictions:", LM, y);
  doc.setFont("helvetica", "normal");
  doc.text(data.medications || "None", LM + 120, y);
  y += 16;

  // Immunization table
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("IMMUNIZATION HISTORY", LM, y);
  y += 14;

  y = drawImmunizationTable(doc, y, data.immunizations);
  y += 12;

  // TB screening
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(30, 41, 59);
  doc.text("SCREENING OF TB RISK FACTORS", LM, y);
  y += 14;
  drawCheckbox(doc, LM, y, !data.tbRiskPresent, "Risk factors not present; TB skin test not required");
  y += 14;
  drawCheckbox(doc, LM, y, data.tbRiskPresent && data.tbTestPerformed, "Risk factors present; TB skin test performed");
  y += 14;
  drawCheckbox(doc, LM, y, true, "Communicable TB disease not present");
  y += 14;
  drawCheckbox(doc, LM, y, data.reviewedWithParent, "I have reviewed the above information with the parent/guardian");
  y += 24;

  // Physician signature
  y = drawSignatureLine(doc, y, "Physician / PA / NP");
  y += 4;
  drawField(doc, LM, y, "Address", `${PRACTICE.address}, ${PRACTICE.cityStateZip}`, 280);
  drawField(doc, LM + 310, y, "Phone", PRACTICE.phone, 180);

  // Footer
  y += 30;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text("LIC 701 — Confidential", LM, y);

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. KINDERGARTEN ENTRY FORM (California PM 171 A)
// ═══════════════════════════════════════════════════════════════════════════════

export interface KindergartenFormData {
  patient: PatientInfo;
  school: string;
  examDates: {
    healthHistory?: string;
    physicalExam?: string;
    dental?: string;
    nutritional?: string;
    developmental?: string;
    vision?: string;
    hearing?: string;
    tbRisk?: string;
    bloodAnemia?: string;
    urine?: string;
    bloodLead?: string;
  };
  immunizations: ImmunizationEntry[];
  noConditionsOfConcern: boolean;
  conditionsFound: string;
}

export function generateKindergartenForm(data: KindergartenFormData): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  let y = TM;

  // State header
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("State of California — Health and Human Services Agency — Department of Health Care Services", PW / 2, y, { align: "center" });
  y += 10;
  doc.text("Child Health and Disability Prevention (CHDP) Program", PW / 2, y, { align: "center" });
  y += 16;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(30, 41, 59);
  doc.text("REPORT OF HEALTH EXAMINATION FOR SCHOOL ENTRY", PW / 2, y, { align: "center" });
  y += 8;
  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("PM 171 A", PW / 2, y, { align: "center" });
  y += 16;

  // Part I — Parent info
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("PART I — TO BE FILLED OUT BY PARENT OR GUARDIAN", LM, y);
  y += 14;

  const { patient } = data;
  y = drawField(doc, LM, y, "Child's Name", patient.name, 280);
  drawField(doc, LM + 310, y - 24, "Date of Birth", fmtDate(patient.dob), 180);
  const addr = [patient.address, patient.city, patient.state, patient.zip].filter(Boolean).join(", ");
  y = drawField(doc, LM, y, "Address", addr, 280);
  drawField(doc, LM + 310, y - 24, "School", data.school, 180);
  y += 4;

  // Part II — Health examiner
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("PART II — TO BE FILLED OUT BY HEALTH EXAMINER", LM, y);
  y += 16;

  // Two columns: Tests/evaluations on left, immunizations on right
  const colL = LM;
  const colR = LM + CW / 2 + 10;
  const colHalf = CW / 2 - 10;

  // Left: Required tests
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("REQUIRED TESTS / EVALUATIONS", colL, y);
  doc.text("IMMUNIZATION RECORD", colR, y);
  y += 12;

  const tests = [
    ["Health History", data.examDates.healthHistory],
    ["Physical Examination", data.examDates.physicalExam],
    ["Dental Assessment", data.examDates.dental],
    ["Nutritional Assessment", data.examDates.nutritional],
    ["Developmental Assessment", data.examDates.developmental],
    ["Vision Screening", data.examDates.vision],
    ["Hearing Screening", data.examDates.hearing],
    ["TB Risk Assessment", data.examDates.tbRisk],
    ["Blood Test (anemia)", data.examDates.bloodAnemia],
    ["Urine Test", data.examDates.urine],
    ["Blood Lead Test", data.examDates.bloodLead],
  ];

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  let testY = y;
  for (const [label, date] of tests) {
    doc.setTextColor(60, 60, 60);
    doc.text(label as string, colL, testY);
    doc.text(date ? fmtDate(date as string) : "____/____/____", colL + 140, testY);
    testY += 13;
  }

  // Right: Immunization table (compact)
  const immY = drawImmunizationTableCompact(doc, y, colR, colHalf, data.immunizations);

  y = Math.max(testY, immY) + 12;

  // Part III
  y = ensurePage(doc, y, 100);
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.line(LM, y, PW - RM, y);
  y += 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(30, 41, 59);
  doc.text("PART III — RESULTS AND RECOMMENDATIONS", LM, y);
  y += 16;

  drawCheckbox(doc, LM, y, data.noConditionsOfConcern, "Examination shows no condition of concern to school program activities");
  y += 16;
  drawCheckbox(doc, LM, y, !data.noConditionsOfConcern && !!data.conditionsFound, "Conditions found that are of importance to schooling or physical activity:");
  y += 14;

  if (data.conditionsFound) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const condLines = doc.splitTextToSize(data.conditionsFound, CW - 20);
    doc.text(condLines, LM + 10, y);
    y += condLines.length * 12 + 8;
  } else {
    // Blank lines
    doc.setDrawColor(203, 213, 225);
    for (let i = 0; i < 2; i++) { y += 14; doc.line(LM + 10, y, PW - RM, y); }
    y += 10;
  }

  // Signatures
  y += 12;
  y = drawSignatureLine(doc, y, "Signature of Health Examiner");
  y += 4;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(`${PRACTICE.provider} · ${PRACTICE.address}, ${PRACTICE.cityStateZip} · ${PRACTICE.phone}`, LM, y);

  return doc;
}

// ─── Shared Immunization Table Helpers ────────────────────────────────────────

function drawImmunizationTable(doc: jsPDF, y: number, immunizations: ImmunizationEntry[]): number {
  const grouped = groupImmunizations(immunizations);
  const maxDoses = 5;
  const colW = (CW - 120) / maxDoses;

  // Header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text("VACCINE", LM + 4, y);
  for (let i = 0; i < maxDoses; i++) {
    doc.text(`${i + 1}st`, LM + 120 + i * colW + colW / 2, y, { align: "center" });
  }
  y += 4;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.3);
  doc.line(LM, y, PW - RM, y);
  y += 10;

  // Rows
  const vaccineRows = ["Polio (OPV/IPV)", "DTaP/DTP/DT/Td", "MMR", "Hib", "Hepatitis B", "Varicella"];
  doc.setFontSize(8);
  for (const vax of vaccineRows) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 41, 59);
    doc.text(vax, LM + 4, y);
    const key = Object.keys(grouped).find(k =>
      vax.toLowerCase().split(/[/() ]+/).some(part => k.toLowerCase().includes(part))
    );
    const doses = key ? grouped[key] : [];
    for (let i = 0; i < Math.min(doses.length, maxDoses); i++) {
      doc.text(fmtDate(doses[i].date), LM + 120 + i * colW, y);
    }
    y += 14;
  }

  return y;
}

function drawImmunizationTableCompact(doc: jsPDF, startY: number, x: number, width: number, immunizations: ImmunizationEntry[]): number {
  const grouped = groupImmunizations(immunizations);
  const maxDoses = 5;
  const nameW = 80;
  const doseW = (width - nameW) / maxDoses;
  let y = startY;

  // Header
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.setTextColor(100, 116, 139);
  doc.text("VACCINE", x, y);
  for (let i = 0; i < maxDoses; i++) {
    doc.text(`${i + 1}`, x + nameW + i * doseW + doseW / 2, y, { align: "center" });
  }
  y += 4;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.2);
  doc.line(x, y, x + width, y);
  y += 8;

  const vaccineRows = ["Polio", "DTaP/DTP", "MMR", "Hib", "Hep B", "Varicella", "Other"];
  doc.setFontSize(7);
  for (const vax of vaccineRows) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 41, 59);
    doc.text(vax, x, y);
    const key = Object.keys(grouped).find(k =>
      vax.toLowerCase().split(/[/() ]+/).some(part => k.toLowerCase().includes(part))
    );
    const doses = key ? grouped[key] : [];
    doc.setFontSize(6);
    for (let i = 0; i < Math.min(doses.length, maxDoses); i++) {
      doc.text(fmtDate(doses[i].date), x + nameW + i * doseW, y);
    }
    doc.setFontSize(7);
    y += 13;
  }

  return y;
}

function groupImmunizations(immunizations: ImmunizationEntry[]): Record<string, { date: string; dose?: number }[]> {
  const grouped: Record<string, { date: string; dose?: number }[]> = {};
  for (const imm of immunizations) {
    if (!grouped[imm.vaccine]) grouped[imm.vaccine] = [];
    grouped[imm.vaccine].push({ date: imm.date, dose: imm.dose });
  }
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }
  return grouped;
}
