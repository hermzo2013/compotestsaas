// Réduit les images lourdes (favicon.png 1,4 Mo, site.png 1,1 Mo) : elles sont chargées à chaque ouverture de l'app.
import sharp from 'sharp';
import fs from 'node:fs/promises';
await fs.mkdir('./optimized', { recursive: true });
await sharp('./logo-source.png').resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png({ compressionLevel: 9, palette: true, quality: 90 }).toFile('./optimized/favicon.png');
await sharp('./site.png').resize({ width: 900 }).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile('./optimized/site.png');
for (const f of ['favicon.png', 'site.png']) {
  const [a, b] = await Promise.all([fs.stat(f), fs.stat('./optimized/' + f)]);
  console.log(`${f}: ${(a.size / 1024).toFixed(0)} Ko -> ${(b.size / 1024).toFixed(0)} Ko`);
}
