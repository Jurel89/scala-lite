import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

function readPngDimensions(filePath: string): { width: number; height: number } {
  const bytes = fs.readFileSync(filePath);
  const signature = bytes.subarray(0, 8);
  const expectedSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(signature.equals(expectedSignature), true);

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return { width, height };
}

test('TC-0006: icon exists, is 128x128 PNG, and package references it', () => {
  const iconPath = path.resolve(process.cwd(), 'assets/icon.png');
  assert.equal(fs.existsSync(iconPath), true);

  const dimensions = readPngDimensions(iconPath);
  assert.equal(dimensions.width, 128);
  assert.equal(dimensions.height, 128);

  const stat = fs.statSync(iconPath);
  assert.equal(stat.size < 100 * 1024, true);

  const packageJson = JSON.parse(readSource('package.json')) as {
    icon: string;
    galleryBanner: { color: string; theme: string };
  };

  assert.equal(packageJson.icon, 'assets/icon.png');
  assert.equal(typeof packageJson.galleryBanner?.color, 'string');
  assert.equal(typeof packageJson.galleryBanner?.theme, 'string');
});

test('TC-0006: vscodeignore keeps assets included for VSIX', () => {
  const vscodeIgnore = readSource('.vscodeignore');
  assert.equal(vscodeIgnore.includes('!assets/**'), true);
});
