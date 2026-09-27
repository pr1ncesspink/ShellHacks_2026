import { parseProjectPage, type ProjectDraft } from "./project-data";

export async function readProjectPdf(file: File, progress: (message: string) => void) {
  if (!/\.pdf$/i.test(file.name) || file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error("Choose a nonempty PDF no larger than 20 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("This file does not have a valid PDF header.");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const loading = pdfjs.getDocument({ data: bytes, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/" });
  let totalCharacters = 0;
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 100) throw new Error("This PDF has more than 100 pages. Split it into smaller files.");
    const rows: ProjectDraft[] = [];
    const excerpts: { page: number; text: string }[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      progress(`Reading ${file.name}: page ${pageNumber} of ${pdf.numPages}`);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "", lastY: number | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > 3) text += "\n";
        text += item.str + (item.hasEOL ? "\n" : " ");
        lastY = y;
      }
      totalCharacters += text.length;
      if (totalCharacters > 2_000_000) throw new Error("This PDF has too much text. Split it into smaller files.");
      rows.push(...parseProjectPage(text, file.name, pageNumber));
      if (rows.length > 500) throw new Error("Limit each import to 500 project records.");
      excerpts.push({ page: pageNumber, text: text.slice(0, 15000) });
      page.cleanup();
    }
    return { rows, excerpts, hasText: totalCharacters > 20 };
  } finally {
    await loading.destroy();
  }
}
