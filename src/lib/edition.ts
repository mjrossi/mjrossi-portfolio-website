// Masthead edition line: "Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>".
// Built at request time on every on-demand page so the line stays current
// without a scheduled rebuild.

const ROMAN_MAP: [number, string][] = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

export function toRoman(n: number): string {
  let out = '';
  let rem = n;
  for (const [v, s] of ROMAN_MAP) {
    while (rem >= v) { out += s; rem -= v; }
  }
  return out;
}

// Site launched in 2025, so 2025 = Vol. I, 2026 = Vol. II, etc.
const VOLUME_EPOCH = 2024;

export function editionLine(now: Date = new Date()): string {
  const monthYear = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return `Vol. ${toRoman(now.getFullYear() - VOLUME_EPOCH)} · No. ${toRoman(now.getMonth() + 1)} · ${monthYear}`;
}
