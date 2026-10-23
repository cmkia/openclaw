const string = (maxLength, minLength = 1) => ({ type: "string", minLength, maxLength });
const list = (items, maxItems, minItems = 1) => ({ type: "array", items, minItems, maxItems });
const object = (properties, required) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});

const citation = object({ source: string(180), locator: string(100), url: string(2048) }, [
  "source",
]);
const provenance = object(
  {
    kind: { enum: ["generated", "source", "licensed"] },
    description: string(600),
    source: string(600),
    model: string(120),
    creationId: string(200),
  },
  ["kind", "description"],
);
const image = object({ path: string(500), alt: string(240), provenance }, [
  "path",
  "alt",
  "provenance",
]);
const column = object({ title: string(65), bullets: list(string(170), 5) }, ["title", "bullets"]);
const table = object({ headers: list(string(65), 5, 2), rows: list(list(string(180), 5, 2), 7) }, [
  "headers",
  "rows",
]);
const chart = object(
  {
    type: { enum: ["bar", "line"] },
    categories: list(string(45), 12, 2),
    series: list(
      object(
        {
          name: string(55),
          values: list({ type: "number", minimum: -1e12, maximum: 1e12 }, 12, 2),
        },
        ["name", "values"],
      ),
      4,
    ),
    dataKind: { enum: ["source", "illustrative"] },
    source: string(400),
    xTitle: string(65),
    yTitle: string(65),
    unit: string(25),
  },
  ["type", "categories", "series", "dataKind", "source"],
);
const common = {
  title: string(110),
  subtitle: string(180),
  notes: string(12000, 0),
  citations: list(citation, 6, 0),
};
const layouts = {
  cover: { fields: { body: string(450), image }, required: [] },
  section: { fields: { body: string(450), image }, required: [] },
  bullets: { fields: { bullets: list(string(220), 6), image }, required: ["bullets"] },
  image: { fields: { image, body: string(650) }, required: ["image"] },
  comparison: { fields: { left: column, right: column }, required: ["left", "right"] },
  table: { fields: { table, body: string(240) }, required: ["table"] },
  chart: { fields: { chart, body: string(300) }, required: ["chart"] },
  conclusion: { fields: { body: string(550), image }, required: ["body"] },
};

export const manifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...object(
    {
      version: { const: 1 },
      title: string(160),
      author: string(120),
      slides: list(
        {
          oneOf: Object.entries(layouts).map(([layout, spec]) =>
            object(
              {
                layout: { const: layout },
                ...common,
                ...spec.fields,
              },
              ["layout", "title", ...spec.required],
            ),
          ),
        },
        50,
      ),
    },
    ["version", "title", "slides"],
  ),
};

// The exported schema is the validation owner; the small interpreter handles only its vocabulary.
function check(value, schema, at) {
  if (schema.oneOf) {
    const selected = schema.oneOf.find((entry) => entry.properties.layout.const === value?.layout);
    if (!selected)
      throw new Error(`${at}.layout must be one of ${Object.keys(layouts).join(", ")}`);
    return check(value, selected, at);
  }
  if ("const" in schema && value !== schema.const)
    throw new Error(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${at} must be one of ${schema.enum.join(", ")}`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${at} must be an object`);
    for (const key of schema.required)
      if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${at}.${key} is not supported`);
      check(item, schema.properties[key], `${at}.${key}`);
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
      throw new Error(`${at} must contain ${schema.minItems}–${schema.maxItems} items`);
    }
    value.forEach((item, index) => check(item, schema.items, `${at}[${index}]`));
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length > schema.maxLength ||
      value.trim().length < schema.minLength
    ) {
      throw new Error(`${at} must contain ${schema.minLength}–${schema.maxLength} characters`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
      throw new Error(`${at} contains unsupported control characters`);
  }
  if (
    schema.type === "number" &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < schema.minimum ||
      value > schema.maximum)
  ) {
    throw new Error(
      `${at} must be a finite number between ${schema.minimum} and ${schema.maximum}`,
    );
  }
}

export function validateManifest(value) {
  check(value, manifestSchema, "manifest");
  const manifest = structuredClone(value);
  for (const [index, slide] of manifest.slides.entries()) {
    const at = `manifest.slides[${index}]`;
    if (slide.table?.rows.some((row) => row.length !== slide.table.headers.length))
      throw new Error(`${at}.table rows must match headers`);
    if (
      slide.chart?.series.some((series) => series.values.length !== slide.chart.categories.length)
    )
      throw new Error(`${at}.chart values must match categories`);
    if (slide.image) {
      const name = slide.image.path;
      if (
        /^(?:[a-z][a-z0-9+.-]*:|[\\/])/iu.test(name) ||
        name.split(/[\\/]/u).some((part) => part === ".." || part === "")
      ) {
        throw new Error(`${at}.image.path must be a relative workspace file without traversal`);
      }
      if (slide.image.provenance.kind === "generated" && !slide.image.provenance.model)
        throw new Error(`${at}.image.provenance.model is required for generated images`);
    }
    for (const item of slide.citations ?? []) {
      if (item.url) {
        let url;
        try {
          url = new URL(item.url);
        } catch {
          throw new Error(`${at}.citations URL is invalid`);
        }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
          throw new Error(`${at}.citations URL must be HTTP(S) without credentials`);
      }
    }
    if (!["cover", "section", "conclusion"].includes(slide.layout) && !slide.citations?.length) {
      throw new Error(`${at}.citations requires at least one source for content slides`);
    }
  }
  return manifest;
}
