# Playwright Trace Recorder (Standalone)

A Chrome extension that records browser interactions as Playwright traces. Saved locally, no backend needed.

## Features

- Local Storage: Traces saved locally - no server required
- Playwright Format: Standard Playwright trace format
- Trace Viewer: In-browser replay with integrated viewer
- Side Panel: Access controls through browser side panel

## Installation

1. Clone this repository
2. Open Chrome and navigate to chrome://extensions/
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the cloned directory

## Usage

1. Open side panel (click extension icon)
2. Click "Start Recording"
3. Perform actions on any webpage
4. Click "Stop Recording" to end session
5. Click "Download" to save trace file

## Structure

extension/
├── src/              Extension source files
├── icons/            Extension icons
└── manifest.json     Extension configuration

## License

Apache-2.0
