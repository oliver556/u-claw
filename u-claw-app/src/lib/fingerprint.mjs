// Cross-platform device fingerprint for U-Claw / Xiapan Cloud apiKey binding.
// Output: { source: 'usb' | 'disk' | 'mac' | 'linux' | 'seed' | 'test', fingerprint: '<64-hex>' }
//
// Order of preference:
//   Windows: USB drive (when running from a USB volume) -> system disk -> seed file
//   Mac:     Hardware UUID + boot volume UUID            -> seed file
//   Linux:   /etc/machine-id + lsblk SERIAL of root      -> seed file
//
// Adapted from v2/u-clawx-openclaw-dev/electron/utils/{license,disk-fingerprint}.ts
// but simplified: no Ed25519 signing, no .license file, just a stable hash.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const POWERSHELL_CANDIDATES = [
  'powershell.exe',
  'powershell',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe',
  'pwsh.exe',
];

const TEST_FINGERPRINT_SOURCE = 'TEST:UCLAW_DEVELOPMENT_FIXED_FINGERPRINT';

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function shouldUseTestFingerprint() {
  return (
    process.env.UCLAW_SKIP_FINGERPRINT === '1'
    || process.env.OPENCLAW_SKIP_USB_CHECK === '1'
    || process.env.CLAWX_SKIP_USB_CHECK === '1'
  );
}

function readEnvOverride() {
  const override = (process.env.UCLAW_FINGERPRINT_OVERRIDE || '').trim();
  if (!override || !/^[0-9a-f]{64}$/i.test(override)) return null;
  return { source: 'test', fingerprint: override.toLowerCase() };
}

function getSeedPath(appRoot) {
  if (process.env.UCLAW_SEED_PATH) {
    return resolve(process.env.UCLAW_SEED_PATH);
  }
  const home = homedir();
  if (home) return resolve(home, '.uclaw', '.usb_seed');
  return resolve(appRoot, '.usb_seed');
}

function readOrCreateSeedFingerprint(appRoot) {
  const seedPath = getSeedPath(appRoot);
  let seedHex;
  if (existsSync(seedPath)) {
    seedHex = readFileSync(seedPath, 'utf8').trim();
  }
  if (!seedHex || !/^[0-9a-f]{64}$/i.test(seedHex)) {
    seedHex = randomBytes(32).toString('hex');
    mkdirSync(dirname(seedPath), { recursive: true });
    writeFileSync(seedPath, seedHex + '\n', 'utf8');
  }
  return { source: 'seed', fingerprint: seedHex.toLowerCase() };
}

async function runPowerShell(script) {
  const wrapped = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  let lastError = null;
  for (const candidate of POWERSHELL_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(candidate, ['-NoProfile', '-Command', wrapped], {
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      lastError = err;
    }
  }
  throw lastError || new Error('PowerShell is not available on this system.');
}

function normalizeSerial(value) {
  if (!value) return '';
  return String(value).trim().replace(/[\s.]+$/g, '').replace(/\s+/g, '').toUpperCase();
}

function getDriveDepth(targetDir) {
  const parsed = parse(resolve(targetDir));
  if (!parsed.root) return null;
  const rel = relative(parsed.root, resolve(targetDir));
  const depth = rel.split(sep).map((s) => s.trim()).filter(Boolean).length;
  return { driveRoot: parsed.root.replace(/[\\/]$/, '').toUpperCase(), depth };
}

async function tryWindowsUsbFingerprint(appRoot) {
  const drive = getDriveDepth(appRoot);
  if (!drive) return null;
  // Only attempt USB fingerprint when running from a drive root or first-level subfolder
  if (drive.depth > 2) return null;
  const driveLetter = drive.driveRoot.endsWith(':') ? drive.driveRoot : `${drive.driveRoot}:`;

  const driveMappingScript = [
    `$p = Get-WmiObject -Query "ASSOCIATORS OF {Win32_LogicalDisk.DeviceID='${driveLetter}'} WHERE AssocClass=Win32_LogicalDiskToPartition"`,
    '$p0 = if ($p -is [System.Array]) { $p[0] } else { $p }',
    '$d = if ($p0) { Get-WmiObject -Query "ASSOCIATORS OF {Win32_DiskPartition.DeviceID=\'$($p0.DeviceID)\'} WHERE AssocClass=Win32_DiskDriveToDiskPartition" } else { $null }',
    '$d0 = if ($d -is [System.Array]) { $d[0] } else { $d }',
    "if ($d0) { $d0.PNPDeviceID } else { '' }",
  ].join('; ');

  let targetPnpId = '';
  try {
    targetPnpId = (await runPowerShell(driveMappingScript)).trim().toUpperCase();
  } catch {
    targetPnpId = '';
  }

  let rawDiskJson;
  try {
    rawDiskJson = await runPowerShell(
      'Get-WmiObject Win32_DiskDrive | Select-Object Model, SerialNumber, PNPDeviceID | ConvertTo-Json -Compress',
    );
  } catch {
    return null;
  }

  let disks;
  try {
    const parsed = JSON.parse(rawDiskJson.trim() || '[]');
    disks = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return null;
  }
  if (!disks.length) return null;

  const exactMatch = targetPnpId
    ? disks.find((d) => (d.PNPDeviceID || '').toUpperCase() === targetPnpId)
    : null;

  const usbDisk = exactMatch || disks.find((d) => {
    const pnp = (d.PNPDeviceID || '').toUpperCase();
    return pnp.includes('USB') || pnp.includes('USBSTOR');
  });

  if (!usbDisk) return null;

  const model = (usbDisk.Model || 'Unknown').trim();
  const serial = (usbDisk.SerialNumber || 'Unknown').trim();
  const pnp = (usbDisk.PNPDeviceID || 'Unknown').trim();
  return {
    source: 'usb',
    fingerprint: sha256Hex(`${model}:${serial}:${pnp}`),
  };
}

async function tryWindowsDiskFingerprint() {
  let physicalDiskInfo = null;
  try {
    const physicalScript = [
      "$systemDrive = ($env:SystemDrive -replace ':','')",
      "if (-not $systemDrive) { $systemDrive = 'C' }",
      '$disk = Get-Partition -DriveLetter $systemDrive -ErrorAction SilentlyContinue | Get-Disk -ErrorAction SilentlyContinue | Select-Object -First 1',
      'if (-not $disk) { return }',
      '$pd = Get-PhysicalDisk -DeviceNumber $disk.Number -ErrorAction SilentlyContinue | Select-Object -First 1',
      'if (-not $pd) { return }',
      '[pscustomobject]@{ Serial = $pd.SerialNumber; Model = $pd.FriendlyName; BusType = $pd.BusType } | ConvertTo-Json -Compress',
    ].join('; ');
    const raw = (await runPowerShell(physicalScript)).trim();
    if (raw) physicalDiskInfo = JSON.parse(raw);
  } catch {
    physicalDiskInfo = null;
  }

  if (!physicalDiskInfo) {
    try {
      const win32Script = [
        "$systemDrive = $env:SystemDrive -replace ':',''",
        "if (-not $systemDrive) { $systemDrive = 'C' }",
        '$letter = "$systemDrive`:"',
        "$lp = Get-WmiObject -Query \"ASSOCIATORS OF {Win32_LogicalDisk.DeviceID='$letter'} WHERE AssocClass=Win32_LogicalDiskToPartition\"",
        '$lp0 = if ($lp -is [System.Array]) { $lp[0] } else { $lp }',
        'if (-not $lp0) { return }',
        "$dd = Get-WmiObject -Query \"ASSOCIATORS OF {Win32_DiskPartition.DeviceID='$($lp0.DeviceID)'} WHERE AssocClass=Win32_DiskDriveToDiskPartition\"",
        '$dd0 = if ($dd -is [System.Array]) { $dd[0] } else { $dd }',
        'if (-not $dd0) { return }',
        '[pscustomobject]@{ Serial = $dd0.SerialNumber; Model = $dd0.Model; BusType = $dd0.InterfaceType } | ConvertTo-Json -Compress',
      ].join('; ');
      const raw = (await runPowerShell(win32Script)).trim();
      if (raw) physicalDiskInfo = JSON.parse(raw);
    } catch {
      physicalDiskInfo = null;
    }
  }
  if (!physicalDiskInfo) return null;

  let boardSerial = 'NoBoard';
  try {
    const raw = await runPowerShell('(Get-CimInstance Win32_BaseBoard | Select-Object -First 1).SerialNumber');
    boardSerial = normalizeSerial(raw) || 'NoBoard';
  } catch {
    // keep default
  }

  const diskSerial = normalizeSerial(physicalDiskInfo.Serial);
  const diskModel = (physicalDiskInfo.Model || 'Unknown').toString().trim();
  return {
    source: 'disk',
    fingerprint: sha256Hex(`DISK:${diskSerial}:${diskModel}:${boardSerial}`),
  };
}

async function tryMacFingerprint() {
  let hardwareUuid = '';
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPHardwareDataType'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const match = stdout.match(/Hardware UUID:\s*([0-9A-F-]+)/i);
    if (match) hardwareUuid = match[1].trim().toUpperCase();
  } catch {
    hardwareUuid = '';
  }

  let bootVolumeUuid = '';
  try {
    const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', '/'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const match = stdout.match(/Volume UUID:\s*([0-9A-F-]+)/i);
    if (match) bootVolumeUuid = match[1].trim().toUpperCase();
  } catch {
    bootVolumeUuid = '';
  }

  if (!hardwareUuid && !bootVolumeUuid) return null;
  return {
    source: 'mac',
    fingerprint: sha256Hex(`MAC:${hardwareUuid}:${bootVolumeUuid}`),
  };
}

async function tryLinuxFingerprint() {
  let machineId = '';
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machineId = readFileSync(path, 'utf8').trim();
      if (machineId) break;
    } catch {
      // try next
    }
  }

  let rootSerial = '';
  try {
    const { stdout } = await execFileAsync('/bin/lsblk', ['-no', 'SERIAL,MOUNTPOINT'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === '/') {
        rootSerial = parts[0];
        break;
      }
    }
  } catch {
    rootSerial = '';
  }

  if (!machineId && !rootSerial) return null;
  return {
    source: 'linux',
    fingerprint: sha256Hex(`LINUX:${machineId}:${rootSerial}`),
  };
}

let cachedPromise = null;

export async function getFingerprint(appRoot) {
  if (cachedPromise) return cachedPromise;
  cachedPromise = computeFingerprint(appRoot || process.cwd()).catch((err) => {
    cachedPromise = null;
    throw err;
  });
  return cachedPromise;
}

async function computeFingerprint(appRoot) {
  const override = readEnvOverride();
  if (override) return override;

  if (shouldUseTestFingerprint()) {
    return { source: 'test', fingerprint: sha256Hex(TEST_FINGERPRINT_SOURCE) };
  }

  const plat = platform();

  if (plat === 'win32') {
    const usb = await tryWindowsUsbFingerprint(appRoot).catch(() => null);
    if (usb) return usb;
    const disk = await tryWindowsDiskFingerprint().catch(() => null);
    if (disk) return disk;
    return readOrCreateSeedFingerprint(appRoot);
  }

  if (plat === 'darwin') {
    const mac = await tryMacFingerprint().catch(() => null);
    if (mac) return mac;
    return readOrCreateSeedFingerprint(appRoot);
  }

  if (plat === 'linux') {
    const linux = await tryLinuxFingerprint().catch(() => null);
    if (linux) return linux;
    return readOrCreateSeedFingerprint(appRoot);
  }

  return readOrCreateSeedFingerprint(appRoot);
}

// CLI entrypoint: prints JSON when run directly.
//   node fingerprint.mjs        -> {"source":"...","fingerprint":"..."}
//   node fingerprint.mjs apiKey -> sk-<fingerprint>
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const appRoot = process.env.UCLAW_APP_ROOT || process.cwd();
  getFingerprint(appRoot)
    .then((result) => {
      const arg = process.argv[2];
      if (arg === 'apiKey') {
        process.stdout.write(`sk-${result.fingerprint}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    })
    .catch((err) => {
      process.stderr.write(`fingerprint error: ${err && err.message ? err.message : err}\n`);
      process.exit(1);
    });
}
