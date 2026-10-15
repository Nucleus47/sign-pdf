import { describe, expect, it } from 'vitest';
import { appAddress } from './appAddress.ts';

describe('where the next signer opens the app', () => {
  it('uses the hosted address, and none for this computer only', () => {
    expect(appAddress(undefined, { hostname: 'sign.example.org', origin: 'https://sign.example.org' })).toEqual({
      url: 'https://sign.example.org',
      shown: 'sign.example.org',
    });
    expect(appAddress(undefined, { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' })).toBeNull();
    expect(appAddress(undefined, { hostname: 'localhost', origin: 'http://localhost:5173' })).toBeNull();
    expect(appAddress(undefined, { hostname: '[::1]', origin: 'http://[::1]:5173' })).toBeNull();
  });

  it('prefers the build setting, and leaves out an address that is not printable ASCII', () => {
    expect(appAddress(' https://pdf.example.net/ ', { hostname: '127.0.0.1', origin: 'http://127.0.0.1' })?.shown).toBe(
      'pdf.example.net',
    );
    expect(appAddress('https://bücher.example', { hostname: 'x', origin: 'https://x' })).toBeNull();
  });

  it('gives no address for a page that is not on the web', () => {
    expect(appAddress(undefined, { hostname: '', origin: 'null' })).toBeNull();
    expect(appAddress(undefined, { hostname: '', origin: 'file://' })).toBeNull();
    expect(appAddress('null', { hostname: 'x', origin: 'https://x' })).toBeNull();
    expect(appAddress('sign.example.org', { hostname: 'x', origin: 'https://x' })).toBeNull();
    expect(appAddress('ftp://sign.example.org', { hostname: 'x', origin: 'https://x' })).toBeNull();
  });
});
