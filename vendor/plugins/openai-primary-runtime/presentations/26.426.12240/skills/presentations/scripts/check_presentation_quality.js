#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEBUG_BORDER_COLORS = new Set([
  "00b0f0",
  "00bfff",
  "00ffff",
  "33ccff",
  "5ee7ff",
  "63e7ff",
  "66e7ff",
  "b6edff",
]);
const PLACEHOLDER_PATTERN = /\b(Slide Number|Click to add|Lorem ipsum|Replace with|TODO|TBD)\b/i;

function usage() {
  return `Usage: check_presentation_quality.js --workspace <dir> [--pptx <file>] [--report <file>]

Checks the saved PPTX package without opening desktop presentation apps.
Reports are always written under the workspace scratch directory unless --report is provided inside scratch.`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional argument: ${arg}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    i += 1;
    if (arg === "--workspace") args.workspace = value;
    else if (arg === "--pptx") args.pptx = value;
    else if (arg === "--report") args.report = value;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!args.workspace) throw new Error(usage());
  return args;
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding,
    maxBuffer: options.maxBuffer || 80 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
    throw new Error((stderr || stdout || `${command} ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function zipNames(pptxPath) {
  return String(runCapture("unzip", ["-Z1", pptxPath], { encoding: "utf8" }))
    .split(/\r?\n/)
    .filter(Boolean);
}

function zipListing(pptxPath) {
  const lines = String(runCapture("unzip", ["-l", pptxPath], { encoding: "utf8" })).split(/\r?\n/);
  const sizes = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/);
    if (match) sizes.set(match[2], Number.parseInt(match[1], 10));
  }
  return sizes;
}

function readZipText(pptxPath, entryName) {
  return Buffer.from(runCapture("unzip", ["-p", pptxPath, entryName])).toString("utf8");
}

function readZipBuffer(pptxPath, entryName) {
  return Buffer.from(runCapture("unzip", ["-p", pptxPath, entryName]));
}

function slideNumber(entryName) {
  const match = entryName.match(/slide(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function assertReportUnderScratch(reportPath, scratchDir) {
  const relative = path.relative(scratchDir, reportPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Quality report must be written under scratch/: ${reportPath}`);
  }
}

function inspectPptx(pptxPath) {
  const names = zipNames(pptxPath);
  const sizes = zipListing(pptxPath);
  const slideXmlNames = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const mediaNames = names.filter((name) => name.startsWith("ppt/media/"));
  const chartNames = names.filter((name) => /^ppt\/(?:.*\/)?charts\/chart\d+\.xml$/.test(name)).sort();

  const result = {
    slide_count: slideXmlNames.length,
    media_count: mediaNames.length,
    chart_count: chartNames.length,
    zero_byte_media: [],
    invalid_png_media: [],
    placeholder_text: [],
    debug_line_colors: [],
    slide_numbers: [],
    warnings: [],
    failures: [],
  };

  if (!slideXmlNames.length) result.failures.push("PPTX contains no slide XML parts.");

  for (const mediaName of mediaNames) {
    const size = sizes.get(mediaName) || 0;
    if (size === 0) {
      result.zero_byte_media.push(mediaName);
      continue;
    }
    if (mediaName.toLowerCase().endsWith(".png")) {
      const header = readZipBuffer(pptxPath, mediaName).subarray(0, 8);
      if (!header.equals(PNG_MAGIC)) result.invalid_png_media.push(mediaName);
    }
  }

  for (const [index, slideName] of slideXmlNames.entries()) {
    const slideNo = index + 1;
    const xml = readZipText(pptxPath, slideName);
    if (PLACEHOLDER_PATTERN.test(xml)) {
      result.placeholder_text.push({ slide: slideNo, pattern: PLACEHOLDER_PATTERN.source });
    }
    if (/\btype="sldNum"|\bplaceholderType: "sldNum"|Slide Number/i.test(xml)) {
      result.slide_numbers.push(slideNo);
    }
    for (const lineMatch of xml.matchAll(/<a:ln\b[\s\S]*?<\/a:ln>/g)) {
      for (const colorMatch of lineMatch[0].matchAll(/<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/g)) {
        const normalized = colorMatch[1].toLowerCase();
        if (DEBUG_BORDER_COLORS.has(normalized)) {
          result.debug_line_colors.push({ slide: slideNo, color: normalized });
        }
      }
    }
  }

  if (result.zero_byte_media.length) {
    result.failures.push(`PPTX contains zero-byte media parts: ${result.zero_byte_media.slice(0, 12).join(", ")}`);
  }
  if (result.invalid_png_media.length) {
    result.failures.push(`PPTX contains invalid PNG media parts: ${result.invalid_png_media.slice(0, 12).join(", ")}`);
  }
  if (result.placeholder_text.length) {
    result.failures.push(`PPTX contains visible placeholder/debug text candidates on ${result.placeholder_text.length} slide(s).`);
  }
  if (result.slide_numbers.length) {
    result.failures.push(`PPTX contains slide-number placeholders on slide(s): ${result.slide_numbers.join(", ")}`);
  }
  if (result.debug_line_colors.length) {
    result.warnings.push(`PPTX contains debug-colored lines on ${result.debug_line_colors.length} slide(s).`);
  }

  return result;
}

function checkOutputHygiene(outputDir, finalPptx) {
  const result = { output_dir: outputDir, unexpected_files: [] };
  if (!fs.existsSync(outputDir)) {
    result.unexpected_files.push("output directory is missing");
    return result;
  }
  const finalName = path.basename(finalPptx);
  for (const name of fs.readdirSync(outputDir)) {
    if (name !== finalName) result.unexpected_files.push(name);
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceDir = path.resolve(args.workspace);
  const scratchDir = path.join(workspaceDir, "scratch");
  const outputDir = path.join(workspaceDir, "output");
  const pptxPath = path.resolve(args.pptx || path.join(outputDir, "output.pptx"));
  const reportPath = path.resolve(args.report || path.join(scratchDir, "quality-report.json"));

  fs.mkdirSync(scratchDir, { recursive: true });
  assertReportUnderScratch(reportPath, scratchDir);

  const report = {
    workspace: workspaceDir,
    pptx: pptxPath,
    checks: {},
    failures: [],
    warnings: [],
  };

  if (!fs.existsSync(pptxPath)) {
    report.failures.push(`Missing PPTX: ${pptxPath}`);
  } else if (!fs.statSync(pptxPath).size) {
    report.failures.push(`PPTX is empty: ${pptxPath}`);
  } else {
    try {
      report.checks.pptx_package = inspectPptx(pptxPath);
      report.failures.push(...report.checks.pptx_package.failures);
      report.warnings.push(...report.checks.pptx_package.warnings);
    } catch (error) {
      report.failures.push(`PPTX package inspection failed: ${error && error.message ? error.message : String(error)}`);
    }
  }

  report.checks.output_hygiene = checkOutputHygiene(outputDir, pptxPath);
  if (report.checks.output_hygiene.unexpected_files.length) {
    report.failures.push(`output/ contains non-deliverable files: ${report.checks.output_hygiene.unexpected_files.join(", ")}`);
  }

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(reportPath);
  if (report.failures.length) {
    console.error(report.failures.join("\n"));
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
}
