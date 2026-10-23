# Presentation manifest v1

The authoritative executable schema is `deploy/presentations/manifest.mjs` in the operator repository. This reference describes that contract; the service advertises the invocation fields through its MCP tool schemas. Do not add arbitrary coordinates, font overrides, remote image URLs, or unsupported properties.

Top level: `version: 1`, `title`, optional `author`, and `slides` (1–50). Each slide has `layout` and `title`. Common optional fields are `subtitle`, `notes`, and `citations`. Content fields are layout-specific; extra fields are rejected:

- `cover` and `section`: optional `body` and `image`.
- `bullets`: required `bullets`, optional `image`.
- `image`: required `image`, optional `body`.
- `comparison`: required `left` and `right`.
- `table`: required `table`, optional `body`.
- `chart`: required `chart`, optional `body`.
- `conclusion`: required `body`, optional `image`; use short paragraphs, not a `bullets` property.

Content slides other than cover, section, and conclusion require at least one citation.

- `layout`: `cover`, `section`, `bullets`, `image`, `comparison`, `table`, `chart`, or `conclusion`.
- `bullets`: an array of short strings, at most six. `left` and `right`: `{ "title": "...", "bullets": ["..."] }`.
- `table`: `{ "headers": ["..."], "rows": [["..."]] }`. Every row must match the header count.
- `chart`: `{ "type": "bar" | "line", "categories": ["..."], "series": [{ "name": "...", "values": [1, 2] }], "dataKind": "source" | "illustrative", "source": "...", "xTitle": "...", "yTitle": "...", "unit": "..." }`. Axis titles and unit are optional. Each series needs one finite number per category.
- `image`: `{ "path": "presentations/task/images/figure.png", "alt": "...", "provenance": { "kind": "generated" | "source" | "licensed", "description": "...", "source": "...", "model": "...", "creationId": "..." } }`. `source`, `model`, and `creationId` are optional schema fields; include all that apply. `path` is workspace-relative PNG/JPEG, resolved within the tenant's workspace; symlink escapes and remote fetches are rejected.
- `notes`: a string with the fuller explanation and source/limitation mapping. `citations`: an array of `{ "source": "...", "locator": "...", "url": "..." }`; locator and URL are optional. Include only verified locators and actual source URLs.

## Tool sequence

Save a JSON manifest using the workspace file-writing tool. Then call:

```json
{
  "manifestPath": "presentations/example/deck.json",
  "outputDirectory": "presentations/example/revision-01"
}
```

with `presentations__presentations_render`. It returns the actual paths for `pptx`, `pdf`, `pngs`, `validation`, and `counts`. Inspect the report and every PNG. Then call `presentations__presentations_check` with:

```json
{ "presentationPath": "presentations/example/revision-01/presentation.pptx" }
```

Use the actual returned PPTX path, not an assumed filename. An output folder must be a fresh revision so older deliverables are preserved. Schema/text-fit failures require a corrected manifest. Do not silently drop content, shrink type, or turn the slide into a screenshot.

The included `pilot-manifest.json` exercises all eight layouts with clearly synthetic renderer data and citations to supplied roteiro items. Its image is an existing flattened design reference used only to verify embedding. It does not validate a new Magnific generation, medical content, or clinical numbers. A production deck must replace that test image with a purposeful source or generated illustration.
