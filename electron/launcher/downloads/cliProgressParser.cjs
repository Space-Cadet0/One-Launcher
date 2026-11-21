// @ts-check
'use strict';

const { sanitizeGameInstallSizeBytes } = require('../binaryAndManifestInspectors.cjs');
const { downloadQueueMap } = require('../engineStateRegistry.cjs');
const {
  computeSmoothedDownloadSpeed,
  updateDownloadTask,
} = require('./downloadQueueStore.cjs');

/**
 * Find the last match of a global RegExp across `text`.
 *
 * @param {string} text
 * @param {RegExp} globalRegex
 * @returns {RegExpMatchArray | null}
 */
function matchLast(text, globalRegex) {
  if (!text) return null;
  const matches = Array.from(String(text).matchAll(globalRegex));
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Convert a CLI-reported size value + unit (`B`, `KiB`, `MiB`, `GiB`, `KB`, `MB`, `GB`) to bytes.
 *
 * @param {any} valStr
 * @param {string} [unitStr='MiB']
 * @returns {number}
 */
function parseCliSizeToBytes(valStr, unitStr = 'MiB') {
  const num = parseFloat(valStr);
  if (!Number.isFinite(num) || num < 0) return 0;
  const u = String(unitStr || 'MiB').toUpperCase();
  if (u === 'B' || u === 'BYTES') return Math.round(num);
  if (u === 'KIB' || u === 'KB') return Math.round(num * 1024);
  if (u === 'GIB' || u === 'GB') return Math.round(num * 1024 * 1024 * 1024);
  if (u === 'TIB' || u === 'TB') return Math.round(num * 1024 * 1024 * 1024 * 1024);
  return Math.round(num * 1024 * 1024);
}

const MAX_LINE_BUFFER_CHARS = 65536;

/**
 * Line-buffered stream chunk processor that preserves incomplete lines across arbitrary
 * `stdout`/`stderr` TCP/pipe chunk boundaries (supporting `\r\n`, `\n`, and `\r` progress ticks).
 *
 * @param {(lines: string[]) => void} onCompleteLines
 * @returns {{ push: (chunk: any) => void, flush: () => void }}
 */
function createLineBufferedChunkProcessor(onCompleteLines) {
  let remainder = '';

  const push = (/** @type {any} */ chunk) => {
    if (chunk === null || chunk === undefined) return;
    const text = remainder + String(chunk);
    const parts = text.split(/\r\n|\n|\r/);
    remainder = parts.pop() || '';
    if (remainder.length > MAX_LINE_BUFFER_CHARS) {
      parts.push(remainder);
      remainder = '';
    }
    const nonEmpty = parts.filter((line) => line.length > 0);
    if (nonEmpty.length > 0) {
      onCompleteLines(nonEmpty);
    }
  };

  const flush = () => {
    if (remainder.length > 0) {
      const trailing = remainder;
      remainder = '';
      onCompleteLines([trailing]);
    }
  };

  return { push, flush };
}

/**
 * Create separate line-buffered `stdout` and `stderr` handlers for `legendary install`.
 *
 * @param {{
 *   taskId: string,
 *   epicPlatformFlag: string,
 *   options: any,
 * }} params
 */
function createLegendaryProgressParser({ taskId, epicPlatformFlag, options }) {
  let lastErrorLine = '';
  let sawAuthFailure = false;

  const processLines = (/** @type {string[]} */ lines) => {
    const joinedText = lines.join('\n');
    if (
      /login failed! cannot continue with download process|stored credentials are no longer valid|invalid_refresh_token|errors\.com\.epicgames\.account\.auth_token/i.test(
        joinedText
      )
    ) {
      sawAuthFailure = true;
    }

    for (const line of lines) {
      const errMatch = line.match(/(?:ERROR|CRITICAL):\s*(.+)/i);
      if (errMatch && errMatch[1]) {
        lastErrorLine = errMatch[1].trim();
      }
    }

    const currentTask = downloadQueueMap.get(taskId);
    if (!currentTask) return;

    const dlSizeMatch = matchLast(joinedText, /Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/gi);
    if (dlSizeMatch) {
      const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
      if (parsedTotal > 0) {
        currentTask.totalBytes = parsedTotal;
        currentTask.hasExactDownloadSize = true;
      }
    }

    const pctMatch = matchLast(joinedText, /Progress:\s*([\d.]+)%?/gi);
    const dlMiBMatch = matchLast(joinedText, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
    const speedMatch =
      matchLast(joinedText, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
      matchLast(joinedText, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
    const decompMatch = matchLast(
      joinedText,
      /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
    );
    const etaMatch = matchLast(joinedText, /ETA:\s*(\d+):(\d+):(\d+)/gi);

    if (pctMatch || dlMiBMatch || speedMatch || etaMatch) {
      /** @type {any} */
      const partialUpdate = {};
      if (pctMatch) {
        currentTask.hasExplicitCliProgress = true;
        partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
      } else {
        partialUpdate.progressPercent = currentTask.progressPercent;
      }
      if (dlMiBMatch) {
        currentTask.hasExplicitCliBytes = true;
        partialUpdate.bytesDownloaded = parseCliSizeToBytes(
          dlMiBMatch[1],
          dlMiBMatch[2] || 'MiB'
        );
      } else if (
        pctMatch &&
        !currentTask.hasExplicitCliBytes &&
        partialUpdate.bytesDownloaded === undefined
      ) {
        partialUpdate.bytesDownloaded = Math.round(
          (partialUpdate.progressPercent / 100) * currentTask.totalBytes
        );
      }
      const rawCliSpeed = speedMatch
        ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
        : 0;
      const decompCliSpeed = decompMatch
        ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
        : 0;
      if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
        const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded:
            partialUpdate.bytesDownloaded !== undefined
              ? partialUpdate.bytesDownloaded
              : currentTask.bytesDownloaded,
          rawSpeedBytesPerSec: rawCliSpeed,
          decompressedSpeedBytesPerSec: decompCliSpeed,
        });
        if (smoothedSpeed > 0 || speedMatch) {
          partialUpdate.speedBytesPerSec = smoothedSpeed;
        }
      }
      if (etaMatch) {
        const cliEta =
          parseInt(etaMatch[1], 10) * 3600 +
          parseInt(etaMatch[2], 10) * 60 +
          parseInt(etaMatch[3], 10);
        const activeSpeed =
          partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
        const activeBytes =
          partialUpdate.bytesDownloaded !== undefined
            ? partialUpdate.bytesDownloaded
            : currentTask.bytesDownloaded;
        if (
          currentTask.etaSeconds > 0 &&
          cliEta > currentTask.etaSeconds * 3 &&
          activeSpeed > 0 &&
          currentTask.totalBytes > activeBytes
        ) {
          partialUpdate.etaSeconds = Math.max(
            1,
            Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
          );
        } else {
          partialUpdate.etaSeconds = cliEta;
        }
      }
      const displayPct =
        partialUpdate.progressPercent !== undefined
          ? partialUpdate.progressPercent
          : currentTask.progressPercent;
      partialUpdate.statusMessage = `Installing ${
        epicPlatformFlag === 'Mac' ? 'macOS build' : 'Windows build'
      } via Legendary (${displayPct}%)...`;

      updateDownloadTask(taskId, partialUpdate, options);
    }
  };

  const stdoutProc = createLineBufferedChunkProcessor(processLines);
  const stderrProc = createLineBufferedChunkProcessor(processLines);

  return {
    onStdout: stdoutProc.push,
    onStderr: stderrProc.push,
    flush: () => {
      stdoutProc.flush();
      stderrProc.flush();
    },
    getState: () => ({
      lastErrorLine,
      sawAuthFailure,
    }),
  };
}

/**
 * Create separate line-buffered `stdout` and `stderr` handlers for `gogdl download`.
 *
 * @param {{
 *   taskId: string,
 *   options: any,
 * }} params
 */
function createGogdlProgressParser({ taskId, options }) {
  let lastErrorLine = '';
  let gogReportedDiskSizeBytes = 0;
  let bareSizeTupleCount = 0;
  let lastWrittenBytes = 0;

  const processLines = (/** @type {string[]} */ lines) => {
    const joinedText = lines.join('\n');
    const currentTask = downloadQueueMap.get(taskId);
    let resolvedSizeOnChunk = false;

    for (const line of lines) {
      const errMatch = line.match(
        /(?:ERROR|CRITICAL|Exception|[A-Za-z]+Error|Failed to execute script)[\]:\s]+(.+)/i
      );
      if (errMatch && errMatch[1]) {
        lastErrorLine = errMatch[1].trim();
      }

      const sizeTupleMatch = line.match(/\([\d.]+,\s*['"][A-Z]+['"]\)\s*(\d+)/);
      if (sizeTupleMatch && currentTask) {
        const parsedBytes = Number(sizeTupleMatch[1]);
        if (parsedBytes > 0) {
          const isExplicitDisk = /Disk size:/i.test(line) && !/Download size:/i.test(line);
          const isExplicitDownload = /Download size:/i.test(line);
          if (!isExplicitDisk && !isExplicitDownload) {
            bareSizeTupleCount += 1;
          }
          if (isExplicitDisk || (!isExplicitDownload && bareSizeTupleCount >= 2)) {
            const validDisk = sanitizeGameInstallSizeBytes(parsedBytes);
            if (validDisk) {
              gogReportedDiskSizeBytes = validDisk;
              currentTask.diskSizeBytes = validDisk;
            }
            if (
              !currentTask.hasExactDownloadSize &&
              (!currentTask.totalBytes || currentTask.totalBytes <= 0)
            ) {
              currentTask.totalBytes = parsedBytes;
              resolvedSizeOnChunk = true;
            }
          } else {
            currentTask.totalBytes = parsedBytes;
            currentTask.hasExactDownloadSize = true;
            resolvedSizeOnChunk = true;
          }
        }
      }

      const diskSizeMatch = line.match(
        /Disk size:\s*([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)/i
      );
      if (diskSizeMatch && currentTask && !sizeTupleMatch) {
        const parsedDisk = sanitizeGameInstallSizeBytes(
          parseCliSizeToBytes(diskSizeMatch[1], diskSizeMatch[2])
        );
        if (parsedDisk) {
          gogReportedDiskSizeBytes = parsedDisk;
          currentTask.diskSizeBytes = parsedDisk;
          if (
            !currentTask.hasExactDownloadSize &&
            (!currentTask.totalBytes || currentTask.totalBytes <= 0)
          ) {
            currentTask.totalBytes = parsedDisk;
            resolvedSizeOnChunk = true;
          }
        }
      }

      const dlSizeMatch = line.match(/Download size:\s*([\d.]+)\s*(KiB|MiB|GiB)/i);
      if (dlSizeMatch && currentTask && !sizeTupleMatch) {
        const parsedTotal = parseCliSizeToBytes(dlSizeMatch[1], dlSizeMatch[2]);
        if (parsedTotal > 0) {
          currentTask.totalBytes = parsedTotal;
          currentTask.hasExactDownloadSize = true;
          resolvedSizeOnChunk = true;
        }
      }

      const progressBytesMatch = line.match(/Progress:\s*[\d.]+\s+(\d+)\/(\d+)/i);
      if (progressBytesMatch && currentTask && Number(progressBytesMatch[2]) > 0) {
        const reportedDenominator = Number(progressBytesMatch[2]);
        const reportedNumerator = Number(progressBytesMatch[1]) || 0;
        if (currentTask.hasExactDownloadSize && currentTask.totalBytes > 0) {
          const validDisk = sanitizeGameInstallSizeBytes(reportedDenominator);
          if (validDisk && validDisk > currentTask.totalBytes) {
            gogReportedDiskSizeBytes = Math.max(gogReportedDiskSizeBytes, validDisk);
            currentTask.diskSizeBytes = Math.max(
              Number(currentTask.diskSizeBytes || 0),
              validDisk
            );
          }
          const ratio = Math.min(1, Math.max(0, reportedNumerator / reportedDenominator));
          const dlBytesVal = Math.min(
            currentTask.totalBytes,
            Math.max(
              currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
              Math.round(ratio * currentTask.totalBytes)
            )
          );
          currentTask.downloadedBytes = dlBytesVal;
          currentTask.bytesDownloaded = dlBytesVal;
        } else {
          currentTask.totalBytes = reportedDenominator;
          const dlBytesVal = Math.max(
            currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
            reportedNumerator
          );
          currentTask.downloadedBytes = dlBytesVal;
          currentTask.bytesDownloaded = dlBytesVal;
        }
        resolvedSizeOnChunk = true;
      }
    }

    if (!currentTask) return;

    if (
      currentTask.progressPercent === 0 &&
      (/\[V2\]\s*INFO:\s*Deleted:/i.test(joinedText) ||
        /Getting Dependencies repository/i.test(joinedText))
    ) {
      updateDownloadTask(
        taskId,
        {
          statusMessage: 'Allocating files & starting GOG download...',
        },
        options
      );
    }

    const pctMatch = matchLast(joinedText, /Progress:\s*([\d.]+)%?/gi);
    const dlMiBMatch = matchLast(joinedText, /Downloaded:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
    const writtenMatch = matchLast(joinedText, /Written:\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
    if (writtenMatch) {
      const parsedWritten = parseCliSizeToBytes(writtenMatch[1], writtenMatch[2] || 'MiB');
      if (parsedWritten > lastWrittenBytes) {
        lastWrittenBytes = parsedWritten;
      }
    }
    const speedMatch =
      matchLast(joinedText, /\+\s*Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s/gi) ||
      matchLast(joinedText, /Download\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)?/gi);
    const decompMatch = matchLast(
      joinedText,
      /\/\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s\s*\(decompressed\)/gi
    );
    const diskWriteMatch = matchLast(
      joinedText,
      /\+\s*Disk\s*-\s*([\d.]+)\s*(KiB|MiB|GiB|B)\/s(?:\s*\(write\))?/gi
    );
    const etaMatch = matchLast(joinedText, /ETA:\s*(\d+):(\d+):(\d+)/gi);

    if (pctMatch || dlMiBMatch || speedMatch || etaMatch || diskWriteMatch) {
      /** @type {any} */
      const partialUpdate = {};
      if (resolvedSizeOnChunk && currentTask.totalBytes > 0) {
        partialUpdate.totalBytes = currentTask.totalBytes;
      }
      if (pctMatch) {
        currentTask.hasExplicitCliProgress = true;
        partialUpdate.progressPercent = Math.min(99, Math.round(parseFloat(pctMatch[1])));
      } else {
        partialUpdate.progressPercent = currentTask.progressPercent;
      }
      if (dlMiBMatch) {
        currentTask.hasExplicitCliBytes = true;
        const parsedDlBytes = parseCliSizeToBytes(dlMiBMatch[1], dlMiBMatch[2] || 'MiB');
        partialUpdate.bytesDownloaded =
          currentTask.hasExactDownloadSize && currentTask.totalBytes > 0
            ? Math.min(currentTask.totalBytes, parsedDlBytes)
            : parsedDlBytes;
      } else if (
        pctMatch &&
        !currentTask.hasExplicitCliBytes &&
        partialUpdate.bytesDownloaded === undefined
      ) {
        partialUpdate.bytesDownloaded = Math.round(
          (partialUpdate.progressPercent / 100) * currentTask.totalBytes
        );
      }
      const rawCliSpeed = speedMatch
        ? parseCliSizeToBytes(speedMatch[1], speedMatch[2] || 'MiB')
        : 0;
      const decompCliSpeed = decompMatch
        ? parseCliSizeToBytes(decompMatch[1], decompMatch[2] || 'MiB')
        : 0;
      const diskWriteSpeed = diskWriteMatch
        ? parseCliSizeToBytes(diskWriteMatch[1], diskWriteMatch[2] || 'MiB')
        : 0;
      if (speedMatch || partialUpdate.bytesDownloaded !== undefined) {
        const smoothedSpeed = computeSmoothedDownloadSpeed(taskId, {
          bytesDownloaded:
            partialUpdate.bytesDownloaded !== undefined
              ? partialUpdate.bytesDownloaded
              : currentTask.bytesDownloaded,
          rawSpeedBytesPerSec: rawCliSpeed,
          decompressedSpeedBytesPerSec: decompCliSpeed,
        });
        if (smoothedSpeed > 0 || speedMatch) {
          partialUpdate.speedBytesPerSec = smoothedSpeed;
        }
      }
      if (etaMatch) {
        const cliEta =
          parseInt(etaMatch[1], 10) * 3600 +
          parseInt(etaMatch[2], 10) * 60 +
          parseInt(etaMatch[3], 10);
        const activeSpeed =
          partialUpdate.speedBytesPerSec || currentTask.speedBytesPerSec || 0;
        const activeBytes =
          partialUpdate.bytesDownloaded !== undefined
            ? partialUpdate.bytesDownloaded
            : currentTask.bytesDownloaded;
        if (
          currentTask.etaSeconds > 0 &&
          cliEta > currentTask.etaSeconds * 3 &&
          activeSpeed > 0 &&
          currentTask.totalBytes > activeBytes
        ) {
          partialUpdate.etaSeconds = Math.max(
            1,
            Math.round((currentTask.totalBytes - activeBytes) / activeSpeed)
          );
        } else {
          partialUpdate.etaSeconds = cliEta;
        }
      }

      const knownDiskTotal =
        gogReportedDiskSizeBytes || Number(currentTask.diskSizeBytes || 0) || 0;
      const activeDlBytes =
        partialUpdate.bytesDownloaded !== undefined
          ? partialUpdate.bytesDownloaded
          : Number(currentTask.bytesDownloaded || currentTask.downloadedBytes || 0);
      const isTailDiskWritePhase =
        currentTask.totalBytes > 0 &&
        activeDlBytes >= currentTask.totalBytes * 0.99 &&
        knownDiskTotal > 0 &&
        lastWrittenBytes < knownDiskTotal &&
        diskWriteSpeed > 0;

      const displayPct =
        partialUpdate.progressPercent !== undefined
          ? partialUpdate.progressPercent
          : currentTask.progressPercent;
      if (isTailDiskWritePhase) {
        partialUpdate.status = 'extracting';
        partialUpdate.speedBytesPerSec = diskWriteSpeed;
        partialUpdate.etaSeconds = Math.max(
          1,
          Math.round((knownDiskTotal - lastWrittenBytes) / diskWriteSpeed)
        );
        partialUpdate.statusMessage = `Installing game files to disk (${displayPct}%)...`;
      } else {
        partialUpdate.statusMessage = `Downloading via gogdl (${displayPct}%)...`;
      }
      updateDownloadTask(taskId, partialUpdate, options);
    } else if (resolvedSizeOnChunk && currentTask.totalBytes > 0) {
      updateDownloadTask(
        taskId,
        {
          totalBytes: currentTask.totalBytes,
          downloadedBytes: currentTask.downloadedBytes || currentTask.bytesDownloaded || 0,
          bytesDownloaded: currentTask.bytesDownloaded || currentTask.downloadedBytes || 0,
        },
        options
      );
    }
  };

  const stdoutProc = createLineBufferedChunkProcessor(processLines);
  const stderrProc = createLineBufferedChunkProcessor(processLines);

  return {
    onStdout: stdoutProc.push,
    onStderr: stderrProc.push,
    flush: () => {
      stdoutProc.flush();
      stderrProc.flush();
    },
    getState: () => ({
      lastErrorLine,
      gogReportedDiskSizeBytes,
      lastWrittenBytes,
    }),
  };
}

module.exports = {
  matchLast,
  parseCliSizeToBytes,
  createLineBufferedChunkProcessor,
  createLegendaryProgressParser,
  createGogdlProgressParser,
};
