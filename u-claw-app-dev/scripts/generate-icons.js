#!/usr/bin/env node
// Generate PNG icon from SVG, then create ICNS and ICO
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const assetsDir = path.join(__dirname, '..', 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');
const pngPath = path.join(assetsDir, 'icon.png');

// Check if sips is available (macOS)
try {
  // Use rsvg-convert or sips to create PNG from SVG
  // First try rsvg-convert
  try {
    execSync(`rsvg-convert -w 1024 -h 1024 "${svgPath}" -o "${pngPath}"`, { stdio: 'inherit' });
    console.log('Created icon.png via rsvg-convert');
  } catch {
    // Fallback: create a simple PNG placeholder using sips
    // sips can't convert SVG directly, so we'll use a different approach
    console.log('rsvg-convert not found, trying alternative...');

    // Try using Python with cairosvg
    try {
      execSync(`python3 -c "
import cairosvg
cairosvg.svg2png(url='${svgPath}', write_to='${pngPath}', output_width=1024, output_height=1024)
"`, { stdio: 'inherit' });
      console.log('Created icon.png via cairosvg');
    } catch {
      console.log('cairosvg not available either.');
      console.log('Please install: brew install librsvg  OR  pip3 install cairosvg');
      console.log('Then run this script again.');
      console.log('');
      console.log('Or manually convert assets/icon.svg to assets/icon.png (1024x1024)');
      process.exit(1);
    }
  }

  // Create ICNS for macOS
  const iconsetDir = path.join(assetsDir, 'icon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    const outFile = size === 1024
      ? path.join(iconsetDir, 'icon_512x512@2x.png')
      : path.join(iconsetDir, `icon_${size}x${size}.png`);
    execSync(`sips -z ${size} ${size} "${pngPath}" --out "${outFile}"`, { stdio: 'pipe' });

    // Also create @2x versions
    if (size <= 512 && size > 16) {
      const halfSize = size / 2;
      const out2x = path.join(iconsetDir, `icon_${halfSize}x${halfSize}@2x.png`);
      execSync(`sips -z ${size} ${size} "${pngPath}" --out "${out2x}"`, { stdio: 'pipe' });
    }
  }

  execSync(`iconutil -c icns "${iconsetDir}" -o "${path.join(assetsDir, 'icon.icns')}"`, { stdio: 'inherit' });
  console.log('Created icon.icns');

  // Clean up iconset
  fs.rmSync(iconsetDir, { recursive: true });

  // Create ICO for Windows (use png2ico or ImageMagick)
  try {
    // Try with ImageMagick
    execSync(`convert "${pngPath}" -define icon:auto-resize=256,128,64,48,32,16 "${path.join(assetsDir, 'icon.ico')}"`, { stdio: 'inherit' });
    console.log('Created icon.ico via ImageMagick');
  } catch {
    try {
      // Try with sips + manual
      execSync(`sips -z 256 256 "${pngPath}" --out "${path.join(assetsDir, 'icon-256.png')}"`, { stdio: 'pipe' });
      console.log('Created icon-256.png (manual ICO conversion needed)');
      console.log('Install ImageMagick for ICO: brew install imagemagick');
    } catch {
      console.log('Could not create ICO. Install ImageMagick: brew install imagemagick');
    }
  }

  console.log('Icon generation complete!');
} catch (err) {
  console.error('Error generating icons:', err.message);
  process.exit(1);
}
