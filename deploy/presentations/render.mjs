import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import PptxGenJS from "pptxgenjs";
import sharp from "sharp";
import { validateManifest } from "./manifest.mjs";

const run = promisify(execFile);
const W = 13.333333,
  H = 7.5;
export const theme = Object.freeze({
  id: "erika-dark-v1",
  fonts: Object.freeze({ heading: "Inter", body: "Inter", mono: "JetBrains Mono" }),
  colors: Object.freeze({
    background: "08090A",
    panel: "0F1011",
    line: "23252A",
    text: "FFFFFF",
    body: "D0D6E0",
    muted: "8A8F98",
    blue: "2F81F7",
    cyan: "02B8CC",
    violet: "6366F1",
  }),
});
const C = theme.colors;
const FONT = "Inter",
  MONO = "JetBrains Mono";
const layoutLabels = {
  bullets: "IDEIAS-CHAVE",
  image: "ILUSTRAÇÃO",
  comparison: "COMPARAÇÃO",
  table: "VISÃO COMPARATIVA",
  chart: "DADOS",
};
const timeout = 180000;
const escaped = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const isInside = (root, target) => {
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};

async function readImage(image, workspace) {
  const target = await fs.realpath(path.resolve(workspace, image.path));
  if (!isInside(workspace, target))
    throw new Error("Image resolves outside this presentation workspace");
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (
      process.platform === "linux" &&
      !isInside(workspace, await fs.realpath(`/proc/self/fd/${handle.fd}`))
    )
      throw new Error("Image descriptor resolves outside this presentation workspace");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new Error("Images must be regular files of at most 20 MiB");
    // Validate and read through one descriptor so replacement cannot redirect the subsequent read.
    const buffer = await handle.readFile();
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (!png && !jpeg) throw new Error("Images must have PNG or JPEG binary signatures");
    const meta = await sharp(buffer, { limitInputPixels: 40000000 }).metadata();
    if (
      !["png", "jpeg"].includes(meta.format) ||
      !meta.width ||
      !meta.height ||
      (meta.pages ?? 1) !== 1
    )
      throw new Error("Images must be single-frame PNG or JPEG");
    return {
      buffer,
      meta,
      data: `image/${meta.format === "jpeg" ? "jpeg" : "png"};base64,${buffer.toString("base64")}`,
    };
  } finally {
    await handle.close();
  }
}

function bounds(box, at) {
  if (
    ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
    box.w <= 0 ||
    box.h <= 0 ||
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.w > W + 0.001 ||
    box.y + box.h > H + 0.001
  ) {
    throw new Error(`${at} falls outside the slide`);
  }
}

async function assertTextFits(text, box, size, bold, font, at) {
  bounds(box, at);
  if (!text.trim()) return;
  const measured = await sharp({
    text: {
      text: escaped(text),
      font: `${font}${bold ? " Bold" : ""} ${size}`,
      width: Math.floor(box.w * 96),
      dpi: 96,
      rgba: true,
      wrap: "word-char",
    },
  }).metadata();
  // Leave slack for PowerPoint's different line metrics; never shrink or discard text.
  if ((measured.height ?? Infinity) * 1.15 > box.h * 96)
    throw new Error(`${at} overflows at ${size}pt; shorten the text or split the slide`);
}

export async function renderPresentation({ manifest: input, workspace, outputDir }) {
  const manifest = validateManifest(input);
  const root = await fs.realpath(workspace);
  const out = await fs.realpath(outputDir);
  if (!isInside(root, out))
    throw new Error("Output directory must be inside the presentation workspace");
  for (const family of [FONT, MONO]) {
    const { stdout } = await run("fc-match", ["-f", "%{family}", family], { timeout: 10000 });
    if (!stdout.toLowerCase().includes(family.toLowerCase()))
      throw new Error(`Install the ${family} font before rendering`);
  }
  const imageCache = new Map();
  let imageBytes = 0;
  for (const spec of manifest.slides) {
    if (spec.image && !imageCache.has(spec.image.path)) {
      const image = await readImage(spec.image, root);
      imageBytes += image.buffer.length;
      if (imageBytes > 100 * 1024 * 1024) throw new Error("Presentation images exceed 100 MiB");
      imageCache.set(spec.image.path, image);
    }
  }
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = manifest.author ?? "Erika";
  deck.subject = "Educational presentation with source references";
  deck.title = manifest.title;
  deck.company = "CMKIA";
  deck.lang = "pt-BR";
  deck.theme = { headFontFace: FONT, bodyFontFace: FONT, lang: "pt-BR" };
  const geometry = [];
  const counts = {
    slides: manifest.slides.length,
    charts: 0,
    tables: 0,
    images: 0,
    notes: manifest.slides.length,
  };
  const record = (number, type, box) => {
    bounds(box, `${type} on slide${number}`);
    geometry.push({ slide: number, type, ...box });
  };
  for (const [index, spec] of manifest.slides.entries()) {
    const number = index + 1;
    const slide = deck.addSlide();
    slide.background = { color: C.background };
    const shape = (box, color) => {
      record(number, "shape", box);
      slide.addShape(deck.ShapeType.rect, {
        ...box,
        fill: { color },
        line: { color, transparency: 100 },
      });
    };
    const text = async (content, box, size = 24, options = {}) => {
      const { color = C.body, bold = false, mono = false, ...rest } = options;
      await assertTextFits(content, box, size, bold, mono ? MONO : FONT, `Text on slide${number}`);
      record(number, "text", box);
      slide.addText(content, {
        ...box,
        fontFace: mono ? MONO : FONT,
        fontSize: size,
        color,
        bold,
        margin: 0,
        breakLine: false,
        valign: "top",
        isTextBox: true,
        ...rest,
      });
    };
    const image = (box) => {
      const cached = imageCache.get(spec.image.path);
      record(number, "image", box);
      // Keep source figures and their labels intact; only generated illustrations may fill by cropping.
      const sizingType = spec.image.provenance.kind === "generated" ? "cover" : "contain";
      slide.addImage({
        data: cached.data,
        x: box.x,
        y: box.y,
        w: cached.meta.width / 96,
        h: cached.meta.height / 96,
        sizing: { type: sizingType, w: box.w, h: box.h },
        altText: spec.image.alt,
      });
      counts.images++;
    };
    const bullets = async (items, box, size = 24) => {
      const heights = [];
      for (const item of items) {
        const meta = await sharp({
          text: {
            text: escaped(item),
            font: `${FONT} ${size}`,
            width: Math.floor((box.w - 0.3) * 96),
            dpi: 96,
            rgba: true,
            wrap: "word-char",
          },
        }).metadata();
        heights.push(((meta.height ?? Infinity) * 1.18) / 96 + 0.18);
      }
      if (heights.reduce((a, b) => a + b, 0) > box.h)
        throw new Error(`Bullets overflow on slide${number}; split the slide`);
      let y = box.y;
      for (const [i, item] of items.entries()) {
        const itemBox = { x: box.x, y, w: box.w, h: heights[i] };
        await text(item, itemBox, size, {
          bullet: { indent: size * 0.8 },
          hanging: size * 0.2,
          paraSpaceAfterPt: 0,
        });
        y += heights[i];
      }
    };
    const fullHero = ["cover", "section", "conclusion"].includes(spec.layout);
    if (fullHero) {
      if (spec.image) image({ x: 7.5, y: 0, w: W - 7.5, h: 6.95 });
      const width = spec.image ? 6.3 : 11.9;
      await text(
        spec.layout === "section" ? "MÓDULO" : (manifest.author ?? "RADIOBIOLOGIA"),
        { x: 0.7, y: 0.8, w: width, h: 0.35 },
        14,
        { color: C.blue, mono: true },
      );
      await text(spec.title, { x: 0.7, y: 1.65, w: width, h: 2.15 }, 40, {
        color: C.text,
        bold: true,
      });
      if (spec.subtitle) await text(spec.subtitle, { x: 0.7, y: 4.0, w: width, h: 0.8 }, 23);
      if (spec.body)
        await text(
          spec.body,
          { x: 0.7, y: spec.subtitle ? 5.0 : 4.15, w: width, h: spec.subtitle ? 1.25 : 2.1 },
          24,
        );
    } else {
      await text(layoutLabels[spec.layout], { x: 0.7, y: 0.35, w: 11.9, h: 0.3 }, 14, {
        mono: true,
        color: C.blue,
      });
      await text(spec.title, { x: 0.7, y: 0.85, w: 11.9, h: 1.05 }, 32, {
        bold: true,
        color: C.text,
      });
      if (spec.subtitle)
        await text(spec.subtitle, { x: 0.7, y: 1.95, w: 11.9, h: 0.5 }, 20, { color: C.muted });
      const y = spec.subtitle ? 2.65 : 2.2;
      const contentHeight = 6.55 - y;
      if (spec.layout === "bullets") {
        const width = spec.image ? 6.0 : 11.9;
        if (spec.image) image({ x: 7.2, y, w: 5.4, h: contentHeight });
        await bullets(spec.bullets, { x: 0.7, y, w: width, h: contentHeight });
      } else if (spec.layout === "image") {
        image({ x: spec.body ? 6.8 : 0.7, y, w: spec.body ? 5.8 : 11.9, h: contentHeight });
        if (spec.body) await text(spec.body, { x: 0.7, y, w: 5.5, h: contentHeight }, 24);
      } else if (spec.layout === "comparison") {
        for (const [i, col] of [spec.left, spec.right].entries()) {
          const x = i === 0 ? 0.7 : 6.9;
          await text(col.title, { x, y, w: 5.7, h: 0.7 }, 25, {
            color: i === 0 ? C.blue : C.violet,
            bold: true,
          });
          await bullets(col.bullets, { x, y: y + 0.9, w: 5.7, h: contentHeight - 0.9 }, 22);
        }
      } else if (spec.layout === "table") {
        const rows = [spec.table.headers, ...spec.table.rows];
        const height = contentHeight - (spec.body ? 0.9 : 0);
        const rowHeight = height / rows.length;
        const cellWidth = 11.9 / spec.table.headers.length;
        for (const row of rows)
          for (const value of row)
            await assertTextFits(
              value,
              { x: 0, y: 0, w: cellWidth - 0.2, h: rowHeight - 0.12 },
              18,
              false,
              FONT,
              `Table on slide${number}`,
            );
        const box = { x: 0.7, y, w: 11.9, h: height };
        record(number, "table", box);
        slide.addTable(
          rows.map((row, i) =>
            row.map((value) => ({
              text: value,
              options: {
                bold: i === 0,
                color: i === 0 ? C.text : C.body,
                fill: i === 0 ? C.panel : C.background,
              },
            })),
          ),
          {
            ...box,
            rowH: rowHeight,
            colW: cellWidth,
            fontFace: FONT,
            fontSize: 18,
            color: C.body,
            margin: 0.08,
            border: { type: "solid", pt: 0.5, color: C.line },
            autoPage: false,
            valign: "middle",
          },
        );
        counts.tables++;
        if (spec.body) await text(spec.body, { x: 0.7, y: y + height + 0.18, w: 11.9, h: 0.7 }, 20);
      } else if (spec.layout === "chart") {
        const chart = spec.chart;
        const box = { x: 0.7, y, w: 11.9, h: contentHeight - (spec.body ? 0.8 : 0) };
        for (const category of chart.categories)
          await assertTextFits(
            category,
            { x: 0, y: 0, w: (box.w * 0.8) / chart.categories.length, h: 0.55 },
            16,
            false,
            FONT,
            `Chart category on slide${number}`,
          );
        for (const series of chart.series)
          await assertTextFits(
            series.name,
            { x: 0, y: 0, w: box.w / chart.series.length, h: 0.4 },
            16,
            false,
            FONT,
            `Chart legend on slide${number}`,
          );
        record(number, "chart", box);
        slide.addChart(
          chart.type === "bar" ? deck.ChartType.bar : deck.ChartType.line,
          chart.series.map((series) => ({
            name: series.name,
            labels: chart.categories,
            values: series.values,
          })),
          {
            ...box,
            chartColors: [C.blue, C.violet, C.cyan, "E4F222"],
            chartArea: { fill: { color: C.background }, border: { transparency: 100 } },
            plotArea: { fill: { color: C.background }, border: { transparency: 100 } },
            showLegend: chart.series.length > 1,
            legendColor: C.body,
            legendFontFace: FONT,
            legendFontSize: 16,
            catAxisLabelColor: C.body,
            catAxisLabelFontFace: FONT,
            catAxisLabelFontSize: 16,
            valAxisLabelColor: C.muted,
            valAxisLabelFontFace: FONT,
            valAxisLabelFontSize: 16,
            valGridLine: { color: C.line, size: 0.5 },
            catGridLine: { style: "none" },
            showValue: chart.type === "bar",
            showTitle: false,
            showCatName: false,
            dataLabelColor: C.text,
            dataLabelFormatCode: "0.##",
            dataLabelPosition: "outEnd",
            showCatAxisTitle: Boolean(chart.xTitle),
            showValAxisTitle: Boolean(chart.yTitle || chart.unit),
            catAxisTitle: chart.xTitle,
            catAxisTitleFontFace: FONT,
            catAxisTitleFontSize: 16,
            catAxisTitleColor: C.body,
            valAxisTitle:
              chart.yTitle && chart.unit
                ? `${chart.yTitle} (${chart.unit})`
                : (chart.yTitle ?? chart.unit),
            valAxisTitleFontFace: FONT,
            valAxisTitleFontSize: 16,
            valAxisTitleColor: C.body,
            barDir: "col",
            showBorder: false,
            showMarker: chart.type === "line",
            lineSize: 2,
          },
        );
        counts.charts++;
        if (spec.body) await text(spec.body, { x: 0.7, y: 5.95, w: 11.9, h: 0.55 }, 20);
      }
    }
    const sourceLabel = spec.citations?.length
      ? `Fontes: ${spec.citations.map((_, i) => `[${i + 1}]`).join(" ")} · Referências completas nas notas.`
      : "";
    if (sourceLabel)
      await text(sourceLabel, { x: 0.7, y: 6.76, w: 11.9, h: 0.35 }, 11, { color: C.muted });
    await text(String(number).padStart(2, "0"), { x: 11.9, y: 7.13, w: 0.7, h: 0.2 }, 10, {
      mono: true,
      color: C.muted,
      align: "right",
    });
    const notes = [
      spec.notes ?? "",
      "SOURCES",
      ...(spec.citations ?? []).map(
        (citation, i) =>
          `[${i + 1}] ${citation.source}${citation.locator ? ` | ${citation.locator}` : ""}${citation.url ? ` | ${citation.url}` : ""}`,
      ),
    ];
    if (spec.chart)
      notes.push(
        `CHART DATA: ${spec.chart.dataKind}. Source: ${spec.chart.source}. Values stored as an editable snapshot, not clinical verification.`,
      );
    if (spec.image)
      notes.push(
        `IMAGE: ${spec.image.alt}`,
        `PROVENANCE: ${JSON.stringify(spec.image.provenance)}`,
        ...(spec.image.provenance.kind === "generated"
          ? ["AI-generated conceptual illustration; not a clinical image or experimental finding."]
          : []),
      );
    slide.addNotes(notes.join("\n"));
  }
  const pptx = path.join(out, "presentation.pptx");
  const pdf = path.join(out, "presentation.pdf");
  const validation = path.join(out, "validation.json");
  const geometryPath = path.join(out, "geometry.json");
  await fs.writeFile(
    geometryPath,
    JSON.stringify({ slideWidth: W, slideHeight: H, objects: geometry }),
  );
  await deck.writeFile({ fileName: pptx });
  const validatorPath = fileURLToPath(new URL("./validate.py", import.meta.url));
  const checked = await run(
    "python3",
    [validatorPath, pptx, "--geometry", geometryPath, "--expected-slides", String(counts.slides)],
    { timeout, maxBuffer: 4 * 1024 * 1024 },
  );
  const report = JSON.parse(checked.stdout);
  await fs.writeFile(validation, JSON.stringify(report, null, 2));
  if (report.status !== "pass") throw new Error("PPTX package validation failed");
  // Each job has an independent LibreOffice profile; shared profiles serialize or hang concurrent jobs.
  const profile = path.join(out, ".libreoffice");
  try {
    await run(
      "soffice",
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        out,
        pptx,
      ],
      { timeout, maxBuffer: 2 * 1024 * 1024 },
    );
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
  const pdfStat = await fs.stat(pdf);
  if (pdfStat.size === 0) throw new Error("PDF conversion produced no content");
  await run("pdftoppm", ["-png", "-r", "96", pdf, path.join(out, "slide")], {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
  const pngs = (await fs.readdir(out))
    .filter((name) => /^slide-\d+\.png$/u.test(name))
    .sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]))
    .map((name) => path.join(out, name));
  if (pngs.length !== counts.slides)
    throw new Error("Rendered PNG count does not match slide count");
  return { pptx, pdf, pngs, validation, counts };
}
