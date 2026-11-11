# SVG Tweak

A local-first SVG editor that brings manual fine-tuning and AI-assisted editing onto the same canvas.

Refine AI-generated SVGs, publication figures, and circuit diagrams: move a component, align objects, adjust colors or text, or ask AI for several variations and keep editing the one you like.

A single HTML file, with no installation or server required. Manual editing works offline; optional AI features use your own API endpoint and key.

The interface supports **English and Simplified Chinese**. Use the language menu in the top toolbar to switch without reloading. It follows your browser language on first use and remembers your choice in that browser.

![SVG Tweak editor with the shape library, canvas, and properties panel](docs/images/editor.png)

## Features

- **Manual editing:** selection, snapping, moving, resizing, rotation, alignment, distribution, grouping, and ungrouping, plus text editing, path-node editing, and image cropping.
- **Basic drawing:** lines, rectangles, circles, triangles, text, and imported images.
- **AI collaboration:** edit a selection or the whole diagram, attach reference images for style or drawing guidance, preview before applying, generate multiple candidates, and revisit versions from the chat.
- **Visual comparison:** side-by-side before/after previews with synchronized zoom and pan, independent of the editor canvas. Switch to a single view or compare different candidates.
- **Reusable shapes:** built-in NMOS, PMOS, VDD, GND, capacitors, junctions, and non-connecting wire crossovers. Save your own shapes and share libraries as JSON files.
- **Export:** save editable SVG files or use the browser's print dialog to export a PDF.

This is a graphics editor, not an electronic design or circuit simulation tool. It does not provide electrical rule checking, automatic routing, or simulation.

## Quick start

1. Click **Code → Download ZIP** on GitHub and extract the archive, or clone the repository.
2. Open `svg-tweak.html` in desktop Chrome or Edge.
3. Drag an SVG into the window or click **Open**. You can also try **Example** or place components from the shape library.
4. Select objects and edit them using the toolbar or the properties panel on the right.
5. Click **Save** or **Save as** to save an SVG. For a PDF, click **Export PDF** and choose the PDF option in your browser's print dialog.

**Only `svg-tweak.html` is required to run the editor.** The `tests/` directory is for development and does not need to be included when sharing the app.

If your browser cannot write directly to a local file, Save as falls back to a download. **The canvas is not autosaved. Save important changes before closing or refreshing the page.**

### Common controls

| Action | Control |
| --- | --- |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` |
| Pan the canvas | Hold Space and drag, or drag with the middle mouse button |
| Zoom the canvas | Use the zoom buttons or zoom readout in the toolbar |
| Place a library shape | Click its card, then click the canvas; press `Esc` to cancel |
| Navigate an AI preview | Scroll to zoom and drag to pan; both sides stay synchronized |

## AI collaboration

AI is optional. No API configuration is needed for manual editing. SVG Tweak does not provide a model subscription; any usage charges come from your chosen API provider.

### Connection settings

Open **AI collaboration** from the toolbar and enter your API URL, model name, and API key.

- The endpoint must support a Chat Completions-style API. You can enter a base URL ending in `/v1` or the full `/chat/completions` URL.
- Remote endpoints must use HTTPS; local endpoints may use HTTP.
- **Test connection** sends a short text request and may incur a small charge. It checks basic text access, not SVG editing or image understanding.
- Enable **Attach canvas screenshot** if you want the model to see the diagram. Leave it disabled for models that do not accept images.

You can also use an optional `ai-config.js` file next to the HTML:

- Enter your settings in the editor, click **Save configuration**, and save the file beside `svg-tweak.html`.
- Alternatively, copy `ai-config.example.js` to `ai-config.js`, fill in `baseURL`, `model`, and `apiKey`, then refresh the page.

Each field is resolved separately: **a non-empty value in the editor takes priority; an empty field falls back to the configuration file.** A previously remembered URL or model also takes priority. Clear the corresponding field to use the file's value instead.

Browsers without a supported file-save dialog download the configuration file instead. Move it beside the HTML and refresh. `ai-config.js` contains your key in plain text and is Git-ignored. **Do not commit it, share it with the app, or publish it on a website.**

### Edit and compare

1. Select the objects to edit, or switch the scope to **Whole diagram**.
2. Describe the change and click **Generate a version**. The editor shows the current stage and elapsed time while waiting.
3. Inspect the before/after preview, then choose which image to apply to the canvas. Viewing or switching candidates does not change the canvas.
4. Continue editing manually or send another request. Every request starts from **the current canvas at the time you send it**, including unsaved manual changes.

To try variations, leave the canvas unchanged, adjust your prompt, and generate again. Candidates remain attached to their AI messages so you can view, compare, or apply them later. The **Original image** entry lets you return to the diagram as it was when opened.

Applying a different image adds one undo step. Applying the image already on the canvas does not add an empty undo step. AI chats, candidates, and the original snapshot exist only in the current page session: **they are not included in exported SVGs and do not survive a page refresh.**

### Reference images

Click **Add references**, drop images into the AI input area, or paste a screenshot while the input area is focused. PNG, JPG, and WebP are supported, with up to four images per request. Click a thumbnail to view it, or its × button to remove it from future requests.

Describe what to borrow, for example: “Use reference 1's transistor drawing style and reference 2's colors, but keep the circuit layout and labels.” References do not become canvas objects. The current SVG remains the editing base, and AI still returns editable SVG changes for review.

- References stay attached until removed, so you can adjust your prompt and try several variations without adding them again. Each user message shows the references used for that request, even after you remove them from the input area.
- **Currently attached references are sent on every generation**, independently of **Attach canvas screenshot**. Older message thumbnails are records, not automatically re-sent images. The model and endpoint must support image input; **Test connection** checks text only. Image requests may cost more and take longer.
- Images are kept only in page memory and shared between message records, not copied into each candidate or written to disk. Files may be up to 20 MiB each; images larger than 2048 pixels on their longest side are resized. The chat has an approximate 16 MiB reference-image memory budget.
- Refreshing, opening another diagram, or starting a new chat clears the references along with the AI history. They are not included in exported SVGs.

## Shape library

Click **Shape library** in the toolbar to open the left panel, select a component, and click the canvas to place it. Built-in symbols include:

- **NMOS / PMOS:** simple three-terminal symbols, with a gate bubble for PMOS.
- **VDD / GND:** a T-shaped power terminal and a three-bar ground symbol.
- **Capacitor:** two parallel plates with vertical leads by default; rotate it for a horizontal layout.
- **Junction:** crossing lines with a solid connection dot.
- **Non-connecting crossover:** a horizontal wire arcs over a vertical wire, with a transparent gap rather than a white covering shape.

Placed symbols are ordinary SVG groups. Move, rotate, restyle, or ungroup them as needed; each placement takes one undo step. Symbols are graphical only: they do not automatically connect wires or establish electrical relationships.

### Save your own shapes

Select one or more objects, enter a name, and click **Save selection to library**. Multiple objects become one reusable shape without needing to be grouped first.

Custom shapes are saved in your current browser. Click a thumbnail to place an instance. Deleting a library entry does not remove shapes already on the canvas, and each placed instance can be edited independently.

### Back up and share

- **Export library** saves all custom shapes to a single `my-shapes.json` file.
- **Import library** merges shapes into your current library. Entries with identical names and SVG content are not added twice.
- Share the JSON file to share your shapes. Sending the HTML alone does not include the custom library stored in your browser.

The custom library is limited to 200 shapes and 4 MiB. Clearing browser data or changing browsers, computers, or the HTML file's location may make the stored library unavailable. Export important shapes as a backup.

Library files use SVG Tweak's own JSON format, not arbitrary third-party icon-library formats. To reuse shapes from another SVG, open it, select the shapes you need, and save them to your library.

## Data and privacy

Manual editing does not require uploading your diagram. Before using AI, make sure your chosen API service is appropriate for the content you send.

| Data | Storage or transmission |
| --- | --- |
| Current canvas | Held in page memory; save it manually as SVG. It is not restored after a refresh. |
| AI chats, candidates, original snapshot, and reference images | Held in the current document's page session; cleared on refresh, when another diagram is opened, or when a new chat is started. |
| Custom shape library | Stored in the current browser's local storage; exportable as JSON. |
| Interface language, API URL, model, and screenshot preference | Remembered in the current browser's local storage. |
| API key | Editor input stays in page memory. Saving the configuration writes it to a local plain-text file. It is not stored in browser local storage or exported SVGs. |

Generating a version sends the **entire current SVG**, object information, relevant conversation history, currently attached reference images, and an optional canvas screenshot directly to your configured API service. Editing only a selection does **not** mean only that selection is uploaded. SVG Tweak does not provide an intermediary server.

To share the app, send `svg-tweak.html` and let the recipient enter their own API settings. Include an exported shape-library JSON file if needed. Do not include your actual `ai-config.js`.

## Known limitations

- **AI editing is experimental.** Always review generated results. Diagram meaning and electrical connectivity are not guaranteed.
- **Your API must allow browser cross-origin requests (CORS).** When opening the HTML locally, the request's Origin is typically `null`. Some providers reject browser requests even with a correct URL and key.
- **This is not a full SVG authoring suite.** It focuses on fine-tuning common static SVGs. AI-generated content and library shapes cannot contain scripts, event handlers, or external resources. Check complex SVGs, including those using CSS transforms, carefully.
- **There is no persistent project history.** Exported SVGs contain the current canvas, not AI chats or candidates. Candidate history has a limit of 40 versions and an approximately 32 MiB text budget; clear history as needed before generating more.

## Development and tests

The interface, styles, and application logic all live in `svg-tweak.html`. `ai-config.example.js` is a configuration template with no credentials.

The `tests/` directory contains automated regression checks for contributors. These checks help catch broken editing, file handling, shape-library, and AI workflows after code changes. **They are not loaded by the editor and do not run automatically when you open it.**

Using the app does not require Node.js or the test files. Running the tests requires Node.js and Chrome or Chromium, with no npm dependencies to install:

```sh
node tests/run.cjs
```

Tests use isolated temporary browser profiles rather than your everyday browser session. They block the actual `ai-config.js` file and mock AI requests, so they do not call real model APIs.

If your browser is not found automatically, set `SVG_TWEAK_BROWSER` to its executable path. For example, in PowerShell:

```powershell
$env:SVG_TWEAK_BROWSER = 'D:\Apps\Chrome\chrome.exe'
node tests/run.cjs
```

The `main` branch contains the current full-featured version.

## Contributing

Bug reports and pull requests are welcome through [Issues](https://github.com/lanrepo/svg-tweak/issues) and [Pull requests](https://github.com/lanrepo/svg-tweak/pulls). Run `node tests/run.cjs` before submitting code changes, and do not commit API keys, your actual `ai-config.js`, or private files.

## License

Licensed under the [MIT License](LICENSE). You are welcome to use, modify, and share the project under its terms.
