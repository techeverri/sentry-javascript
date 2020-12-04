import { getGlobalObject } from './compat';
import { SentryError } from './error';
import { isRegExp, isString } from './is';

// credit to https://rgxdb.com/; see https://tools.ietf.org/html/rfc4648#section-4 for base64 spec
// eslint-disable-next-line no-useless-escape
export const BASE64_REGEX = /^(?:[a-zA-Z0-9+\/]{4})*(?:|(?:[a-zA-Z0-9+\/]{3}=)|(?:[a-zA-Z0-9+\/]{2}==)|(?:[a-zA-Z0-9+\/]{1}===))$/;

/**
 * Truncates given string to the maximum characters count
 *
 * @param str An object that contains serializable values
 * @param max Maximum number of characters in truncated string
 * @returns string Encoded
 */
export function truncate(str: string, max: number = 0): string {
  if (typeof str !== 'string' || max === 0) {
    return str;
  }
  return str.length <= max ? str : `${str.substr(0, max)}...`;
}

/**
 * This is basically just `trim_line` from
 * https://github.com/getsentry/sentry/blob/master/src/sentry/lang/javascript/processor.py#L67
 *
 * @param str An object that contains serializable values
 * @param max Maximum number of characters in truncated string
 * @returns string Encoded
 */
export function snipLine(line: string, colno: number): string {
  let newLine = line;
  const ll = newLine.length;
  if (ll <= 150) {
    return newLine;
  }
  if (colno > ll) {
    // eslint-disable-next-line no-param-reassign
    colno = ll;
  }

  let start = Math.max(colno - 60, 0);
  if (start < 5) {
    start = 0;
  }

  let end = Math.min(start + 140, ll);
  if (end > ll - 5) {
    end = ll;
  }
  if (end === ll) {
    start = Math.max(end - 140, 0);
  }

  newLine = newLine.slice(start, end);
  if (start > 0) {
    newLine = `'{snip} ${newLine}`;
  }
  if (end < ll) {
    newLine += ' {snip}';
  }

  return newLine;
}

/**
 * Join values in array
 * @param input array of values to be joined together
 * @param delimiter string to be placed in-between values
 * @returns Joined values
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeJoin(input: any[], delimiter?: string): string {
  if (!Array.isArray(input)) {
    return '';
  }

  const output = [];
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    try {
      output.push(String(value));
    } catch (e) {
      output.push('[value cannot be serialized]');
    }
  }

  return output.join(delimiter);
}

/**
 * Checks if the value matches a regex or includes the string
 * @param value The string value to be checked against
 * @param pattern Either a regex or a string that must be contained in value
 */
export function isMatchingPattern(value: string, pattern: RegExp | string): boolean {
  if (!isString(value)) {
    return false;
  }

  if (isRegExp(pattern)) {
    return (pattern as RegExp).test(value);
  }
  if (typeof pattern === 'string') {
    return value.indexOf(pattern) !== -1;
  }
  return false;
}

// TODO: Base64 crossed with different character encodings turns out to be a ridiculous can of worms. Base64 expects
// 8-bit data. JS only uses UTF-16. We need a way to be sure that every SDK is speaking the same language and can decode
// values base64-encoded by other SDKs. The current proposal is to use UTF-8 as the common standard, and then
// base64-encode that (meaning in JS we need to get there first). Doing it that way makes a whole lot of sense but is a
// work in progress which isn't yet actually working. Leaving the current solution for now and will come back to it.

/**
 * Convert a Unicode string to a string in which each 16-bit unit occupies only one byte, which makes it safe to use as
 * input to `btoa`.
 *
 * Copied from https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/btoa#Unicode_strings.
 *
 * @param unicodeString The string to convert
 * @returns A btoa-compatible encoding of the string
 */
function unicodeToBinary(unicodeString: string): string {
  const codeUnits = new Uint16Array(unicodeString.length);
  for (let i = 0; i < codeUnits.length; i++) {
    codeUnits[i] = unicodeString.charCodeAt(i);
  }
  return String.fromCharCode(...new Uint8Array(codeUnits.buffer));
}

/**
 * Convert a binary string (such as one would get from `atob`) into a Unicode string.
 *
 * Copied from https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/btoa#Unicode_strings.
 *
 * @param binaryString The string to convert
 * @returns A btoa-compatible encoding of the string
 */
function binaryToUnicode(binaryString: string): string {
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return String.fromCharCode(...new Uint16Array(bytes.buffer));
}

/**
 * Convert a base64 string to a Unicode (UTF-16) string.
 *
 * @param base64String The string to decode.
 * @throws SentryError (because using the logger creates a circular dependency)
 * @returns A Unicode string
 */
export function base64ToUnicode(base64String: string): string {
  if (typeof base64String !== 'string' || !BASE64_REGEX.test(base64String)) {
    throw new SentryError(`Unable to convert from base64. Input either isn't a string or isn't valid base64.`);
  }

  const errMsg = `Unable to convert string from base64: ${
    base64String.length > 256 ? `${base64String.slice(0, 256)}...` : base64String
  }`;

  try {
    // browsers have atob built in
    if ('atob' in getGlobalObject()) {
      // atob takes base64 (written in (a)scii) to (b)inary
      return binaryToUnicode(atob(base64String));
    }

    // Buffer only exists in node
    if ('Buffer' in getGlobalObject()) {
      return Buffer.from(base64String, 'base64').toString('utf16le');
    }
  } catch (err) {
    throw new SentryError(`${errMsg} Got error: ${err}`);
  }

  throw new SentryError(errMsg);
}

/**
 * Convert a Unicode (UTF-16) string to a base64 string.
 *
 * @param unicodeString The string to encode
 * @throws SentryError (because using the logger creates a circular dependency)
 * @returns A base64-encoded version of the string
 */
export function unicodeToBase64(unicodeString: string): string {
  if (typeof unicodeString !== 'string') {
    throw new SentryError(`Unable to convert to base64. Input isn't a string.`);
  }

  const errMsg = `Unable to convert string to base64: ${
    unicodeString.length > 256 ? `${unicodeString.slice(0, 256)}...` : unicodeString
  }`;

  try {
    // browsers have btoa built in
    if ('btoa' in getGlobalObject()) {
      // btoa takes (b)inary to base64 (written in (a)scii)
      return btoa(unicodeToBinary(unicodeString));
    }

    // Buffer only exists in node
    if ('Buffer' in getGlobalObject()) {
      return Buffer.from(unicodeString, 'utf16le').toString('base64');
    }
  } catch (err) {
    throw new SentryError(`${errMsg} Got error: ${err}`);
  }

  throw new SentryError(errMsg);
}
