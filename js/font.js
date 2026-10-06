/*
 * KittenNote
 * Copyright (C) 2026 Author of KittenNote
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * KittenNote - PDF text font loader
 *
 * Loads the bundled OFL subset of Noto Sans SC exactly once and parses it
 * for the PDF writer. The font is fetched lazily (and cached by the service
 * worker at runtime), never precached with the app shell.
 */

import { TrueTypeFont } from './truetype.js';

export const PDF_FONT_URL = './assets/fonts/NotoSansSC-Regular-subset.ttf';
export const PDF_FONT_NAME = 'NotoSansSC-Subset';

let cached = null;
let pending = null;

/**
 * @returns {Promise<{ font: TrueTypeFont, bytes: Uint8Array }>}
 */
export async function loadPdfFont() {
    if (cached) return cached;
    if (pending) return pending;

    pending = (async () => {
        const response = await fetch(PDF_FONT_URL);
        if (!response.ok) {
            throw new Error(`字体加载失败 (HTTP ${response.status})`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const font = TrueTypeFont.parse(bytes);
        cached = { font, bytes };
        return cached;
    })();

    try {
        return await pending;
    } finally {
        pending = null;
    }
}

export function pdfFontLoaded() {
    return cached !== null;
}
