# Slidecast

A separate PDF slide-reading website at `/reader/`. Gone remains at the website root.

Drop multiple PDFs, choose a device voice and reading speed, and press **Listen**. The queue can continue from one deck into the next. On iPhone or iPad, use **Choose files** to select multiple PDFs from Files.

**Progressive slide builds:** nearby slides with the same material are compared. Only new lines or clear additions are narrated; exact repeated slides are skipped. Genuine topic changes reset the comparison. Turn off **Skip repeated slide text** to read every slide in full, and inspect **Full extracted slide text** if the layout is complex. This is conservative text matching, not a guarantee of semantic understanding.

PDF files are parsed and rendered locally with PDF.js. They are not uploaded or retained after the tab is refreshed or closed. Device voices marked **online** may send narration text to their voice provider; downloaded local voices can read without that service. There is no paid AI voice account or backend. Natural voice availability depends on the browser and device. Keep the page open while listening: iOS may pause a locked or backgrounded website.

This version supports PDF files with selectable text. It shows image-only slides but does not perform OCR, interpret diagrams, or explain equations. Export PowerPoint decks as PDFs before adding them. The queue allows 20 files, 80 MB per file, and 200 MB in total.

From the repository root, run:

```sh
npm ci
npm run dev
```

The dev script prepares PDF.js browser assets under the ignored `reader/vendor/` directory. `npm run build` includes both apps and the PDF.js assets in `dist/`; production is plain static files on an HTTPS host. PDF.js is pinned in the lockfile, and its license is included with the copied assets.

```sh
npm run test:reader
SERVE_DIST=1 npm run test:reader:browser
```

The unit tests cover repeat detection and speech sequencing. Browser tests use real PDF fixtures, a real PDF.js worker, canvas rendering, multi-file drops, and iPhone-sized touch input. Speech-control tests inject a speech service to verify ordering and cancellation; they do not certify the sound of a device voice. The existing Gone service-worker boundary is tested so opening `/reader/` does not open the task app instead.
