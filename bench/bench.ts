// Rough timings on synthetic data. Run: npm run bench
import { detectDrift, detectLeakage, detectOverlap, inferContract, profile, validate } from '../src/index';

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function rows(seed: number, count: number, shift = 0) {
  const random = rng(seed);
  const regions = ['north', 'south', 'east', 'west'];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      claim_id: `CLM-${seed}-${i}`,
      amount: Math.round(random() * 5000 + shift),
      age: 18 + Math.floor(random() * 60),
      region: regions[Math.floor(random() * regions.length)]!,
      status: random() < 0.7 ? 'closed' : 'open',
      reported_at: new Date(Date.UTC(2024, 0, 1 + Math.floor(random() * 30))).toISOString(),
      fraud: random() < 0.05,
      score: random(),
    });
  }
  return out;
}

const size = Number(process.argv[2] ?? 100_000);
const reference = rows(1, size);
const current = rows(2, size, 250);
const contract = inferContract(reference.slice(0, 5000), { name: 'claims' });
contract.grain = ['claim_id'];

const time = (label: string, fn: () => unknown) => {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)} ms`);
  return result;
};

console.log(`${size.toLocaleString('en-US')} rows x ${Object.keys(reference[0]!).length} columns (node ${process.version})`);
time('validate (contract + grain)', () => validate(contract, reference));
time('profile', () => profile(reference));
const report = time('detectDrift', () => detectDrift(reference, current)) as ReturnType<typeof detectDrift>;
console.log(`drifted: ${report.drifted.join(', ') || 'none'}`);
const leakage = time('detectLeakage', () => detectLeakage(reference, { label: 'fraud', exclude: ['claim_id'] })) as ReturnType<typeof detectLeakage>;
console.log(`flagged: ${leakage.flagged.join(', ') || 'none'}`);
time('detectOverlap (keys)', () => detectOverlap(reference, current, { keys: ['claim_id'] }));
