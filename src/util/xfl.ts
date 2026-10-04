/**
 * XRPL / Xahau XFL (8-byte) decoder. Used by Evernode lease amounts.
 * Same layout as evernode-js-client XflHelpers.toString.
 */
export function xflToString(xfl: bigint): string {
  if (xfl < 0n) {
    throw new Error('Invalid XFL');
  }
  if (xfl === 0n) {
    return '0';
  }

  const exponent = ((xfl >> 54n) & 0xffn) - 97n;
  const mantissa = xfl - ((xfl >> 54n) << 54n);
  const negative = ((xfl >> 62n) & 1n) === 0n;
  const mantissaStr = mantissa.toString();
  const result = formatXflDigits(mantissaStr, exponent);
  return `${negative ? '-' : ''}${result.replace(/\.+$/, '')}`;
}

function formatXflDigits(mantissaStr: string, exponent: bigint): string {
  if (exponent > 0n) {
    return mantissaStr.padEnd(mantissaStr.length + Number(exponent), '0');
  }
  const shifted = Number(exponent) + mantissaStr.length;
  const cleaned = mantissaStr.replace(/0+$/, '');
  if (shifted === 0) {
    return `0.${cleaned}`;
  }
  if (shifted < 0) {
    return `0.${cleaned.padStart(-shifted + cleaned.length, '0')}`;
  }
  return `${mantissaStr.slice(0, shifted)}.${mantissaStr.slice(shifted).replace(/0+$/, '')}`;
}
