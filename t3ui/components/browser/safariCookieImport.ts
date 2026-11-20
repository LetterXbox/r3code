// Safari cookie import (H6): the reference's SafariCookies.ts, ported from Buffer to Uint8Array/DataView (this app has
// no Node Buffer). Safari's Cookies.binarycookies is a plain binary format (pages of fixed-layout records); no
// decryption, no sqlite. Full Disk Access is required to read the file at all (SafariPermission.ts): `stat` succeeds
// without it, so presence alone never proves the cookies are readable — the caller must attempt the actual read.
import { cookieScope, type ImportedCookie } from "./cookieScope";

/** Safari's timestamps count seconds from 2001-01-01, not the UNIX epoch. */
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const COOKIE_PAGE_HEADER_SIZE = 12;
const COOKIE_RECORD_HEADER_SIZE = 56;
const FLAG_SECURE = 0x1;
const FLAG_HTTP_ONLY = 0x4;

export class SafariCookieFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafariCookieFormatError";
  }
}

function readCString(bytes: Uint8Array, start: number): string {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

export function parseBinaryCookies(bytes: Uint8Array): ReadonlyArray<ImportedCookie> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || new TextDecoder("latin1").decode(bytes.subarray(0, 4)) !== "cook") {
    throw new SafariCookieFormatError("Not a Safari cookie database.");
  }

  const pageCount = view.getUint32(4, false);
  if (8 + pageCount * 4 > bytes.length) throw new SafariCookieFormatError("Truncated page table.");
  const pageSizes: number[] = [];
  for (let index = 0; index < pageCount; index += 1) pageSizes.push(view.getUint32(8 + index * 4, false));

  const cookies: ImportedCookie[] = [];
  let pageStart = 8 + pageCount * 4;

  for (const pageSize of pageSizes) {
    if (pageSize < COOKIE_PAGE_HEADER_SIZE || pageStart + pageSize > bytes.length) throw new SafariCookieFormatError("Truncated page.");
    const pageOffset = pageStart;
    pageStart += pageSize;

    // Page bodies switch to little-endian after the big-endian header.
    const cookieCount = view.getUint32(pageOffset + 4, true);
    const offsetTableEnd = COOKIE_PAGE_HEADER_SIZE + cookieCount * 4;
    if (offsetTableEnd > pageSize) throw new SafariCookieFormatError("Truncated cookie offset table.");

    const accepted: Array<readonly [start: number, end: number]> = [];
    for (let index = 0; index < cookieCount; index += 1) {
      const cookieStart = view.getUint32(pageOffset + 8 + index * 4, true);
      if (cookieStart < offsetTableEnd || cookieStart + COOKIE_RECORD_HEADER_SIZE > pageSize) throw new SafariCookieFormatError("Invalid cookie offset.");
      const recordSize = view.getUint32(pageOffset + cookieStart, true);
      const cookieEnd = cookieStart + recordSize;
      if (recordSize < COOKIE_RECORD_HEADER_SIZE || cookieEnd > pageSize || accepted.some(([start, end]) => cookieStart < end && cookieEnd > start)) {
        throw new SafariCookieFormatError("Invalid or overlapping cookie record.");
      }
      accepted.push([cookieStart, cookieEnd]);
      const base = pageOffset + cookieStart;
      const cookieLength = cookieEnd - cookieStart;

      const flags = view.getUint32(base + 8, true);
      const urlOffset = view.getUint32(base + 16, true);
      const nameOffset = view.getUint32(base + 20, true);
      const pathOffset = view.getUint32(base + 24, true);
      const valueOffset = view.getUint32(base + 28, true);
      const expiry = view.getFloat64(base + 40, true);

      if ([urlOffset, nameOffset, pathOffset, valueOffset].some((offset) => offset < COOKIE_RECORD_HEADER_SIZE || offset >= cookieLength)) {
        throw new SafariCookieFormatError("Invalid field offset.");
      }
      const domain = readCString(bytes, base + urlOffset);
      const name = readCString(bytes, base + nameOffset);
      const path = readCString(bytes, base + pathOffset);
      const value = readCString(bytes, base + valueOffset);
      if (domain === "" || name === "") continue;

      const secure = (flags & FLAG_SECURE) !== 0;
      const expirationDate = expiry > 0 ? Math.floor(expiry) + APPLE_EPOCH_OFFSET_SECONDS : undefined;

      cookies.push({
        ...cookieScope(domain, path || "/", secure),
        name,
        value,
        path: path || "/",
        secure,
        httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
        expirationDate,
        // Safari's SameSite flag encoding is undocumented; guessing None would widen cookie scope.
        sameSite: "lax",
      });
    }
  }

  // Pages end with an 8-byte checksum and an optional length-prefixed plist.
  const trailer = bytes.length - pageStart;
  const validTrailer = trailer === 0 || trailer === 8 || (trailer >= 12 && trailer === 8 + 4 + view.getUint32(pageStart + 8, false));
  if (!validTrailer) throw new SafariCookieFormatError("Invalid trailer.");

  return cookies;
}
