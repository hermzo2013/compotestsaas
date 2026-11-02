import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const SRC = './logo-source.png';           // logo carré (rempli de vert, coins arrondis)
const OUT = './icons';
const BG_COLOR = { r: 6, g: 78, b: 59, alpha: 1 }; // #064E3B (vert foncé Révisio)

await fs.mkdir(OUT, { recursive: true });

// Le logo source a une marge vide autour : on la retire pour que l'icône remplisse son carré.
const logoBuf = await sharp(SRC).trim({ threshold: 12 }).toBuffer();

// Icône "any" : le logo occupe presque tout le carré, coins arrondis conservés (fond transparent).
async function makeAny(size, filename, marginPct = 0.03) {
  const inner = Math.round(size * (1 - marginPct * 2));
  const logo = await sharp(logoBuf).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: logo, gravity: 'center' }])
    .png({ compressionLevel: 9 }).toFile(path.join(OUT, filename));
  console.log(`✅ ${filename} (${size}×${size})`);
}

// Icône pleine (maskable Android, iOS) : fond vert plein, le système découpe lui-même la forme.
// scale = part du carré occupée par le logo (la zone sûre maskable = 80 % au centre).
async function makeFull(size, filename, scale) {
  const inner = Math.round(size * scale);
  const logo = await sharp(logoBuf).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG_COLOR } })
    .composite([{ input: logo, gravity: 'center' }])
    .flatten({ background: BG_COLOR })
    .png({ compressionLevel: 9 }).toFile(path.join(OUT, filename));
  console.log(`✅ ${filename} (${size}×${size})`);
}

await makeAny(192, 'icon-192.png');
await makeAny(512, 'icon-512.png');
await makeFull(512, 'icon-maskable-512.png', 1.0);    // le symbole central reste dans la zone sûre (80 %)
await makeFull(180, 'apple-touch-icon.png', 1.0);      // iOS : pas de transparence, il arrondit lui-même

console.log('🎉 Toutes les icônes sont dans /icons');
