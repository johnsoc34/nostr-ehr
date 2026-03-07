/**
 * src/lib/growth.ts
 * Pediatric growth chart data and percentile calculations
 * WHO standards (0-24 months) and CDC growth charts (2-20 years)
 * Weight-for-age and Length/Height-for-age
 */

// ─── WHO Weight-for-age (0-24 months) boys — L, M, S parameters ──────────────
// Source: WHO Child Growth Standards
// Months: 0,1,2,3,4,5,6,9,12,15,18,21,24
export const WHO_WEIGHT_BOYS: Record<number, {L:number;M:number;S:number}> = {
   0: {L:0.3487,  M:3.3464,  S:0.14602},
   1: {L:0.2297,  M:4.4709,  S:0.13395},
   2: {L:0.1970,  M:5.5675,  S:0.12385},
   3: {L:0.2986,  M:6.3762,  S:0.11727},
   4: {L:0.3317,  M:7.0023,  S:0.11316},
   5: {L:0.3952,  M:7.5105,  S:0.10988},
   6: {L:0.4202,  M:7.9340,  S:0.10760},
   9: {L:0.4923,  M:9.1835,  S:0.10535},
  12: {L:0.5172,  M:9.6479,  S:0.10390},
  15: {L:0.5133,  M:10.1687, S:0.10279},
  18: {L:0.4951,  M:10.6498, S:0.10171},
  21: {L:0.4779,  M:11.1347, S:0.10118},
  24: {L:0.4579,  M:11.5098, S:0.10040},
};

export const WHO_WEIGHT_GIRLS: Record<number, {L:number;M:number;S:number}> = {
   0: {L:0.3809,  M:3.2322,  S:0.14171},
   1: {L:0.1714,  M:4.1873,  S:0.13724},
   2: {L:0.1714,  M:5.1282,  S:0.13000},
   3: {L:0.2475,  M:5.8458,  S:0.12619},
   4: {L:0.3163,  M:6.4237,  S:0.12402},
   5: {L:0.3711,  M:6.8985,  S:0.12274},
   6: {L:0.4156,  M:7.2981,  S:0.12144},
   9: {L:0.4720,  M:8.4800,  S:0.11966},
  12: {L:0.5116,  M:8.9481,  S:0.11770},
  15: {L:0.4967,  M:9.4367,  S:0.11584},
  18: {L:0.4828,  M:9.9250,  S:0.11395},
  21: {L:0.4598,  M:10.4264, S:0.11246},
  24: {L:0.4404,  M:10.8573, S:0.11090},
};

// ─── CDC Weight-for-age (2-20 years) — selected percentile values ─────────────
// P3, P5, P10, P25, P50, P75, P90, P95, P97 at key ages
// Values in kg, ages in years
export const CDC_WEIGHT_BOYS_PERCENTILES: Record<number, number[]> = {
  // age: [P3, P5, P10, P25, P50, P75, P90, P95, P97]
   2: [10.5, 10.8, 11.2, 12.0, 12.9, 13.9, 14.8, 15.3, 15.8],
   4: [13.5, 13.9, 14.6, 15.7, 17.0, 18.5, 20.0, 20.9, 21.8],
   6: [16.8, 17.4, 18.3, 19.9, 21.7, 23.9, 26.3, 27.8, 29.0],
   8: [20.4, 21.3, 22.5, 24.6, 27.1, 30.5, 34.3, 36.7, 38.7],
  10: [24.7, 25.8, 27.5, 30.5, 34.3, 39.6, 46.0, 50.2, 53.3],
  12: [30.0, 31.5, 33.9, 38.3, 44.0, 51.5, 60.5, 66.5, 70.8],
  14: [37.5, 39.4, 42.5, 48.3, 55.8, 65.0, 76.1, 83.8, 89.7],
  16: [46.0, 48.2, 51.9, 58.4, 66.3, 76.2, 87.8, 96.1,102.6],
  18: [52.5, 54.9, 58.9, 66.0, 74.4, 84.9, 97.5,107.1,114.6],
  20: [55.5, 58.0, 62.2, 69.6, 78.4, 89.7,103.3,114.0,122.5],
};

export const CDC_WEIGHT_GIRLS_PERCENTILES: Record<number, number[]> = {
   2: [10.2, 10.5, 11.0, 11.8, 12.8, 13.9, 14.9, 15.5, 16.0],
   4: [13.1, 13.5, 14.2, 15.4, 16.8, 18.5, 20.2, 21.3, 22.2],
   6: [16.1, 16.7, 17.7, 19.4, 21.4, 23.8, 26.5, 28.3, 29.8],
   8: [19.6, 20.5, 21.9, 24.3, 27.5, 31.6, 36.4, 39.7, 42.3],
  10: [24.0, 25.2, 27.3, 31.0, 36.0, 43.0, 51.5, 57.3, 61.8],
  12: [30.0, 31.7, 34.5, 39.9, 46.9, 55.7, 66.0, 73.3, 79.4],
  14: [37.0, 39.1, 42.7, 49.5, 58.0, 68.3, 80.3, 89.1, 96.8],
  16: [42.0, 44.2, 48.2, 55.8, 64.8, 76.0, 89.4, 99.7,108.4],
  18: [44.5, 46.9, 51.1, 59.1, 68.5, 80.5, 95.2,106.6,116.0],
  20: [45.5, 48.0, 52.3, 60.5, 70.1, 82.5, 97.9,110.1,120.2],
};

// ─── LMS method for percentile calculation ────────────────────────────────────
export function lmsPercentile(x: number, L: number, M: number, S: number): number {
  if (L === 0) return Math.exp(Math.log(x / M) / S);
  const z = (Math.pow(x / M, L) - 1) / (L * S);
  return normalCDF(z) * 100;
}

function normalCDF(z: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
  return 0.5 * (1 + sign * y);
}

// Interpolate LMS params for a given age in months
export function interpolateLMS(
  ageMonths: number,
  table: Record<number, {L:number;M:number;S:number}>
): {L:number;M:number;S:number} | null {
  const ages = Object.keys(table).map(Number).sort((a,b)=>a-b);
  if (ageMonths <= ages[0]) return table[ages[0]];
  if (ageMonths >= ages[ages.length-1]) return table[ages[ages.length-1]];
  let lo = ages[0], hi = ages[1];
  for (let i=0;i<ages.length-1;i++) {
    if (ages[i]<=ageMonths && ageMonths<=ages[i+1]) { lo=ages[i]; hi=ages[i+1]; break; }
  }
  const t = (ageMonths-lo)/(hi-lo);
  const L1=table[lo],L2=table[hi];
  return { L:L1.L+(L2.L-L1.L)*t, M:L1.M+(L2.M-L1.M)*t, S:L1.S+(L2.S-L1.S)*t };
}

// Get percentile curves for charting (returns array of {age, p3, p5, p10, p25, p50, p75, p90, p95, p97})
export function getWHOWeightCurves(sex: "male"|"female") {
  const table = sex==="male" ? WHO_WEIGHT_BOYS : WHO_WEIGHT_GIRLS;
  const ZSCORE_MAP = [-1.881,-1.645,-1.282,-0.674,0,0.674,1.282,1.645,1.881]; // p3..p97
  return Object.entries(table).map(([age,lms])=>{
    const ageN=Number(age);
    const vals = ZSCORE_MAP.map(z => {
      if (lms.L===0) return lms.M*Math.exp(z*lms.S);
      return lms.M*Math.pow(1+lms.L*lms.S*z, 1/lms.L);
    });
    return { age:ageN, p3:vals[0],p5:vals[1],p10:vals[2],p25:vals[3],
             p50:vals[4],p75:vals[5],p90:vals[6],p95:vals[7],p97:vals[8] };
  }).sort((a,b)=>a.age-b.age);
}

export function getCDCWeightCurves(sex: "male"|"female") {
  const table = sex==="male" ? CDC_WEIGHT_BOYS_PERCENTILES : CDC_WEIGHT_GIRLS_PERCENTILES;
  return Object.entries(table).map(([age,vals])=>({
    age:Number(age)*12, // convert years to months for consistent x-axis
    p3:vals[0],p5:vals[1],p10:vals[2],p25:vals[3],
    p50:vals[4],p75:vals[5],p90:vals[6],p95:vals[7],p97:vals[8],
  })).sort((a,b)=>a.age-b.age);
}
